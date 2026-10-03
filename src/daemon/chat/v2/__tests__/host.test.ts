import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatV2EventsPush } from '../../../../shared/chatv2/ipc';
import { ApprovalRegistry } from '../../../approvals/ApprovalRegistry';
import { DECISION_V2_WEB_ANSWER } from '../../../approvals/types';
import type { DaemonEvent } from '../../../../shared/rpc';
import { ChatSessionService } from '../../ChatSessionService';
import { ClaudeDriver } from '../claude/claudeDriver';
import { createChatV2Host } from '../host';
import type { ChatV2Host, ChatV2HostDeps } from '../types';
import { FakeClaude, tick, until } from './fakeClaude';

const PANE = 'pty-chat-1';
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatv2-host-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

interface Rig {
  host: ChatV2Host;
  registry: ApprovalRegistry | null;
  fakes: FakeClaude[];
  pushes: Array<{ clientId: string; push: ChatV2EventsPush }>;
  clock: { now: number };
  paneFree: { value: boolean };
  sockets: Map<string, boolean>;
  identity: { value: { startTime: string; commandLine: string } | null };
  killed: number[];
  fake(): FakeClaude;
}

function rig(options: { registry?: boolean; nativeOn?: boolean } = {}): Rig {
  const r = {
    fakes: [] as FakeClaude[],
    pushes: [] as Rig['pushes'],
    clock: { now: 100_000 },
    paneFree: { value: true },
    sockets: new Map<string, boolean>(),
    identity: { value: { startTime: 'start-1', commandLine: '' } as { startTime: string; commandLine: string } | null },
    killed: [] as number[],
  } as Rig;
  r.fake = () => r.fakes[r.fakes.length - 1];
  let host: ChatV2Host | null = null;
  r.registry = options.registry === false ? null : new ApprovalRegistry({
    wmuxDir: dir,
    now: () => r.clock.now,
    readScreenTail: async () => null,
    writeToSession: () => false,
    answerNative: (native, reply, sessionId) => host!.answerNative(native, reply, sessionId),
    phoneDecisions: () => ({ native: options.nativeOn ?? true, stepwise: true }),
  });
  const deps: ChatV2HostDeps = {
    wmuxDir: dir,
    log: () => undefined,
    now: () => r.clock.now,
    sessionManager: {
      getSession: ((id: string) => (id === PANE
        ? { meta: { spawnCwd: dir, env: { PATH: '/usr/bin', WMUX_WORKSPACE_ID: 'ws-1', CLAUDECODE: '1', WMUX_AUTH_TOKEN: 'x' } } }
        : undefined)) as unknown as ChatV2HostDeps['sessionManager']['getSession'],
    },
    approvals: () => r.registry,
    paneFree: async () => r.paneFree.value,
    writeToPane: () => true,
    sendTo: (clientId: string, event: DaemonEvent) => {
      if (r.sockets.get(clientId) === false) return false;
      r.pushes.push({ clientId, push: event.data as ChatV2EventsPush });
      return true;
    },
    processIdentity: async () => r.identity.value,
    killTree: async (pid) => { r.killed.push(pid); },
    drivers: () => {
      const fake = new FakeClaude();
      r.fakes.push(fake);
      return new ClaudeDriver({ settingSources: 'project', backend: fake.backend() });
    },
  };
  host = createChatV2Host(deps);
  r.host = host;
  return r;
}

async function created(r: Rig) {
  const res = await r.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default', model: 'haiku' }, 'main');
  if (!res.ok) throw new Error(res.error.code);
  return res.binding;
}

async function sent(r: Rig, text = 'hello', clientMessageId = 'msg-00001') {
  const b = r.host.bindingForPane(PANE)!;
  return r.host.call('send', { paneId: PANE, chatSessionId: b.chatSessionId, epoch: b.epoch, clientMessageId, text }, 'main');
}

