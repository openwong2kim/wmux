// The headless task delivery driven for real: the pane port (headlessSessions)
// starts a stub `claude` in a real PTY; the task is typed in through the real
// paste-and-Enter (deliverScheduledPrompt, with the session's own input fence
// and PTY write, as index.ts wires it); the stub reads the bracketed paste and
// the Enter like an agent would and writes its turn to a transcript in Claude
// Code's shape; the reply is read back from that file. Only the task ledger
// and the remote RPCs are stood in for.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DaemonSessionManager } from '../../DaemonSessionManager';
import { folderTrustRefusal } from '../../folderTrustState';
import { deliverScheduledPrompt, deliveryInputFence } from '../../sessionPromptDelivery';
import { buildWebPaneEnv } from '../../web/webPaneEnv';
import type { A2aRemoteTaskMarkerV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import type { Task } from '../../../shared/types';
import { deliberateSleep, waitFor } from '../../../test-utils/waitFor';
import { HeadlessDelivery } from '../headlessDelivery';
import { createHeadlessSessions } from '../headlessSessions';
import type { HeadlessStartRecordV1 } from '../headlessStartStore';

const posix = process.platform !== 'win32' && fs.existsSync('/bin/sh');
const WAIT_MS = 20_000;
const PROMPT = 'Reply with PONG and the output of uname -s\nthen stop';

describe.skipIf(!posix)('the headless task delivery, for real', () => {
  const saved: Record<string, string | undefined> = {};
  const managers: DaemonSessionManager[] = [];
  let root: string;
  let home: string;
  let transcripts: string;
  let stub: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hl-deliver-')));
    home = path.join(root, 'home');
    transcripts = path.join(root, 'transcripts');
    for (const dir of [path.join(home, '.local', 'bin'), transcripts, path.join(root, 'wt')]) fs.mkdirSync(dir, { recursive: true });
    stub = path.join(home, '.local', 'bin', 'claude');
    // A stand-in agent: raw input; a bracketed paste then Enter is one prompt,
    // recorded as Claude Code does (a user entry, then an end_turn reply).
    fs.writeFileSync(stub, [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      "const id = process.argv[process.argv.indexOf('--session-id') + 1];",
      `const file = ${JSON.stringify(transcripts)} + '/' + id + '.jsonl';`,
      "process.stdin.setRawMode(true);",
      // STUB_DIALOG=start: a permission dialog on screen for a while; =enter: one opens the moment a paste ends.
      "const dialog = () => process.stdout.write('\\x1b[2J\\x1b[HBash command\\n\\n  uname -s\\n\\nDo you want to proceed?\\n\\u276f 1. Yes\\n  2. No\\n');",
      "const idle = () => process.stdout.write('\\x1b[2J\\x1b[Hready> ');",
      "if (process.env.STUB_DIALOG === 'start') { dialog(); setTimeout(() => { idle(); fs.writeFileSync(file + '.cleared', ''); }, 2500); } else idle();",
      "fs.writeFileSync(file + '.ready', '');",
      "let buf = '';",
      "process.stdin.on('data', (d) => {",
      "  buf += d.toString('utf8');",
      "  if (process.env.STUB_DIALOG === 'enter' && buf.includes('\\x1b[201~') && !buf.includes('\\r')) dialog();",
      "  const m = /\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~\\r/.exec(buf);",
      "  if (!m) return;",
      "  buf = buf.slice(m.index + m[0].length);",
      "  const at = () => new Date().toISOString();",
      "  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'u' + Date.now(), timestamp: at(), message: { role: 'user', content: m[1] } }) + '\\n');",
      "  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'a' + Date.now(), timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text: 'PONG\\n```\\n' + require('os').type() + '\\n```' }], stop_reason: 'end_turn' } }) + '\\n');",
      "});",
      '',
    ].join('\n'), { mode: 0o755 });
    for (const key of ['HOME', 'PATH', 'WMUX_TERMINAL_CORE']) saved[key] = process.env[key];
    process.env.HOME = home;
    process.env.PATH = '/usr/bin:/bin';
    process.env.WMUX_TERMINAL_CORE = 'node';
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.disposeAll();
  });

  /** A stub agent in a real session, and the delivery wired to it as index.ts wires the real one. */
  async function harness(stubDialog?: 'start' | 'enter') {
    const mgr = new DaemonSessionManager();
    managers.push(mgr);
    const sessions = createHeadlessSessions({
      paneEnv: (id, workspaceId) => buildWebPaneEnv({ id, parentEnv: process.env, workspaceId }),
      createSession: async (params, local) => {
        const p = params as { id: string; cwd: string; env: Record<string, string>; exec: { command: string } };
        return mgr.createSessionAsync({ id: p.id, cwd: p.cwd, env: p.env, exec: p.exec, cols: 80, rows: 24, ...local });
      },
      destroySession: async ({ id }) => {
        mgr.destroySession(id);
        return { ok: true };
      },
      meta: (id) => mgr.getSession(id)?.meta,
      agentPath: async () => `${path.dirname(stub)}:/usr/bin:/bin`,
    });
    const uuid = crypto.randomUUID();
    const sessionId = `hl-${uuid}`;
    const workspaceId = `hl-${crypto.randomUUID()}`;
    await sessions.create({
      sessionId, workspaceId, cwd: path.join(root, 'wt'), agentBin: stub,
      command: `claude --session-id ${uuid} --permission-mode acceptEdits`, env: stubDialog ? { STUB_DIALOG: stubDialog } : {},
    });
    const file = path.join(transcripts, `${uuid}.jsonl`);
    // The stub is up (raw input on) when it leaves its marker.
    await waitFor(() => fs.existsSync(`${file}.ready`), WAIT_MS, 'the stub agent');

    const rec: HeadlessStartRecordV1 = {
      v: 1, hostId: '22222222-2222-4222-8222-222222222222', spawnId: 'sp-0123abcd-4567-89ab-cdef-0123456789ab', agent: 'claude', repoPath: '/repo',
      sessionId, workspaceId, agentSessionId: uuid, lineage: 'remote-spawn:x', runId: 'run-1', phase: 'started', startedAt: new Date().toISOString(),
    };
    const marker: A2aRemoteTaskMarkerV1 = { v: 1, linkId: '11111111-1111-4111-8111-111111111111', hostId: rec.hostId, messageId: 'first_11111111-1111-4111-8111-111111111111', direction: 'inbound', delivered: false };
    const task = {
      kind: 'task', id: `rt-${'7'.padStart(32, '0')}`,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      history: [{ kind: 'message', messageId: 'first_11111111-1111-4111-8111-111111111111', role: 'user', parts: [{ kind: 'text', text: PROMPT }] }],
      artifacts: [],
      metadata: { title: 't', from: { workspaceId: 'remote:11111111-1111-4111-8111-111111111111', name: 'a' }, to: { workspaceId, name: 'b', paneId: sessionId }, createdAt: '', updatedAt: '', remote: marker },
    } as unknown as Task;
    const m = (): A2aRemoteTaskState => task.metadata.remote as A2aRemoteTaskState;
    const replies: string[] = [];
    const moves: Array<{ to: string; summary?: string }> = [];
    const results: string[] = [];
    const marks: Array<Record<string, unknown>> = [];
    const verdicts: Array<string | null> = [];

    const delivery = new HeadlessDelivery({
      mode: { active: () => true },
      starts: { list: () => [rec] },
      runId: 'run-1',
      tasks: {
        pending: () => (m().delivered !== true && !m().held && task.status.state === 'submitted' ? [task] : []),
        remote: () => [task],
        get: () => task,
      },
      mark: async (input) => {
        marks.push(input);
        if (input.delivered) m().delivered = true;
        if (input.attempted !== undefined) m().attempted = input.attempted;
        return { ok: true };
      },
      // As index.ts: the session's screen read for a dialog (the same check), its agent state and
      // input fence, its PTY write noted as input.
      deliver: async (id, agent, prompt, authorized, onWrite) => {
        const managed = mgr.getSession(id)!;
        // As index.ts: no incarnation yet reads as not ready.
        const incarnationId = managed.meta.incarnationId;
        if (!incarnationId) return 'unavailable';
        const result = await deliverScheduledPrompt(agent, incarnationId, prompt, {
          authorized: async () => authorized(),
          onWrite: () => onWrite(),
          folderTrustBlocks: async () => {
            const verdict = await folderTrustRefusal(mgr, id, 'headless-delivery', { refuseUnknown: true, refuseDialog: true, log: () => undefined });
            verdicts.push(verdict);
            return verdict;
          },
          getAgentState: () => ({ slug: 'claude', incarnationId, status: 'idle', ...deliveryInputFence(managed.bridge) }),
          isAgentProcessAlive: async () => true,
          write: (data) => {
            managed.ptyProcess.write(data);
            managed.bridge.noteInput(data);
            return true;
          },
        });
        results.push(result);
        return result;
      },
      transcriptPath: () => file,
      transcriptSize: (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0),
      reply: async ({ text }) => {
        replies.push(text);
        return { ok: true };
      },
      transition: async ({ to, summary }) => {
        moves.push({ to, ...(summary ? { summary } : {}) });
        task.status = { state: to, timestamp: new Date().toISOString() };
        return { ok: true };
      },
      log: () => undefined,
    });
    /** Passes until `done` (or the time is up). */
    const run = async (done: () => boolean): Promise<void> => {
      const end = Date.now() + WAIT_MS;
      while (!done() && Date.now() < end) {
        await delivery.tick();
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const prompts = (): unknown[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [])
      .map((l) => JSON.parse(l) as { type: string; message: { content: unknown } })
      .filter((l) => l.type === 'user')
      .map((l) => l.message.content);
    return { delivery, file, replies, moves, results, marks, verdicts, run, prompts };
  }

  it('a task typed into a real session reaches the agent once, and its answer comes back as the reply', async () => {
    const h = await harness();
    await h.run(() => h.replies.length > 0);
    expect(h.replies).toEqual([`PONG\n\`\`\`\n${os.type()}\n\`\`\`\n`.trimEnd()]);
    expect(h.moves).toEqual([{ to: 'working' }, { to: 'input-required' }]);
    // What the agent was given is the task, as typed (a multi-line paste, one prompt).
    expect(h.prompts()).toEqual([PROMPT]);
    await h.delivery.tick();
    expect(h.prompts()).toHaveLength(1);
  }, 60_000);

  it('a permission dialog on screen: nothing is typed (busy), and the task goes in once it is gone', async () => {
    const h = await harness('start');
    await h.run(() => h.results.length > 0);
    expect(h.results[0]).toBe('busy');
    // Busy because of the dialog the screen shows (the screen itself could be read).
    expect(h.verdicts[0]).toBe('dialog');
    expect(h.prompts()).toEqual([]);
    expect(h.marks.slice(0, 2)).toEqual([{ taskId: expect.any(String), attempted: true }, { taskId: expect.any(String), attempted: false }]);
    await h.run(() => h.replies.length > 0);
    expect(fs.existsSync(`${h.file}.cleared`)).toBe(true);
    expect(h.results.at(-1)).toBe('sent');
    expect(h.prompts()).toEqual([PROMPT]);
    expect(h.moves).toEqual([{ to: 'working' }, { to: 'input-required' }]);
  }, 60_000);

  it('a dialog that opens between the paste and Enter: no Enter, the task ends with the reason, never typed again', async () => {
    const h = await harness('enter');
    await h.run(() => h.moves.length > 0);
    expect(h.results).toEqual(['error']);
    // Clear before the paste, the dialog after it.
    expect(h.verdicts[0]).toBeNull();
    expect(h.verdicts).toContain('dialog');
    // The attempt stays recorded; the task was never taken, so it is canceled with the reason.
    expect(h.marks).toEqual([{ taskId: expect.any(String), attempted: true }]);
    expect(h.moves).toEqual([{ to: 'canceled', summary: 'the task may have reached the agent only in part' }]);
    await deliberateSleep(500, 'a negative check: an Enter would have reached the stub by now');
    await h.delivery.tick();
    // The agent never got an Enter: no prompt recorded, and nothing typed again.
    expect(h.prompts()).toEqual([]);
    expect(h.results).toEqual(['error']);
  }, 60_000);
});
