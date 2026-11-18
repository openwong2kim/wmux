// Permission prompts in a linked pane, allowed or denied by the PC that sent the
// task (remoteApproval.ts), through the real approval registry and Claude Code
// 2.1.293 Bash dialogs (approvals/__tests__/fixtures/terminal-prompts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2aApprovalExposure, A2aRemoteStatusV1 } from '../../../shared/a2aRemote';
import { remoteWorkspaceId } from '../../../shared/a2aRemoteDelivery';
import { promptHash } from '../../../shared/promptHash';
import type { GatedSubmitProof } from '../../../shared/ptyMessageDelivery';
import type { Task } from '../../../shared/types';
import { AnswerReceiptStore, receiptHash } from '../../approvals/AnswerReceiptStore';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS, type RemoteApprovalRecordFacts } from '../../approvals/ApprovalRegistry';
import type { ApprovalResolveParams, ApprovalResolveResult } from '../../approvals/types';
import type { PendingToolUse } from '../../transcript/pendingToolUse';
import { parseTranscriptLine } from '../../transcript/parseEntry';
import { ApprovalSwitchStore } from '../approvalSwitchStore';
import {
  APPROVAL_AUDIT_REFUSALS_PER_WINDOW,
  APPROVAL_OTHER_STATUS_CHANGES_MAX,
  APPROVAL_PROMPTS_PER_TASK_MAX,
  APPROVAL_WINDOW_MS,
  APPROVALS_PER_WINDOW,
  openApprovalReceipts,
  RemoteApprovals,
  decideRemoteApproval,
  offeredCommand,
  promptIdOf,
  type RemoteApprovalFacts,
  type RemoteApprovalsDeps,
} from '../remoteApproval';
import { stepTaskTurn, type TaskTurn } from '../taskTurn';

const FIXTURES = path.join(__dirname, '..', '..', 'approvals', '__tests__', 'fixtures', 'terminal-prompts', 'claude-2.1.293');
type Fixture = { cols: number; screen: string[] };
const load = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Fixture;
const WIDE = load('claude-bash-tip-01-initial-2.1.293.json');
const NARROW = load('claude-bash-tip-02-narrow-2.1.293.json');
const DESCRIPTION = (file: string): string => `Write key-test into ${file} in the working directory`;
const CALL_A: PendingToolUse = { id: 'toolu_a', name: 'Bash', input: { command: 'echo key-test > fx-a.txt', description: DESCRIPTION('fx-a.txt') } };
const CALL_B: PendingToolUse = { id: 'toolu_b', name: 'Bash', input: { command: 'echo key-test > fx-b.txt', description: DESCRIPTION('fx-b.txt') } };

const HOST = '11111111-1111-4111-8111-111111111111';
const LINK = 'link-1';
const TASK = 'rt-task-1';
const PTY = 'pty-a';
const SUBMIT = 5;

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-approval-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function task(over: Partial<{ state: string; from: string }> = {}): Task {
  return {
    id: TASK,
    status: { state: over.state ?? 'working', timestamp: '2026-11-19T00:00:00.000Z' },
    metadata: {
      from: { workspaceId: over.from ?? remoteWorkspaceId(LINK), name: 'pc-a/ws-a/claude' },
      to: { workspaceId: 'ws-b', name: 'Backend', paneId: 'pane-b', ptyId: PTY },
      remote: { v: 1, linkId: LINK, hostId: HOST, messageId: 'm-1', direction: 'inbound', kind: 'pane', delivered: true },
    },
  } as unknown as Task;
}

/** The real registry over one pane whose screen and key revision the test moves. */
function makeRig(opts: { exposure?: A2aApprovalExposure | null; setting?: ApprovalSwitchStore } = {}) {
  const pane = { keyInputRevision: SUBMIT, incarnation: 'inc-1', rows: WIDE.screen as readonly string[], cols: WIDE.cols, pending: CALL_A as PendingToolUse | null };
  const writes: string[] = [];
  const clock = { now: 10_000 };
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    // As the daemon's writer: the key lands and the pane's key revision moves by one.
    writeToSession: (_id, data) => { writes.push(data); pane.keyInputRevision += 1; return true; },
    readPromptScreen: async () => ({ rows: pane.rows, cols: pane.cols, mark: { bytes: 1, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation } }),
    // The registry reads this in the write block, right before `authorizeNow` and the key.
    promptScreenMark: () => { state.inWriteBlock?.(); return { bytes: 1, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation }; },
    pendingToolUse: () => pane.pending,
    agentSessionId: () => 'b0c1d2e3-f405-4a6b-8c9d-0e1f2a3b4c5d',
    promptReadDelay: async () => undefined,
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  const state = {
    exposure: (opts.exposure === undefined ? 'command' : opts.exposure) as A2aApprovalExposure | null,
    task: task(),
    turn: { opened: true, closed: false, toolUseIds: ['toolu_a'] as string[] },
    taskItself: true,
    proof: { ptyId: PTY, incarnation: 'inc-1', keyEpoch: 'epoch-1', submitRevision: SUBMIT, promptHash: '0'.repeat(64) } as GatedSubmitProof,
    linked: true,
    connected: true,
    lock: 'token' as string | null,
    inWriteBlock: undefined as (() => void) | undefined,
  };
  const sent: Array<{ taskId: string; status: A2aRemoteStatusV1 }> = [];
  // The outbox the statuses go to (A2aRemoteDelivery.sendStatus); the coordinator's own reporter is in front of it.
  const status = {
    peer: () => ({ connected: state.connected, takesStatus: true, epoch: 'e1' }),
    send: (taskId: string, st: A2aRemoteStatusV1) => { sent.push({ taskId, status: st }); return { ok: true as const }; },
  };
  const resolves: ApprovalResolveParams[] = [];
  const logs: string[] = [];
  const deps: RemoteApprovalsDeps = {
    exposure: (hostId) => (opts.setting ? opts.setting.exposure(hostId) : state.exposure),
    anyOn: () => (opts.setting ? opts.setting.anyOn() : state.exposure !== null),
    tasks: { get: (id) => (id === TASK ? state.task : undefined), remote: () => [state.task] },
    linkedPane: () => state.linked,
    linkActive: () => true,
    hostName: () => 'Mac',
    turn: () => ({ turn: { ...state.turn, toolUseIds: [...state.turn.toolUseIds] }, proof: state.proof, taskItself: state.taskItself }),
    session: () => ({ incarnation: 'inc-1', keyEpoch: 'epoch-1' }),
    registry: {
      pendingPrompts: (sid) => registry.list().pending.filter((r) => r.kind === 'terminal_prompt' && r.sessionId === sid).map((r) => r.id),
      facts: (id) => registry.remoteApprovalFacts(id),
      resolve: (params) => { resolves.push(params); return registry.resolve(params); },
    },
    lock: async () => state.lock,
    unlock: () => undefined,
    receipts: new AnswerReceiptStore(tmpDir, () => clock.now, undefined, 'a2a-remote-approval-receipts.json', { durable: true, strictRead: true }),
    status,
    log: (_level, msg) => { logs.push(msg); },
    now: () => clock.now,
    manualTick: true,
  };
  const approvals = new RemoteApprovals(deps);
  /** A dialog drawn now: the registry's record for it, old enough to answer. */
  const prompt = async (fx: Fixture = WIDE, call: PendingToolUse = CALL_A) => {
    pane.rows = fx.screen;
    pane.cols = fx.cols;
    pane.pending = call;
    await registry.noteTerminalPrompt({ sessionId: PTY, agent: 'claude', workspaceId: 'ws-b', source: 'detector' });
    clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS + STATUS_GAP;
    const record = registry.list().pending.filter((r) => r.kind === 'terminal_prompt').at(-1);
    if (!record) throw new Error('no record');
    return record;
  };
  /** The prompt id the last status offered. */
  const offered = (): string | undefined => sent.at(-1)?.status.detail?.approval?.promptId;
  return { registry, pane, writes, clock, state, sent, resolves, logs, approvals, prompt, offered, deps };
}
const STATUS_GAP = 6_000;
/** The id the record would be offered under at exposure `command` with allow and its whole command. */
const idOf = (rig: { registry: ApprovalRegistry }, recordId: string): string => {
  const f = rig.registry.remoteApprovalFacts(recordId)!;
  return promptIdOf(f, { exposure: 'command', allowed: ['allow', 'deny'], ...(f.call ? { command: f.call.command } : {}) })!;
};