describe('chat v2 host', () => {
  it('creates, sends, streams and ends a turn, with the driver env pinned to the pane', async () => {
    const r = rig();
    await r.host.call('subscribe', { paneId: PANE }, 'main');
    const binding = await created(r);
    expect(binding).toMatchObject({ status: 'idle', agent: 'claude', mode: 'default', model: 'haiku', seq: 2 });
    const env = r.fake().env;
    expect(env).toMatchObject({ WMUX_PTY_ID: PANE, WMUX_GATE: '0', WMUX_WORKSPACE_ID: 'ws-1' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.WMUX_AUTH_TOKEN).toBeUndefined();

    const res = await sent(r);
    expect(res).toEqual({ ok: true, clientMessageId: 'msg-00001', seq: 3 });
    expect(r.host.statusForPane(PANE)).toBe('running');
    r.fake().out({ type: 'stream_event', session_id: 's', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi there' } } });
    r.fake().result();
    await until(() => r.host.statusForPane(PANE) === 'idle');
    await tick(150);
    const events = r.pushes.flatMap((p) => p.push.events);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const last = r.pushes[r.pushes.length - 1].push;
    expect(last.blockCount).toBe(r.host.sessionForPane(PANE)!.blocks.length);
    expect(r.host.sessionForPane(PANE)!.blocks.map((b) => b.role)).toEqual(['user', 'assistant']);

    // A repeated send is answered from the ledger; a changed one is refused.
    expect(await sent(r)).toEqual({ ok: true, clientMessageId: 'msg-00001', seq: 3, duplicate: true });
    expect(await sent(r, 'other')).toMatchObject({ ok: false, error: { code: 'client-message-conflict' } });
    await r.host.dispose();
  });

  it('refuses to start while an agent or process runs in the pane', async () => {
    const r = rig();
    r.paneFree.value = false;
    const res = await r.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' }, 'main');
    expect(res).toMatchObject({ ok: false, error: { code: 'agent-running-in-pane' } });
    expect(r.fakes).toHaveLength(0);
    expect(r.host.bindingForPane(PANE)).toBeNull();
  });

  it('raises exactly one approval card per tool call', async () => {
    const r = rig();
    await created(r);
    await sent(r);
    r.fake().toolUse('toolu_1', 'Write', { file_path: `${dir}/a.txt`, content: 'a' });
    r.fake().canUseTool('req-1', 'Write', { file_path: `${dir}/a.txt`, content: 'a' }, 'toolu_1');
    r.fake().canUseTool('req-1', 'Write', { file_path: `${dir}/a.txt`, content: 'a' }, 'toolu_1');
    await until(() => r.host.statusForPane(PANE) === 'needs-input');
    await tick(20);
    expect(r.registry!.list().pending.filter((p) => p.sessionId === PANE)).toHaveLength(1);
    const cards = r.host.sessionForPane(PANE)!.blocks.filter((b) => b.approval);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ role: 'tool', tool: { callId: 'toolu_1' }, approval: { requestId: 'req-1' } });
    await r.host.dispose();
  });

  it('sends one control_response when the desktop and a phone answer at once', async () => {
    const r = rig();
    const binding = await created(r);
    await sent(r);
    r.fake().canUseTool('req-2', 'Bash', { command: 'touch x' }, 'toolu_2');
    await until(() => r.registry!.list().pending.length === 1);
    // An answer right away waits for the card to be recorded, then is too soon.
    const record = r.registry!.list().pending[0];
    // Too soon: buttons arm CHATV2_ANSWER_ARM_MS after the request.
    const early = await r.host.call('answer', { paneId: PANE, chatSessionId: binding.chatSessionId, requestId: 'req-2', decision: 'allow' }, 'main');
    expect(early).toMatchObject({ ok: false, error: { code: 'approval-refused', message: 'answer-too-soon' } });
    r.clock.now += 2_000;
    const fingerprint = (r.registry as unknown as { requests: Array<{ id: string; formFingerprint?: string }> })
      .requests.find((q) => q.id === record.id)!.formFingerprint!;
    const [desktop, phone] = await Promise.all([
      r.host.call('answer', { paneId: PANE, chatSessionId: binding.chatSessionId, requestId: 'req-2', decision: 'allow' }, 'main'),
      r.registry!.resolve({
        id: record.id,
        decision: 'deny',
        resolvedBy: 'web',
        decisionV2Answer: DECISION_V2_WEB_ANSWER,
        decisionAnswer: { formFingerprint: fingerprint, clientAnswerId: 'phone-1', action: 'deny' },
      }),
    ]);
    await tick(20);
    expect(r.fake().responses('req-2')).toHaveLength(1);
    expect([desktop.ok, phone.ok].filter(Boolean)).toHaveLength(1);
    const card = r.host.sessionForPane(PANE)!.blocks.find((b) => b.approval?.requestId === 'req-2')!;
    expect(card.approval!.decided).toBe(desktop.ok ? 'allow' : 'deny');
    await r.host.dispose();
  });

  async function failClosed(r: Rig) {
    await r.host.call('subscribe', { paneId: PANE }, 'main');
    await created(r);
    await sent(r);
    r.fake().canUseTool('req-3', 'Bash', { command: 'ls' }, 'toolu_3');
    await until(() => r.fake().responses('req-3').length === 1);
    expect(r.fake().responses('req-3')[0]).toMatchObject({ behavior: 'deny' });
    await until(() => r.host.sessionForPane(PANE)!.blocks.some((b) => b.approval?.decided === 'cancelled'));
    const types = r.pushes.flatMap((p) => p.push.events.map((e) => e.event.type));
    const requested = types.indexOf('approval.requested');
    // The cancel is stamped right after the card, never before it (a no-op).
    expect(requested).toBeGreaterThan(-1);
    expect(types[requested + 1]).toBe('approval.resolved');
    expect(r.host.statusForPane(PANE)).toBe('running');
    const pushedStatuses = r.pushes.flatMap((p) => (p.push.binding ? [p.push.binding.status] : []));
    expect(pushedStatuses).not.toContain('needs-input');
  }

  it('denies at once when there is no registry', async () => {
    const r = rig({ registry: false });
    await failClosed(r);
    expect(r.registry).toBeNull();
    await r.host.dispose();
  });

  it('denies at once, and leaves no card, when native decisions are switched off', async () => {
    const r = rig({ nativeOn: false });
    await failClosed(r);
    await until(() => r.registry!.list().pending.length === 0);
    expect(r.registry!.list().pending).toHaveLength(0);
    await r.host.dispose();
  });

  it('expires pending approvals when the turn ends and when the driver exits', async () => {
    const r = rig();
    await created(r);
    await sent(r);
    r.fake().canUseTool('req-4', 'Bash', { command: 'ls' }, 'toolu_4');
    await until(() => r.registry!.list().pending.length === 1);
    r.fake().result();
    await until(() => r.registry!.list().pending.length === 0);
    expect(r.host.sessionForPane(PANE)!.blocks.find((b) => b.approval)!.approval!.decided).toBe('cancelled');

    await sent(r, 'again', 'msg-00002');
    r.fake().canUseTool('req-5', 'Bash', { command: 'ls' }, 'toolu_5');
    await until(() => r.registry!.list().pending.length === 1);
    r.fake().exit(1, null);
    await until(() => r.host.statusForPane(PANE) === 'stopped');
    await until(() => r.registry!.list().pending.length === 0);
    expect(r.host.bindingForPane(PANE)!.error).toMatchObject({ code: 'driver-failed' });
    expect(r.host.sessionForPane(PANE)!.busy).toBeFalsy();
    await r.host.dispose();
  });

  it('leaves no orphan across a daemon restart, and kills only an identity match', async () => {
    const first = rig();
    await created(first);
    await sent(first);
    const pid = first.fake().pid!;
    const providerSessionId = first.host.bindingForPane(PANE)!.providerSessionId!;
    // The daemon dies without disposing: the record still names the process.

    const mismatch = rig();
    mismatch.identity.value = { startTime: 'start-1', commandLine: 'claude -p --resume someone-else' };
    await mismatch.host.start();
    expect(mismatch.killed).toEqual([]);

    // A second crash of the same record: the first restart cleared the
    // process, so write it back the way the crashed daemon left it.
    const file = path.join(dir, 'chat-sessions', 'v2', `${first.host.bindingForPane(PANE)!.chatSessionId}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.process = { pid, startTime: 'start-1', marker: providerSessionId };
    fs.writeFileSync(file, JSON.stringify(stored));
    const matching = rig();
    matching.identity.value = { startTime: 'start-1', commandLine: `claude -p --session-id ${providerSessionId}` };
    await matching.host.start();
    expect(matching.killed).toEqual([pid]);
    expect(matching.host.statusForPane(PANE)).toBe('stopped');
    const session = matching.host.sessionForPane(PANE)!;
    expect(session.busy).toBeFalsy();
    expect(session.blocks[0]).toMatchObject({ role: 'user', outcome: 'failed' });
    // The next send resumes the same conversation.
    expect(await sent(matching, 'resume me', 'msg-00009')).toMatchObject({ ok: true });
    expect(matching.fake().args.join(' ')).toContain(`--resume ${providerSessionId}`);
    await first.fake().exit(0, null);
    await matching.host.dispose();
  });

  it('drops a socket that cannot take a push', async () => {
    const r = rig();
    await r.host.call('subscribe', { paneId: PANE }, 'gone');
    r.sockets.set('gone', false);
    await created(r);
    r.sockets.set('gone', true);
    await sent(r);
    await tick(150);
    expect(r.pushes.filter((p) => p.clientId === 'gone')).toHaveLength(0);
    await r.host.dispose();
  });

  it('serves a capped body in full', async () => {
    const r = rig();
    const binding = await created(r);
    await sent(r);
    const big = 'x'.repeat(40 * 1024);
    r.fake().out({ type: 'stream_event', session_id: 's', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: big } } });
    r.fake().result();
    await until(() => r.host.statusForPane(PANE) === 'idle');
    const block = r.host.sessionForPane(PANE)!.blocks.find((b) => b.role === 'assistant')!;
    expect(block.overflow?.text).toBe(true);
    const body = await r.host.call('bodies', { paneId: PANE, chatSessionId: binding.chatSessionId, epoch: binding.epoch, blockId: block.id, field: 'text' }, 'main');
    expect(body).toEqual({ ok: true, text: big });
    await r.host.dispose();
  });

  it('keeps the managed-chat respond path away from a chat-v2 pane', async () => {
    const r = rig();
    await created(r);
    const service = new ChatSessionService({ directory: dir, providers: [], pane: () => undefined, changed: () => undefined });
    await expect(service.respond(PANE, 'n', 'req', {})).resolves.toEqual({ ok: false, error: 'Answer this request in chat' });
    const binding = r.host.bindingForPane(PANE)!;
    await r.host.call('close', { paneId: PANE, chatSessionId: binding.chatSessionId }, 'main');
    await expect(service.respond(PANE, 'n', 'req', {})).resolves.toEqual({ ok: false, error: 'Request expired or session changed' });
    await r.host.dispose();
  });
});
