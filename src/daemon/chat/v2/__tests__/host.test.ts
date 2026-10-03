import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatV2EventsPush } from '../../../../shared/chatv2/ipc';
import { ApprovalRegistry } from '../../../approvals/ApprovalRegistry';
import { DECISION_V2_WEB_ANSWER } from '../../../approvals/types';
import type { DaemonEvent } from '../../../../shared/rpc';
import { ChatSessionService } from '../../ChatSessionService';
import { ChildBackend } from '../childBackend';
import { ClaudeDriver } from '../claude/claudeDriver';
import { createChatV2Host } from '../host';
import type { ChatV2Host, ChatV2HostDeps } from '../types';
import { FakeClaude, tick, until } from './fakeClaude';

// The login-shell PATH probe would run the user's real shell.
vi.mock('../../../../shared/execEnv', () => ({
  agentExecEnv: async (env: NodeJS.ProcessEnv) => ({ ...env, PATH: `${env.PATH ?? ''}:/opt/login/bin` }),
}));

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
  dropped: string[];
  /** Set to a promise to hold paneFree until it settles. */
  paneGate: { value: Promise<void> | null };
  backends: ChildBackend[];
  fake(): FakeClaude;
}

const PANE_ENV = { PATH: '/usr/bin', WMUX_WORKSPACE_ID: 'ws-1', CLAUDECODE: '1', WMUX_AUTH_TOKEN: 'x' };