const allow = (promptId: string) => ({ promptId, decision: 'allow' as const });
const deny = (promptId: string) => ({ promptId, decision: 'deny' as const });

describe('off: nothing changes', () => {
  const settingsDir = (): string => fs.mkdtempSync(path.join(tmpDir, 'settings-'));
  const setting = (dir: string): ApprovalSwitchStore => new ApprovalSwitchStore({ dir, pairing: () => 'peer:1', log: () => undefined, scheduleHarden: () => undefined });
  it.each([
    ['no settings file', (dir: string) => setting(dir)],
    ['a damaged settings file', (dir: string) => {
      fs.writeFileSync(path.join(dir, 'a2a-remote-approvals.json'), JSON.stringify({ v: 1, hosts: { [HOST]: { exposure: 'everything' } } }));
      return setting(dir);
    }],
    ['on for another PC only', (dir: string) => {
      const s = setting(dir);
      s.set('22222222-2222-4222-8222-222222222222', 'command');
      return setting(dir);
    }],
  ])('%s: no status, no detail.approval in the outbox, and an approval types nothing (no Esc)', async (_label, make) => {
    const rig = makeRig({ setting: make(settingsDir()) });
    const record = await rig.prompt();
    rig.approvals.tick();
    expect(rig.sent).toEqual([]);
    // Even with a prompt id the asker could not have been given.
    const id = idOf(rig, record.id);
    for (const approval of [allow(id), deny(id)]) {
      expect(await rig.approvals.take(HOST, TASK, `ap-${approval.decision}`, approval)).toEqual({ messageId: `ap-${approval.decision}`, outcome: 'not-done', reason: 'approvals-off' });
    }
    expect(rig.writes).toEqual([]);
    expect(rig.resolves).toEqual([]);
    expect(rig.sent).toEqual([]);
  });

  it('turned off after a prompt was offered: no further status, and nothing typed', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const before = rig.sent.length;
    rig.state.exposure = null;
    rig.clock.now += STATUS_GAP;
    rig.approvals.tick();
    expect(rig.sent).toHaveLength(before);
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toMatchObject({ outcome: 'not-done', reason: 'approvals-off' });
    expect(rig.writes).toEqual([]);
  });
});

describe('on: the prompt is offered, and allowed or denied', () => {
  it('offers the bound call\'s command, never screen rows or the description', async () => {
    const rig = makeRig();
    const record = await rig.prompt();
    rig.approvals.tick();
    expect(rig.sent).toHaveLength(1);
    const { status } = rig.sent[0]!;
    expect(status.kind).toBe('question');
    expect(status.detail?.question).toBe('permission');
    expect(status.detail?.approval).toEqual({
      promptId: idOf(rig, record.id),
      tool: 'Bash',
      command: 'echo key-test > fx-a.txt',
      redacted: false,
      cut: false,
      allowed: ['allow', 'deny'],
    });
    expect(JSON.stringify(status)).not.toContain('Write key-test');
    expect(JSON.stringify(status)).not.toContain('Do you want');
  });

  it('tool-only: the tool name and flags only, and only deny', async () => {
    const rig = makeRig({ exposure: 'tool-only' });
    await rig.prompt();
    rig.approvals.tick();
    const approval = rig.sent[0]!.status.detail!.approval!;
    expect(approval).not.toHaveProperty('command');
    expect(approval.allowed).toEqual(['deny']);
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(approval.promptId))).toMatchObject({ outcome: 'not-done', reason: 'deny-only' });
    expect(rig.writes).toEqual([]);
    expect(await rig.approvals.take(HOST, TASK, 'ap-2', deny(approval.promptId))).toEqual({ messageId: 'ap-2', outcome: 'done' });
    expect(rig.writes).toEqual(['\x1b']);
  });

  it('allow presses the plain Yes, once; a resend of the same message answers the stored outcome and types nothing', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'done' });
    expect(rig.writes).toEqual(['1']);
    expect(rig.registry.list().pending[0]).toMatchObject({ resolvedBy: `remote:Mac/${HOST}`, decision: 'approve' });
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'done' });
    expect(rig.writes).toEqual(['1']);
    // The same message id for another decision is not taken.
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toMatchObject({ outcome: 'not-done', reason: 'id-reused' });
    // The outcome goes back with the next status; the audit line has ids, never the command.
    rig.clock.now += STATUS_GAP;
    rig.approvals.tick();
    // A reused id does not overwrite what its message did.
    expect(rig.sent.at(-1)!.status.detail?.approvals).toEqual([{ messageId: 'ap-1', outcome: 'done' }]);
    expect(rig.logs.some((l) => l.startsWith(`[a2a-remote] approval task=${TASK} message=ap-1 prompt=${id} decision=allow outcome=done fp=`))).toBe(true);
    expect(rig.logs.join('\n')).not.toContain('echo key-test');
  });

  it('a carried-out decision is told once to carriedOut, with the tool and never the command; a refusal or a resend is not', async () => {
    const rig = makeRig();
    const told: unknown[] = [];
    rig.deps.carriedOut = (e) => { told.push(e); };
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    expect(await rig.approvals.take(HOST, TASK, 'ap-0', allow('0123456789abcdef'))).toMatchObject({ outcome: 'not-done' });
    expect(told).toEqual([]);
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'done' });
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'done' });
    expect(told).toEqual([{ hostId: HOST, taskId: TASK, messageId: 'ap-1', decision: 'allow', tool: 'Bash' }]);
    expect(JSON.stringify(told)).not.toContain('echo key-test');
  });

  it('a second prompt in the same turn is approvable: the chain moves to this channel\'s own key', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(rig.offered()!))).toMatchObject({ outcome: 'done' });
    // The tool ran; its dialog is gone, and the agent asks for the next call in the same turn.
    await rig.registry.expireForSession(PTY, 'prompt-gone');
    rig.state.turn.toolUseIds.push('toolu_b');
    const second = await rig.prompt(NARROW, CALL_B);
    expect(second.keyRevisionAtCreate).toBe(SUBMIT + 1);
    rig.approvals.tick();
    const id = rig.offered()!;
    expect(rig.sent.at(-1)!.status.detail?.approval?.command).toBe('echo key-test > fx-b.txt');
    expect(await rig.approvals.take(HOST, TASK, 'ap-2', allow(id))).toEqual({ messageId: 'ap-2', outcome: 'done' });
    expect(rig.writes).toEqual(['1', '1']);
  });

  it('PINNED: a local key between the submit and the prompt breaks the chain for the rest of the task', async () => {
    const rig = makeRig();
    // Someone typed in the pane after the task was submitted.
    rig.pane.keyInputRevision += 1;
    const record = await rig.prompt();
    rig.approvals.tick();
    expect(rig.sent).toEqual([]);
    const id = idOf(rig, record.id);
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toMatchObject({ outcome: 'not-done', reason: 'chain-broken' });
    expect(rig.logs.some((l) => l.includes(`task ${TASK}: answered on this PC from now on`))).toBe(true);
    // A later prompt in the same turn is still not offered, even one made at the submit's own revision: broken stays broken.
    await rig.registry.expireForSession(PTY, 'prompt-gone');
    rig.state.turn.toolUseIds.push('toolu_b');
    rig.pane.keyInputRevision = SUBMIT;
    const later = await rig.prompt(NARROW, CALL_B);
    expect(later.keyRevisionAtCreate).toBe(SUBMIT);
    rig.approvals.tick();
    // Only the refusal goes back; no prompt is offered.
    expect(rig.sent.map((x) => x.status.detail?.approval)).toEqual([undefined]);
    const laterId = idOf(rig, later.id);
    expect(await rig.approvals.take(HOST, TASK, 'ap-2', deny(laterId))).toMatchObject({ outcome: 'not-done', reason: 'chain-broken' });
    expect(rig.writes).toEqual([]);
  });

  it('a key at the desk after the prompt was offered: the fence refuses, the refreshed record is never offered', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    rig.pane.keyInputRevision += 1;
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(id))).toMatchObject({ outcome: 'not-done' });
    expect(rig.writes).toEqual([]);
    rig.clock.now += STATUS_GAP;
    rig.approvals.tick();
    expect(rig.sent.at(-1)!.status.detail?.approval).toBeUndefined();
  });

  it('a later message delivered into the pane (a follow-up) ends remote approval for the task', async () => {
    const rig = makeRig();
    rig.state.taskItself = false;
    const record = await rig.prompt();
    rig.approvals.tick();
    expect(rig.sent).toEqual([]);
    const id = idOf(rig, record.id);
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toMatchObject({ outcome: 'not-done', reason: 'chain-broken' });
  });

  it('a prompt id the PC never offered, or from another PC, types nothing', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny('ffffffffffffffff'))).toMatchObject({ outcome: 'not-done', reason: 'not-offered' });
    rig.state.exposure = 'command';
    expect(await rig.approvals.take('22222222-2222-4222-8222-222222222222', TASK, 'ap-2', deny(rig.offered()!))).toMatchObject({ outcome: 'not-done', reason: 'not-open' });
    expect(rig.writes).toEqual([]);
  });

  it('a task that ended, or one that this PC sent, offers nothing', async () => {
    const rig = makeRig();
    rig.state.task = task({ from: 'ws-local' });
    await rig.prompt();
    rig.approvals.tick();
    expect(rig.sent).toEqual([]);
    rig.state.task = task({ state: 'completed' });
    rig.approvals.tick();
    expect(rig.sent).toEqual([]);
  });
});

describe('the turn proof', () => {
  const PROMPT = '[wmux] task rt-task-1 from Mac/ws/#1:\n> run the build';
  let seq = 0;
  const stamp = (): string => new Date(Date.UTC(2026, 10, 19, 0, 0, seq++)).toISOString();
  const userLine = (text: string): string => JSON.stringify({ type: 'user', uuid: `u${seq}`, timestamp: stamp(), message: { role: 'user', content: text } });
  const endLine = (): string => JSON.stringify({ type: 'assistant', uuid: `a${seq}`, timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
  const callLine = (id: string, command: string): string => JSON.stringify({ type: 'assistant', uuid: `c${seq}`, timestamp: stamp(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], stop_reason: 'tool_use' } });
  const resultLine = (id: string): string => JSON.stringify({ type: 'user', uuid: `r${seq}`, timestamp: stamp(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

  it('a background wake after the task\'s turn ended: its call is not in the turn, turn-unproven, nothing typed', async () => {
    const t: TaskTurn = { promptHash: promptHash(PROMPT), opened: false, closed: false, toolUseIds: [] };
    let offset = 0;
    for (const line of [
      userLine(PROMPT), callLine('toolu_build', 'npm run build'), resultLine('toolu_build'), endLine(),
      // The agent is woken later by its own background work, and runs another call.
      userLine('<task-notification>build finished</task-notification>'), callLine('toolu_a', 'echo key-test > fx-a.txt'),
    ]) {
      stepTaskTurn(t, line, parseTranscriptLine(line, offset));
      offset += line.length + 1;
    }
    expect(t).toMatchObject({ opened: true, closed: true, toolUseIds: ['toolu_build'] });
    const rig = makeRig();
    rig.state.turn = { opened: t.opened, closed: t.closed, toolUseIds: t.toolUseIds };
    const record = await rig.prompt();
    rig.approvals.tick();
    expect(rig.sent).toEqual([]);
    const id = idOf(rig, record.id);
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toMatchObject({ outcome: 'not-done', reason: 'turn-unproven' });
    expect(rig.writes).toEqual([]);
  });

  it('a session restarted under another key epoch: turn-unproven', async () => {
    const rig = makeRig();
    rig.state.proof = { ...rig.state.proof, keyEpoch: 'epoch-0' };
    await rig.prompt();
    rig.approvals.tick();
    expect(rig.sent).toEqual([]);
  });
});

describe('the key-revision chain, after it started', () => {
  /** A first prompt allowed: the chain's baseline is now this channel's key. */
  async function afterAllow() {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(rig.offered()!))).toMatchObject({ outcome: 'done' });
    await rig.registry.expireForSession(PTY, 'prompt-gone');
    rig.state.turn.toolUseIds.push('toolu_b');
    return rig;
  }
  async function refusedNext(rig: Awaited<ReturnType<typeof afterAllow>>): Promise<void> {
    const sentBefore = rig.sent.length;
    const next = await rig.prompt(NARROW, CALL_B);
    rig.approvals.tick();
    expect(rig.sent.slice(sentBefore).some((x) => x.status.detail?.approval)).toBe(false);
    const id = idOf(rig, next.id);
    expect(await rig.approvals.take(HOST, TASK, 'ap-2', deny(id))).toMatchObject({ outcome: 'not-done', reason: 'chain-broken' });
    expect(rig.writes).toEqual(['1']);
  }

  it('a follow-up delivered into the pane ends it', async () => {
    const rig = await afterAllow();
    rig.state.taskItself = false;
    await refusedNext(rig);
  });

  it('the task delivered again under a new proof ends it', async () => {
    const rig = await afterAllow();
    rig.state.proof = { ...rig.state.proof, submitRevision: SUBMIT + 1 };
    await refusedNext(rig);
  });

  it('a local key after the remote allow moved the baseline ends it', async () => {
    const rig = await afterAllow();
    rig.pane.keyInputRevision += 1;
    await refusedNext(rig);
  });

  it('a pass whose task list could not be read keeps it: the next prompt at this channel\'s revision is offered', async () => {
    const rig = await afterAllow();
    const remote = rig.deps.tasks.remote;
    rig.deps.tasks.remote = () => { throw new Error('ledger busy'); };
    rig.approvals.tick();
    expect(rig.logs.some((l) => l.includes('approvals: the task list: ledger busy'))).toBe(true);
    rig.deps.tasks.remote = remote;
    const sentBefore = rig.sent.length;
    const next = await rig.prompt(NARROW, CALL_B);
    expect(next.keyRevisionAtCreate).toBe(SUBMIT + 1);
    rig.approvals.tick();
    expect(rig.sent.slice(sentBefore).some((x) => x.status.detail?.approval?.promptId === idOf(rig, next.id))).toBe(true);
    expect(await rig.approvals.take(HOST, TASK, 'ap-2', allow(idOf(rig, next.id)))).toEqual({ messageId: 'ap-2', outcome: 'done' });
    expect(rig.writes).toEqual(['1', '1']);
  });
});

describe('the key-revision chain while the setting is off for every PC', () => {
  it('is kept: the task delivered again under a new proof meanwhile ends it once it is back on', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    expect(rig.offered()).toBeDefined();
    rig.state.exposure = null;
    rig.approvals.tick();
    // Delivered again while off: the pane took its submit, under another proof.
    await rig.registry.expireForSession(PTY, 'prompt-gone');
    rig.pane.keyInputRevision = SUBMIT + 1;
    rig.state.proof = { ...rig.state.proof, submitRevision: SUBMIT + 1, promptHash: '1'.repeat(64) };
    rig.state.turn.toolUseIds.push('toolu_b');
    const next = await rig.prompt(NARROW, CALL_B);
    expect(next.keyRevisionAtCreate).toBe(SUBMIT + 1);
    rig.state.exposure = 'command';
    const sentBefore = rig.sent.length;
    rig.approvals.tick();
    expect(rig.sent.slice(sentBefore).some((x) => x.status.detail?.approval)).toBe(false);
    expect(rig.logs.some((l) => l.includes('the task was delivered again'))).toBe(true);
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(idOf(rig, next.id)))).toMatchObject({ outcome: 'not-done', reason: 'chain-broken' });
    expect(rig.writes).toEqual([]);
  });
});