function rig(options: { registry?: boolean; nativeOn?: boolean; paneEnv?: Record<string, string>; stubborn?: boolean } = {}): Rig {
  const r = {
    fakes: [] as FakeClaude[],
    pushes: [] as Rig['pushes'],
    clock: { now: 100_000 },
    paneFree: { value: true },
    sockets: new Map<string, boolean>(),
    identity: { value: { startTime: 'start-1', commandLine: '' } as { startTime: string; commandLine: string } | null },
    killed: [] as number[],
    dropped: [] as string[],
    paneGate: { value: null },
    backends: [] as ChildBackend[],
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
        ? { meta: { spawnCwd: dir, env: options.paneEnv ?? PANE_ENV } }
        : undefined)) as unknown as ChatV2HostDeps['sessionManager']['getSession'],
    },
    approvals: () => r.registry,
    paneFree: async () => {
      await r.paneGate.value;
      return r.paneFree.value;
    },
    writeToPane: () => true,
    sendTo: (clientId: string, event: DaemonEvent) => {
      if (r.sockets.get(clientId) === false) return false;
      r.pushes.push({ clientId, push: event.data as ChatV2EventsPush });
      return true;
    },
    dropClient: (clientId) => r.dropped.push(clientId),
    processIdentity: async () => r.identity.value,
    killTree: async (pid) => { r.killed.push(pid); },
    drivers: () => {
      const fake = new FakeClaude();
      fake.stubborn = options.stubborn ?? false;
      r.fakes.push(fake);
      const backend = fake.backend();
      r.backends.push(backend);
      return new ClaudeDriver({ settingSources: 'project', command: 'claude', backend });
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

  it('keeps a card answerable from the desktop when native phone decisions are off', async () => {
    const r = rig({ nativeOn: false });
    const binding = await created(r);
    await sent(r);
    r.fake().canUseTool('req-3', 'Bash', { command: 'ls' }, 'toolu_3');
    await until(() => r.host.statusForPane(PANE) === 'needs-input');
    expect(r.fake().responses('req-3')).toHaveLength(0);
    // The phone sees a view-only card it cannot answer.
    const record = r.registry!.list().pending[0];
    r.clock.now += 2_000;
    const phone = await r.registry!.resolve({ id: record.id, decision: 'approve', resolvedBy: 'web', decisionV2Answer: DECISION_V2_WEB_ANSWER, decisionAnswer: { formFingerprint: 'x', clientAnswerId: 'p', action: 'approve' } });
    expect(phone).toMatchObject({ ok: false, reason: 'answer-in-terminal' });
    r.clock.now -= 2_000;
    const answer = (decision: 'allow' | 'deny') => r.host.call('answer', { paneId: PANE, chatSessionId: binding.chatSessionId, requestId: 'req-3', decision }, 'main');
    expect(await answer('allow')).toMatchObject({ ok: false, error: { message: 'answer-too-soon' } });
    r.clock.now += 2_000;
    const [first, second] = await Promise.all([answer('allow'), answer('deny')]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    await tick(10);
    expect(r.fake().responses('req-3')).toEqual([{ behavior: 'allow', updatedInput: { command: 'ls' } }]);
    await until(() => r.registry!.list().pending.length === 0);
    expect(r.host.sessionForPane(PANE)!.blocks.find((b) => b.approval)!.approval!.decided).toBe('allow');
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
    expect(r.dropped).toContain('gone');
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

  it('keeps full bodies across a turn end, the next save and a reload, served in pages', async () => {
    const r = rig();
    const binding = await created(r);
    await sent(r);
    const big = Array.from({ length: 300 * 1024 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    r.fake().out({ type: 'stream_event', session_id: 's', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: big } } });
    r.fake().result();
    await until(() => r.host.statusForPane(PANE) === 'idle');
    // A second turn saves the record again from a rebased (capped) shadow.
    await sent(r, 'again', 'msg-00002');
    r.fake().result();
    await until(() => r.host.statusForPane(PANE) === 'idle');
    const block = r.host.sessionForPane(PANE)!.blocks.find((b) => b.role === 'assistant')!;
    const read = async (host: ChatV2Host, epoch: string): Promise<string> => {
      let text = '';
      let offset: number | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await host.call('bodies', { paneId: PANE, chatSessionId: binding.chatSessionId, epoch, blockId: block.id, field: 'text', ...(offset !== undefined ? { offset } : {}) }, 'main');
        if (!res.ok) throw new Error(res.error.code);
        expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThan(1024 * 1024);
        text += res.text;
        if (res.nextOffset === undefined) return text;
        offset = res.nextOffset;
      }
      throw new Error('too many pages');
    };
    expect(await read(r.host, r.host.bindingForPane(PANE)!.epoch)).toBe(big);
    await r.host.dispose();
    const reloaded = rig();
    await reloaded.host.start();
    expect(await read(reloaded.host, reloaded.host.bindingForPane(PANE)!.epoch)).toBe(big);
    await reloaded.host.dispose();
  });

  it('runs the driver with the pane credentials and endpoint, without nesting markers, on the login PATH', async () => {
    const r = rig({ paneEnv: {
      ...PANE_ENV,
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      AI_AGENT: 'claude',
    } });
    await created(r);
    const env = r.fake().env;
    expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'https://gateway.example', CLAUDE_CODE_USE_BEDROCK: '1' });
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'WMUX_AUTH_TOKEN']) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe('/usr/bin:/opt/login/bin');
    await r.host.dispose();
  });

  it('refuses to start on a pane account whose folder is gone, instead of the default account', async () => {
    const r = rig({ paneEnv: { ...PANE_ENV, CLAUDE_CONFIG_DIR: path.join(dir, 'no-such-account') } });
    const res = await r.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' }, 'main');
    expect(res).toMatchObject({ ok: false, error: { code: 'driver-unavailable' } });
    expect(r.fakes).toHaveLength(0);
  });

  it('leaves no driver when a close lands while the pane check or the start is pending', async () => {
    const r = rig();
    const binding = await created(r);
    r.fake().exit(1, null);
    await until(() => r.host.statusForPane(PANE) === 'stopped');
    let release!: () => void;
    r.paneGate.value = new Promise<void>((resolve) => { release = resolve; });
    const sending = sent(r);
    await tick(10);
    expect(await r.host.call('close', { paneId: PANE, chatSessionId: binding.chatSessionId }, 'main')).toEqual({ ok: true });
    release();
    expect(await sending).toMatchObject({ ok: false });
    expect(r.fakes).toHaveLength(1);

    // dispose while a create waits on the pane check
    const other = rig();
    let releaseOther!: () => void;
    other.paneGate.value = new Promise<void>((resolve) => { releaseOther = resolve; });
    const creating = other.host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' }, 'main');
    await tick(10);
    await other.host.dispose();
    releaseOther();
    expect(await creating).toMatchObject({ ok: false });
    expect(other.fakes).toHaveLength(0);
  });

  it('keeps a driver that did not exit, refuses to restart it, and lets go once it exits', async () => {
    const r = rig({ stubborn: true });
    const binding = await created(r);
    const closed = await r.host.call('close', { paneId: PANE, chatSessionId: binding.chatSessionId }, 'main');
    expect(closed).toMatchObject({ ok: false, error: { code: 'driver-failed' } });
    expect(r.host.statusForPane(PANE)).toBe('failed');
    expect(await sent(r)).toMatchObject({ ok: false, error: { code: 'driver-failed' } });
    const file = path.join(dir, 'chat-sessions', 'v2', `${binding.chatSessionId}.json`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).process).toMatchObject({ pid: r.fake().pid });
    r.fake().exit(0, null);
    await until(() => r.host.statusForPane(PANE) === 'stopped');
    expect(await r.host.call('close', { paneId: PANE, chatSessionId: binding.chatSessionId }, 'main')).toEqual({ ok: true });
  }, 15_000);

  it('records no process identity it could not read', async () => {
    const r = rig();
    r.identity.value = null;
    const binding = await created(r);
    const file = path.join(dir, 'chat-sessions', 'v2', `${binding.chatSessionId}.json`);
    await until(() => fs.existsSync(file));
    await tick(20);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).process).toBeUndefined();
    await r.host.dispose();
  });

  it('takes a send off the ledger when it was not delivered or not saved', async () => {
    const r = rig();
    const binding = await created(r);
    const backend = r.backends[0];
    const write = backend.write.bind(backend);
    backend.write = (line: string) => (line.includes('"type":"user"') ? Promise.reject(new Error('pipe')) : write(line));
    expect(await sent(r)).toMatchObject({ ok: false, error: { code: 'driver-failed' } });
    backend.write = write;
    // The same id is a new attempt, not a duplicate of a message that never left.
    const retried = await sent(r);
    expect(retried).toMatchObject({ ok: true });
    expect(retried).not.toHaveProperty('duplicate');
    r.fake().result();
    await until(() => r.host.statusForPane(PANE) === 'idle');

    // A directory where the record file goes: the save's rename onto it fails
    // on every platform (permissions do not make a folder read-only on Windows).
    const file = path.join(dir, 'chat-sessions', 'v2', `${binding.chatSessionId}.json`);
    await until(() => {
      try {
        fs.rmSync(file, { force: true });
        fs.mkdirSync(file);
        return true;
      } catch {
        return false; // a queued save landed in between; swap again
      }
    });
    try {
      const before = r.fake().stdin.filter((l) => l.type === 'user').length;
      expect(await sent(r, 'unsaved', 'msg-00003')).toMatchObject({ ok: false, error: { code: 'driver-failed' } });
      expect(r.fake().stdin.filter((l) => l.type === 'user').length).toBe(before);
    } finally {
      fs.rmdirSync(file);
    }
    expect(await sent(r, 'unsaved', 'msg-00003')).toMatchObject({ ok: true });
    await r.host.dispose();
  });

  it('follows a new provider session id and keeps the argv marker for the sweep', async () => {
    const r = rig();
    const binding = await created(r);
    await sent(r);
    const moved = '11111111-2222-4333-8444-555555555555';
    r.fake().out({ type: 'system', subtype: 'status', session_id: moved });
    await until(() => r.host.bindingForPane(PANE)!.providerSessionId === moved);
    const file = path.join(dir, 'chat-sessions', 'v2', `${binding.chatSessionId}.json`);
    await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).providerSessionId === moved);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).process.marker).toBe(binding.providerSessionId);
    await r.host.dispose();
  });
});