describe('carrying out an approval: what can stop it', () => {
  it('authorizeNow: the setting turned off between the receipt and the key, nothing typed, not done', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    rig.state.inWriteBlock = () => { rig.state.exposure = null; };
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'refused' });
    expect(rig.writes).toEqual([]);
    expect(rig.logs.some((l) => l.includes('outcome=not-done:refused:unauthorized'))).toBe(true);
  });

  it('a receipt that cannot be begun: nothing typed', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    const receipts = rig.deps.receipts!;
    const failing = new RemoteApprovals({ ...rig.deps, receipts: Object.assign(Object.create(Object.getPrototypeOf(receipts) as object) as AnswerReceiptStore, receipts, { begin: async () => { throw new Error('disk full'); } }) });
    failing.tick();
    expect(await failing.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'unavailable' });
    expect(rig.resolves).toEqual([]);
    expect(rig.writes).toEqual([]);
  });

  it('the registry throwing: uncertain, stored, never run again', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    let calls = 0;
    const throwing = new RemoteApprovals({ ...rig.deps, registry: { ...rig.deps.registry, resolve: async () => { calls += 1; throw new Error('boom'); } } });
    throwing.tick();
    expect(await throwing.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'uncertain' });
    expect(await throwing.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'uncertain' });
    expect(calls).toBe(1);
  });

  it('the pane lock kept by another writer: lock-busy, nothing typed, and a resend answers the same', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    rig.state.lock = null;
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'lock-busy' });
    rig.state.lock = 'token';
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'lock-busy' });
    expect(rig.writes).toEqual([]);
    expect(await rig.approvals.take(HOST, TASK, 'ap-2', allow(id))).toEqual({ messageId: 'ap-2', outcome: 'done' });
    expect(rig.writes).toEqual(['1']);
  });
});

describe('an outcome whose receipt could not be written', () => {
  it('is answered the same to a resend while the daemon runs, even once the store and the pane would let it run', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    const real = rig.deps.receipts!;
    let failing = true;
    const receipts = new Proxy(real, {
      get(target, key) {
        if (key === 'begin' && failing) return async () => { throw new Error('disk full'); };
        const v = Reflect.get(target, key) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const approvals = new RemoteApprovals({ ...rig.deps, receipts });
    approvals.tick();
    rig.state.lock = null;
    expect(await approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'lock-busy' });
    failing = false;
    rig.state.lock = 'token';
    expect(await approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'lock-busy' });
    expect(rig.writes).toEqual([]);
    expect(await approvals.take(HOST, TASK, 'ap-2', allow(id))).toEqual({ messageId: 'ap-2', outcome: 'done' });
  });
});

describe('an outcome whose final receipt could not be saved', () => {
  it('the key landed: uncertain, the same as a resend reads it, and never typed again', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    const receipts = rig.deps.receipts!;
    const approvals = new RemoteApprovals({
      ...rig.deps,
      registry: {
        ...rig.deps.registry,
        // The key lands; then the store's writes fail, so the final receipt is not saved.
        resolve: async (params) => {
          const res = await rig.deps.registry.resolve(params);
          (receipts as unknown as { save: () => Promise<void> }).save = () => Promise.reject(new Error('disk full'));
          return res;
        },
      },
    });
    approvals.tick();
    const first = await approvals.take(HOST, TASK, 'ap-1', allow(id));
    expect(rig.writes).toEqual(['1']);
    expect(first).toEqual({ messageId: 'ap-1', outcome: 'uncertain' });
    expect(await approvals.take(HOST, TASK, 'ap-1', allow(id))).toEqual(first);
    expect(rig.writes).toEqual(['1']);
    // On disk it is still in flight: the next start reads it as uncertain too.
    const file = path.join(tmpDir, 'a2a-remote-approval-receipts.json');
    expect(Object.values((JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, { state: string }> }).entries).map((e) => e.state)).toEqual(['inFlight']);
  });
});

describe('a refusal whose receipt could not be saved', () => {
  it('answers uncertain, the same as a resend reads it', async () => {
    const rig = makeRig();
    const record = await rig.prompt();
    const receipts = rig.deps.receipts as unknown as { save: () => Promise<void> };
    const save = receipts.save.bind(receipts);
    let saves = 0;
    // The in-flight receipt is saved; the refusal that follows is not.
    receipts.save = () => (saves++ === 0 ? save() : Promise.reject(new Error('disk full')));
    const id = idOf(rig, record.id);
    const first = await rig.approvals.take(HOST, TASK, 'ap-1', deny(id));
    expect(first).toEqual({ messageId: 'ap-1', outcome: 'uncertain' });
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toEqual(first);
    expect(rig.writes).toEqual([]);
  });
});

describe('a chain broken before the setting went off for every PC', () => {
  it('stays broken when it comes back on', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(rig.offered()!))).toMatchObject({ outcome: 'done' });
    await rig.registry.expireForSession(PTY, 'prompt-gone');
    rig.state.turn.toolUseIds.push('toolu_b');
    // Delivered again under a proof at the pane's current revision: broken.
    rig.state.proof = { ...rig.state.proof, submitRevision: SUBMIT + 1, promptHash: '1'.repeat(64) };
    const next = await rig.prompt(NARROW, CALL_B);
    expect(next.keyRevisionAtCreate).toBe(SUBMIT + 1);
    rig.approvals.tick();
    expect(rig.logs.some((l) => l.includes('the task was delivered again'))).toBe(true);
    rig.state.exposure = null;
    rig.approvals.tick();
    rig.state.exposure = 'command';
    rig.clock.now += STATUS_GAP;
    rig.approvals.tick();
    expect(rig.sent.slice(1).some((x) => x.status.detail?.approval)).toBe(false);
    expect(await rig.approvals.take(HOST, TASK, 'ap-2', deny(idOf(rig, next.id)))).toMatchObject({ outcome: 'not-done', reason: 'chain-broken' });
    expect(rig.writes).toEqual(['1']);
  });
});

describe('the bound input\'s keys, when the registry does not know them', () => {
  it('are passed on as not known, so allow is not offered', async () => {
    const rig = makeRig();
    const record = await rig.prompt();
    const inner = (rig.registry as unknown as { requests: object[] }).requests.find((r) => (r as { id: string }).id === record.id)!;
    const identity = Object.getOwnPropertySymbols(inner).map((k) => (inner as Record<symbol, { call?: { inputKeys?: string[] } }>)[k]).find((v) => v?.call)!;
    delete identity.call!.inputKeys;
    expect(rig.registry.remoteApprovalFacts(record.id)!.call).not.toHaveProperty('inputKeys');
    rig.approvals.tick();
    expect(rig.sent.at(-1)!.status.detail?.approval?.allowed).toEqual(['deny']);
  });
});

describe('an answer is held to what left this PC', () => {
  it('tool-only, then command: the allow offer is another prompt id, so an allow for the deny-only offer the asker holds is never typed', async () => {
    const rig = makeRig({ exposure: 'tool-only' });
    await rig.prompt();
    rig.approvals.tick();
    const held = rig.offered()!;
    expect(rig.sent.at(-1)!.status.detail?.approval?.allowed).toEqual(['deny']);
    // Raised to command: the next pass queues an allow offer for the same dialog.
    rig.state.exposure = 'command';
    rig.clock.now += STATUS_GAP;
    rig.approvals.tick();
    const raised = rig.sent.at(-1)!.status.detail!.approval!;
    expect(raised).toMatchObject({ command: 'echo key-test > fx-a.txt', allowed: ['allow', 'deny'] });
    expect(raised.promptId).not.toBe(held);
    // An allow naming the offer the asker held (it has not seen the raised one yet): nothing typed.
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(held))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'not-offered' });
    expect(rig.writes).toEqual([]);
    // Lowered and raised again: the deny-only offer in between has its own id as well.
    rig.state.exposure = 'tool-only';
    rig.clock.now += STATUS_GAP;
    rig.approvals.tick();
    const lowered = rig.sent.at(-1)!.status.detail!.approval!;
    expect(lowered.allowed).toEqual(['deny']);
    expect(new Set([held, raised.promptId, lowered.promptId]).size).toBe(2);
    expect(lowered.promptId).toBe(held);
    rig.state.exposure = 'command';
    expect(await rig.approvals.take(HOST, TASK, 'ap-2', allow(lowered.promptId))).toEqual({ messageId: 'ap-2', outcome: 'not-done', reason: 'not-offered' });
    expect(rig.writes).toEqual([]);
    // The offer the asker was shown with its command: allowed.
    expect(await rig.approvals.take(HOST, TASK, 'ap-3', allow(raised.promptId))).toEqual({ messageId: 'ap-3', outcome: 'done' });
    expect(rig.writes).toEqual(['1']);
  });

  it('an allow offer queued but held back (the PC not connected) is not answerable yet', async () => {
    const rig = makeRig({ exposure: 'tool-only' });
    await rig.prompt();
    rig.approvals.tick();
    rig.state.exposure = 'command';
    rig.state.connected = false;
    rig.clock.now += STATUS_GAP;
    rig.approvals.tick();
    const record = rig.registry.list().pending[0]!;
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', allow(idOf(rig, record.id)))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'not-offered' });
    expect(rig.writes).toEqual([]);
  });

  it('a prompt whose status never left (the PC not connected): not offered, so nothing typed', async () => {
    const rig = makeRig();
    rig.state.connected = false;
    const record = await rig.prompt();
    rig.approvals.tick();
    expect(rig.sent).toEqual([]);
    const id = idOf(rig, record.id);
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toMatchObject({ outcome: 'not-done', reason: 'not-offered' });
    expect(rig.writes).toEqual([]);
  });

  it('a refusal is stored per message: a resend after the prompt became answerable replays it', async () => {
    const rig = makeRig();
    const record = await rig.prompt();
    const id = idOf(rig, record.id);
    // Before any status left: not offered.
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toMatchObject({ reason: 'not-offered' });
    rig.approvals.tick();
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'not-offered' });
    expect(rig.writes).toEqual([]);
  });
});

describe('only a linked pane\'s task', () => {
  it('a headless or spawn-link task: refused, and no status of this producer is ever sent for it', async () => {
    const rig = makeRig();
    rig.state.linked = false;
    const record = await rig.prompt();
    rig.approvals.tick();
    const id = idOf(rig, record.id);
    expect(await rig.approvals.take(HOST, TASK, 'ap-1', deny(id))).toEqual({ messageId: 'ap-1', outcome: 'not-done', reason: 'not-linked' });
    rig.clock.now += STATUS_GAP;
    rig.approvals.tick();
    expect(rig.sent).toEqual([]);
    expect(rig.writes).toEqual([]);
  });
});

describe('a flood from one PC', () => {
  it('past the window\'s approvals the rest are dropped unread, with one log line; the next window takes them again', () => {
    const rig = fakeRig({ command: 'ls' });
    for (let i = 0; i < APPROVALS_PER_WINDOW; i++) expect(rig.approvals.admit(HOST)).toBe(true);
    expect(rig.approvals.admit(HOST)).toBe(false);
    expect(rig.approvals.admit(HOST)).toBe(false);
    expect(rig.approvals.admit('22222222-2222-4222-8222-222222222222')).toBe(true);
    expect(rig.logs.filter((l) => l.includes('approvals in a minute'))).toHaveLength(1);
    rig.clock.now += APPROVAL_WINDOW_MS;
    expect(rig.approvals.admit(HOST)).toBe(true);
  });

  it('refusal audit lines are capped per PC in a window', async () => {
    const rig = fakeRig({ command: 'ls' });
    for (let i = 0; i < APPROVAL_AUDIT_REFUSALS_PER_WINDOW + 10; i++) await rig.approvals.take(HOST, TASK, `ap-${i}`, deny('ffffffffffffffff'));
    expect(rig.logs.filter((l) => l.startsWith('[a2a-remote] approval task='))).toHaveLength(APPROVAL_AUDIT_REFUSALS_PER_WINDOW);
    expect(rig.logs.filter((l) => l.includes('more refusals in this minute are not logged'))).toHaveLength(1);
  });
});

describe('what a deny-only prompt sends', () => {
  it.each([['Read', '/home/me/.ssh/id_rsa'], ['WebFetch', 'https://example.com/?token=x'], ['Edit', '/etc/hosts']])('%s: the tool name only, never its path or url', (tool, command) => {
    const rig = fakeRig({ command, tool, inputKeys: ['file_path'] });
    rig.tick();
    const approval = rig.sent.at(-1)!.detail!.approval!;
    expect(approval).toMatchObject({ tool, allowed: ['deny'] });
    expect(approval).not.toHaveProperty('command');
    expect(JSON.stringify(rig.sent)).not.toContain(command);
  });

  it('an input field the other PC is not shown makes a Bash call deny only', () => {
    const rig = fakeRig({ command: 'sleep 1', inputKeys: ['command', 'run_in_background'] });
    rig.tick();
    expect(rig.sent.at(-1)!.detail!.approval).toMatchObject({ command: 'sleep 1', allowed: ['deny'] });
  });
});

describe('receipts', () => {
  it('a stop after the in-flight receipt and before the key: uncertain on the next start, never run again', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    // The registry never answers: the daemon stops here, the receipt on disk in flight.
    let resolveCalled = false;
    const hung = new RemoteApprovals({
      ...rig.deps,
      registry: {
        ...rig.deps.registry,
        resolve: () => {
          // The receipt is already on disk when the key would be typed.
          expect(fs.existsSync(path.join(tmpDir, 'a2a-remote-approval-receipts.json'))).toBe(true);
          resolveCalled = true;
          return new Promise<ApprovalResolveResult>(() => undefined);
        },
      },
    });
    hung.tick();
    void hung.take(HOST, TASK, 'ap-1', allow(id));
    const file = path.join(tmpDir, 'a2a-remote-approval-receipts.json');
    // On disk, in flight, before the registry is asked to type anything.
    await vi.waitFor(() => {
      expect(resolveCalled).toBe(true);
      expect(Object.values((JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, { state: string }> }).entries).map((e) => e.state)).toEqual(['inFlight']);
    }, { timeout: 5_000 });
    // The next start reads it back.
    const rebooted = new RemoteApprovals({
      ...rig.deps,
      receipts: new AnswerReceiptStore(tmpDir, () => rig.clock.now, undefined, 'a2a-remote-approval-receipts.json', { durable: true, strictRead: true }),
    });
    rebooted.tick();
    expect(await rebooted.take(HOST, TASK, 'ap-1', allow(id))).toEqual({ messageId: 'ap-1', outcome: 'uncertain' });
    expect(rig.resolves).toEqual([]);
    expect(rig.writes).toEqual([]);
  });

  it('a resend while the first is still running types nothing and reports nothing for it yet', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const id = rig.offered()!;
    let calls = 0;
    const slow = new RemoteApprovals({
      ...rig.deps,
      registry: { ...rig.deps.registry, resolve: () => { calls += 1; return new Promise<ApprovalResolveResult>(() => undefined); } },
    });
    slow.tick();
    void slow.take(HOST, TASK, 'ap-1', allow(id));
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 5_000 });
    expect(await slow.take(HOST, TASK, 'ap-1', allow(id))).toBe('running');
    expect(calls).toBe(1);
    rig.clock.now += STATUS_GAP;
    slow.tick();
    expect(JSON.stringify(rig.sent)).not.toContain('ap-1');
  });

  it.each([['not JSON', '{"version":1,"entr'], ['another shape', '{"version":2}'], ['an empty file', '']])('a receipts file that is there but %s: unavailable, every approval refused, the file left in place', async (_label, body) => {
    const file = path.join(tmpDir, 'a2a-remote-approval-receipts.json');
    fs.writeFileSync(file, body);
    const logs: string[] = [];
    expect(openApprovalReceipts(tmpDir, (_l, m) => logs.push(m))).toBeNull();
    expect(logs.join('\n')).toMatch(/could not be read; approvals from other PCs are refused/);
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
    // Not there at all: an empty store.
    fs.rmSync(file);
    expect(openApprovalReceipts(tmpDir, () => undefined)).not.toBeNull();
  });

  it('a backup with no receipts file (a write stopped between its renames): unavailable, not an empty store', () => {
    const file = path.join(tmpDir, 'a2a-remote-approval-receipts.json');
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ version: 1, entries: {} }));
    const logs: string[] = [];
    expect(openApprovalReceipts(tmpDir, (_l, m) => logs.push(m))).toBeNull();
    expect(logs.join('\n')).toMatch(/could not be read; approvals from other PCs are refused/);
    expect(fs.existsSync(file)).toBe(false);
    // Neither file: an empty store.
    fs.rmSync(`${file}.bak`);
    expect(openApprovalReceipts(tmpDir, () => undefined)).not.toBeNull();
  });

  it('receipts are replaced in one rename: the file is there after every write, and no backup is kept', async () => {
    const store = openApprovalReceipts(tmpDir, () => undefined)!;
    const file = path.join(tmpDir, 'a2a-remote-approval-receipts.json');
    for (const n of [1, 2]) {
      expect(await store.begin('remote:h', `ap-${n}`, 'task:p:allow', 'a'.repeat(64))).toEqual({ kind: 'new' });
      expect(await store.finish('remote:h', `ap-${n}`, 'done', { status: 200, body: { outcome: 'done' } })).toBe(true);
    }
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    expect(Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: object }).entries)).toHaveLength(2);
  });

  it.each([
    ['a null body', { status: 200, body: null }],
    ['a body that is a list', { status: 200, body: [] }],
    ['a status that is not a number', { status: '200', body: { outcome: 'done' } }],
    ['no status', { body: { outcome: 'done' } }],
  ])('a stored response with %s: unavailable', (_label, result) => {
    const row = { owner: `remote:${HOST}`, approvalId: `${TASK}:p:allow`, bodyHash: 'a'.repeat(64), state: 'done', result, createdAt: 10_000 };
    fs.writeFileSync(path.join(tmpDir, 'a2a-remote-approval-receipts.json'), JSON.stringify({ version: 1, entries: { [receiptHash([`remote:${HOST}`, 'ap-1'])]: row } }));
    expect(openApprovalReceipts(tmpDir, () => undefined, () => 10_000)).toBeNull();
  });

  it('an in-flight receipt with no response loads, as uncertain', () => {
    const row = { owner: `remote:${HOST}`, approvalId: `${TASK}:p:allow`, bodyHash: 'a'.repeat(64), state: 'inFlight', createdAt: 10_000 };
    fs.writeFileSync(path.join(tmpDir, 'a2a-remote-approval-receipts.json'), JSON.stringify({ version: 1, entries: { [receiptHash([`remote:${HOST}`, 'ap-1'])]: row } }));
    const store = openApprovalReceipts(tmpDir, () => undefined, () => 10_000)!;
    expect(store.peek(`remote:${HOST}`, 'ap-1', `${TASK}:p:allow`, 'a'.repeat(64))).toEqual({ kind: 'uncertain' });
  });

  it('receipts that could not be loaded: nothing is typed', async () => {
    const rig = makeRig();
    await rig.prompt();
    rig.approvals.tick();
    const noReceipts = new RemoteApprovals({ ...rig.deps, receipts: null });
    noReceipts.tick();
    expect(await noReceipts.take(HOST, TASK, 'ap-1', deny(rig.offered()!))).toMatchObject({ outcome: 'not-done', reason: 'unavailable' });
    expect(rig.writes).toEqual([]);
  });
});

// ── decideRemoteApproval and the offer, without the registry ────────────────

const FACTS: RemoteApprovalFacts = {
  exposure: 'command',
  task: { open: true, inbound: true, fromHost: true, linkActive: true },
  turn: { opened: true, closed: false, toolUseIds: ['toolu_a'], sameSession: true },
  chain: { baseline: 5, broken: false },
  record: { native: false, answered: false, matched: true, toolUseId: 'toolu_a', promptFingerprint: 'f'.repeat(32), keyRevisionAtCreate: 5, yesKey: '1', fencedPlan: false, tool: 'Bash', inputKeys: ['command', 'description'] },
  command: { shown: true, cut: false, redacted: false },
};
const facts = (over: { [K in keyof RemoteApprovalFacts]?: Partial<RemoteApprovalFacts[K]> | null }): RemoteApprovalFacts => {
  const out = { ...FACTS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) out[k] = v === null ? null : { ...(FACTS as unknown as Record<string, object>)[k], ...(v as object) };
  return out as unknown as RemoteApprovalFacts;
};

describe('decideRemoteApproval', () => {
  it.each([
    ['all checks pass for Bash', facts({}), { ok: true, allowed: ['allow', 'deny'] }],
    ['off', { ...FACTS, exposure: null }, { ok: false, reason: 'approvals-off' }],
    ['task ended', facts({ task: { open: false } }), { ok: false, reason: 'not-open' }],
    ['task from this PC', facts({ task: { inbound: false } }), { ok: false, reason: 'not-open' }],
    ['task from another link', facts({ task: { fromHost: false } }), { ok: false, reason: 'not-open' }],
    ['link not active', facts({ task: { linkActive: false } }), { ok: false, reason: 'link-not-active' }],
    ['a native record', facts({ record: { native: true } }), { ok: false, reason: 'unsupported-tool' }],
    ['already answered', facts({ record: { answered: true } }), { ok: false, reason: 'not-offered' }],
    ['not matched at creation', facts({ record: { matched: false } }), { ok: false, reason: 'unbound' }],
    ['no tool_use id', facts({ record: { toolUseId: undefined } }), { ok: false, reason: 'unbound' }],
    ['turn unknown', { ...FACTS, turn: null }, { ok: false, reason: 'turn-unproven' }],
    ['turn not opened', facts({ turn: { opened: false } }), { ok: false, reason: 'turn-unproven' }],
    ['turn closed', facts({ turn: { closed: true } }), { ok: false, reason: 'turn-unproven' }],
    ['call not in the turn', facts({ turn: { toolUseIds: ['toolu_x'] } }), { ok: false, reason: 'turn-unproven' }],
    ['another session', facts({ turn: { sameSession: false } }), { ok: false, reason: 'turn-unproven' }],
    ['chain broken', facts({ chain: { broken: true } }), { ok: false, reason: 'chain-broken' }],
    ['no baseline', facts({ chain: { baseline: null } }), { ok: false, reason: 'chain-broken' }],
    ['made at another revision', facts({ record: { keyRevisionAtCreate: 6 } }), { ok: false, reason: 'chain-broken' }],
    ['tool-only', { ...FACTS, exposure: 'tool-only' as const, command: { shown: false, cut: false, redacted: false } }, { ok: true, allowed: ['deny'] }],
    ['command cut', facts({ command: { cut: true } }), { ok: true, allowed: ['deny'] }],
    ['command redacted', facts({ command: { redacted: true } }), { ok: true, allowed: ['deny'] }],
    ['risk critical', facts({ record: { risk: 'critical' } }), { ok: true, allowed: ['deny'] }],
    ['no plain Yes', facts({ record: { yesKey: undefined } }), { ok: true, allowed: ['deny'] }],
    ['PowerShell', facts({ record: { tool: 'PowerShell', inputKeys: ['command'] } }), { ok: true, allowed: ['allow', 'deny'] }],
    ['WebSearch', facts({ record: { tool: 'WebSearch', inputKeys: ['query'] } }), { ok: true, allowed: ['allow', 'deny'] }],
    ['WebSearch with its mode or a domain filter (not shown)', facts({ record: { tool: 'WebSearch', inputKeys: ['query', 'mode'] } }), { ok: true, allowed: ['deny'] }],
    ['Bash run in the background (not shown)', facts({ record: { inputKeys: ['command', 'run_in_background'] } }), { ok: true, allowed: ['deny'] }],
    ['Bash with a timeout (not shown)', facts({ record: { inputKeys: ['command', 'timeout'] } }), { ok: true, allowed: ['deny'] }],
    ['Bash outside the sandbox (not shown)', facts({ record: { inputKeys: ['command', 'dangerouslyDisableSandbox'] } }), { ok: true, allowed: ['deny'] }],
    ['input keys not known', facts({ record: { inputKeys: undefined } }), { ok: true, allowed: ['deny'] }],
    ['Read', facts({ record: { tool: 'Read' } }), { ok: true, allowed: ['deny'] }],
    ['WebFetch', facts({ record: { tool: 'WebFetch' } }), { ok: true, allowed: ['deny'] }],
    ['Edit', facts({ record: { tool: 'Edit' } }), { ok: true, allowed: ['deny'] }],
    ['Write', facts({ record: { tool: 'Write' } }), { ok: true, allowed: ['deny'] }],
    ['NotebookEdit', facts({ record: { tool: 'NotebookEdit' } }), { ok: true, allowed: ['deny'] }],
    ['an MCP tool', facts({ record: { tool: 'mcp__x__y' } }), { ok: false, reason: 'unsupported-tool' }],
    ['a fenced plan', facts({ record: { tool: 'ExitPlanMode', fencedPlan: true, yesKey: undefined, inputKeys: ['plan'] } }), { ok: true, allowed: ['allow', 'deny'] }],
    ['a fenced plan with another input field', facts({ record: { tool: 'ExitPlanMode', fencedPlan: true, yesKey: undefined, inputKeys: ['plan', 'x'] } }), { ok: true, allowed: ['deny'] }],
    ['a plan not answered by fenced keys', facts({ record: { tool: 'ExitPlanMode', fencedPlan: false } }), { ok: false, reason: 'unsupported-tool' }],
    ['a fenced plan cut at the cap', facts({ record: { tool: 'ExitPlanMode', fencedPlan: true }, command: { cut: true } }), { ok: true, allowed: ['deny'] }],
    ['a fenced plan with no text to show', facts({ record: { tool: 'ExitPlanMode', fencedPlan: true }, command: { shown: false } }), { ok: true, allowed: ['deny'] }],
  ])('%s', (_label, f, verdict) => {
    expect(decideRemoteApproval(f as RemoteApprovalFacts)).toEqual(verdict);
  });
});

describe('the command offered at exposure command', () => {
  it('over 2 KB: cut, so deny only', () => {
    const offered = offeredCommand(`echo ${'x'.repeat(3000)}`);
    expect(offered).toMatchObject({ cut: true, redacted: false });
    expect(Buffer.byteLength(offered.text, 'utf8')).toBeLessThanOrEqual(2048);
    expect(decideRemoteApproval(facts({ command: { cut: offered.cut, redacted: offered.redacted } }))).toEqual({ ok: true, allowed: ['deny'] });
  });

  it('a secret in it: redacted before the cap, so deny only', () => {
    const offered = offeredCommand('curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://api.github.com');
    expect(offered.redacted).toBe(true);
    expect(offered.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(decideRemoteApproval(facts({ command: { cut: offered.cut, redacted: offered.redacted } }))).toEqual({ ok: true, allowed: ['deny'] });
  });

  it('a character the other PC would not show (a carriage return, a bidi mark): not the call\'s own text, so deny only', () => {
    for (const command of ['echo a\r\nrm b', 'echo \u202eevil']) {
      const offered = offeredCommand(command);
      expect(offered.redacted).toBe(true);
      expect(offered.text).not.toBe(command);
    }
    expect(offeredCommand('echo a\n\techo b')).toEqual({ text: 'echo a\n\techo b', redacted: false, cut: false });
  });

  it('through the producer: a long, redacted, unshowable or empty command is offered deny only, and an allow is refused before any key', async () => {
    for (const command of [`echo ${'y'.repeat(3000)}`, 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'echo \u202eevil', '']) {
      const rig = fakeRig({ command });
      rig.tick();
      const approval = rig.sent.at(-1)!.detail!.approval!;
      expect(approval.allowed).toEqual(['deny']);
      expect(approval.cut || approval.redacted || command === '').toBe(true);
      expect(await rig.approvals.take(HOST, TASK, `ap-${command.length}`, allow(approval.promptId))).toMatchObject({ outcome: 'not-done', reason: 'deny-only' });
      expect(rig.resolves).toEqual([]);
    }
  });

  it(`offers at most ${APPROVAL_PROMPTS_PER_TASK_MAX} prompts per task; later ones stay on this PC`, () => {
    const rig = fakeRig({ command: 'ls' });
    for (let i = 0; i < APPROVAL_PROMPTS_PER_TASK_MAX + 2; i++) {
      rig.record.id = `req-${i}`;
      rig.tick();
    }
    const ids = new Set(rig.sent.map((s) => s.detail?.approval?.promptId).filter(Boolean));
    expect(ids.size).toBe(APPROVAL_PROMPTS_PER_TASK_MAX);
    expect(rig.logs.filter((l) => l.includes('prompts offered')).length).toBe(1);
  });

  it('outcomes have their own bound: past it the status stays as sent, and the next new prompt still goes with the latest outcomes', async () => {
    const rig = fakeRig({ command: 'ls' });
    rig.tick();
    const first = rig.sent.at(-1)!.detail!.approval!.promptId;
    const n = APPROVAL_OTHER_STATUS_CHANGES_MAX + 5;
    for (let i = 0; i < n; i++) {
      await rig.approvals.take(HOST, TASK, `ap-${i}`, deny(first));
      rig.tick();
    }
    // One status per outcome until the bound, then none.
    expect(rig.sent).toHaveLength(1 + APPROVAL_OTHER_STATUS_CHANGES_MAX);
    expect(rig.logs.filter((l) => l.includes('other status changes sent')).length).toBe(1);
    rig.record.id = 'req-2';
    rig.tick();
    const last = rig.sent.at(-1)!;
    expect(rig.sent).toHaveLength(2 + APPROVAL_OTHER_STATUS_CHANGES_MAX);
    expect(last.detail?.approval?.promptId).not.toBe(first);
    expect(last.detail?.approvals?.at(-1)).toEqual({ messageId: `ap-${n - 1}`, outcome: 'not-done', reason: 'refused' });
  }, 30_000);

  it('the same status sent again under a new `since` counts toward that bound too', () => {
    const rig = fakeRig({ command: 'ls' });
    rig.tick();
    const flap = (): void => {
      // The prompt goes and comes back between two sends: the same offer goes again, with a new `since`.
      rig.state.pending = false;
      rig.clock.now += 1_000;
      rig.approvals.tick();
      rig.state.pending = true;
      rig.clock.now += 1_000;
      rig.approvals.tick();
      rig.tick();
    };
    for (let i = 0; i < APPROVAL_OTHER_STATUS_CHANGES_MAX + 5; i++) flap();
    expect(new Set(rig.sent.map((s) => s.since)).size).toBe(rig.sent.length);
    expect(rig.sent).toHaveLength(1 + APPROVAL_OTHER_STATUS_CHANGES_MAX);
  });
});

/** The producer over a fake registry record (no screen), for what the offer carries. */
function fakeRig(opts: { command: string; tool?: string; inputKeys?: string[]; exposure?: A2aApprovalExposure; fencedPlan?: boolean }) {
  const tool = opts.tool ?? 'Bash';
  const record: RemoteApprovalRecordFacts = {
    id: 'req-1', sessionId: PTY, agent: 'claude', toolName: tool, answered: false, native: false, toolUseId: 'toolu_a',
    promptFingerprint: 'a'.repeat(32), keyRevisionAtCreate: SUBMIT, ...(opts.fencedPlan ? { formFingerprint: 'a'.repeat(32) } : { yesKey: '1' }),
    fencedPlan: opts.fencedPlan === true, matched: true,
    call: { name: tool, command: opts.command, inputKeys: opts.inputKeys ?? ['command'] },
  };
  const clock = { now: 10_000 };
  const sent: A2aRemoteStatusV1[] = [];
  const resolves: ApprovalResolveParams[] = [];
  const logs: string[] = [];
  const t = task();
  const state = { exposure: (opts.exposure ?? 'command') as A2aApprovalExposure | null, pending: true };
  const approvals = new RemoteApprovals({
    exposure: () => state.exposure,
    anyOn: () => state.exposure !== null,
    tasks: { get: () => t, remote: () => [t] },
    linkedPane: () => true,
    linkActive: () => true,
    hostName: () => 'Mac',
    turn: () => ({ turn: { opened: true, closed: false, toolUseIds: ['toolu_a'] }, proof: { ptyId: PTY, incarnation: 'inc-1', keyEpoch: 'e', submitRevision: SUBMIT, promptHash: '0'.repeat(64) }, taskItself: true }),
    session: () => ({ incarnation: 'inc-1', keyEpoch: 'e' }),
    registry: {
      pendingPrompts: () => (state.pending ? [record.id] : []),
      facts: (id) => (id === record.id ? { ...record } : null),
      resolve: async (params) => { resolves.push(params); return { ok: false, reason: 'not-found' }; },
    },
    lock: async () => 'token',
    unlock: () => undefined,
    receipts: new AnswerReceiptStore(tmpDir, () => clock.now, undefined, 'a2a-remote-approval-receipts.json', { durable: true, strictRead: true }),
    status: {
      peer: () => ({ connected: true, takesStatus: true, epoch: 'e1' }),
      send: (_taskId, st) => { sent.push(st); return { ok: true }; },
    },
    log: (_level, msg) => { logs.push(msg); },
    now: () => clock.now,
    manualTick: true,
  });
  /** One pass, past the status floor. */
  const tick = (): void => {
    clock.now += STATUS_GAP;
    approvals.tick();
  };
  return { approvals, sent, resolves, logs, record, state, tick, clock };
}
