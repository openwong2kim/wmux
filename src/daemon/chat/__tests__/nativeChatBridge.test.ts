import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptPage, TranscriptStatus } from '../../../shared/transcript/turnEvents';
import { ChatSendReceiptStore } from '../ChatSendReceiptStore';
import { ChatCancelReceiptStore } from '../ChatCancelReceiptStore';
import { ChatQueueStore } from '../ChatQueue';
import { createChatBridge, WEB_BRIDGE_CLIENT, type ChatAgentState, type ChatPane, type NativeChatBridgeDeps } from '../nativeChatBridge';
import type { TerminalChatAbortOutcome } from '../../transcript/TerminalChatService';
import { cancelResponse } from '../../web/chatWire';
import { OPENCODE_MAX_SEND_BYTES, fileHistoryEpoch, projectChatBlocked, tuiHistoryEpoch, type ChatQueueEvent } from '../chatBridge';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const msgId = () => `${Date.now()}-${randomUUID()}`;
const page = (epoch: string): TranscriptPage => ({ events: [], hasMore: false, truncatedHead: false,
  cursor: { historyEpoch: epoch, headOffset: 0, tailOffset: 0, fileSize: 0, mtimeMs: 0 } });
const FILE: TranscriptStatus = { available: true, reason: 'ok', agentSessionId: 'conv', transcriptBasename: 'a.jsonl',
  terminal: { kind: 'terminal', agent: 'claude', nativeSessionId: 'conv',
    capabilities: { history: true, send: false, permissions: false, cancel: false, fileUndo: false } } };
const TUI_STATUS: TranscriptStatus = { available: true, reason: 'ok', agentSessionId: 'ses_one', agentAlive: true, agentStatus: 'complete',
  terminal: { kind: 'terminal', agent: 'opencode', nativeSessionId: 'ses_one',
    capabilities: { history: true, send: true, permissions: false, cancel: false, fileUndo: false } } };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bridge-')); dirs.push(dir);
  const typed: string[] = [];
  const shell = { empty: true, revision: 0, escAt: 0, title: { title: '', at: 0 } };
  const pane: ChatPane = {
    meta: { id: 'pane', state: 'attached', pid: 100, cwd: '/live', env: {}, spawnCwd: '/spawn', incarnationId: 'inc' },
    bridge: { isEmptyShellPrompt: () => shell.empty, getInputRevision: () => shell.revision,
      noteInput: (data: string) => { shell.revision++; shell.empty = false; if (data === '\x1b') shell.escAt = Date.now(); }, getLastEscAt: () => shell.escAt, getTitle: () => shell.title },
    promptLog: { size: 3, isCommandRunning: () => false },
    ptyProcess: { write: (data) => { typed.push(data); } },
  };
  const agent: ChatAgentState = { agentName: null, agentVerified: false, agentStatus: 'idle', inputQuiet: true, inputRevision: 0, incarnationId: 'inc' };
  const state = {
    pane: pane as ChatPane | undefined,
    agent,
    projector: { available: false, reason: 'no-hook' } as TranscriptStatus,
    native: null as { status: TranscriptStatus; page: TranscriptPage } | null,
    pendingApproval: undefined as string | undefined,
    pendingKind: 'awaiting_input',
    pendingAnswerable: false,
    screen: ['● done', '', '❯ ', '  ? for shortcuts'] as string[] | null,
    idle: { ok: true } as Awaited<ReturnType<NativeChatBridgeDeps<ChatPane>['idleShell']>>,
    installed: ['claude', 'codex'] as ('claude' | 'codex')[],
  };
  type TuiOutcome = { result: 'sent' | 'unavailable' | 'unconfirmed' | 'error'; reason?: string };
  const tuiSend = vi.fn<(...args: unknown[]) => Promise<TuiOutcome>>(async () => ({ result: 'sent' }));
  const managed = { has: vi.fn(() => false), status: vi.fn(() => undefined as TranscriptStatus | undefined), snapshot: vi.fn(() => null),
    send: vi.fn(async () => 'sent' as const), conversationEpoch: vi.fn(() => 'm1:epoch') };
  const written: string[] = [];
  const notify = vi.fn(); const log = vi.fn();
  const subscribe = vi.fn(); const unsubscribe = vi.fn();
  const loadSkills = vi.fn(async () => ({ skills: [], state: 'ready' as const, reason: 'bridge-outdated' as const }));
  let aliveGate: Promise<void> | undefined;
  const deps: NativeChatBridgeDeps<ChatPane> = {
    pane: () => state.pane,
    agentState: () => ({ ...state.agent }),
    chatAgentState: () => ({ ...state.agent }),
    projector: { status: () => state.projector, snapshot: () => null },
    terminalChat: () => ({ read: async () => state.native, send: tuiSend as never, subscribe, unsubscribe }),
    managed: () => managed as never,
    approvals: () => ({ pendingFor: () => state.pendingApproval === undefined ? undefined
      : { id: state.pendingApproval, kind: state.pendingKind, answerable: state.pendingAnswerable } }),
    readScreen: async () => state.screen,
    agentProcessAlive: async () => { await aliveGate; return true; },
    write: (_id, data) => { written.push(data); state.agent.inputRevision++; if (data === '\x1b') shell.escAt = Date.now(); return true; },
    receipts: new ChatSendReceiptStore(dir),
    cancelReceipts: new ChatCancelReceiptStore(dir),
    idleShell: async () => state.idle,
    installedAgents: async () => state.installed.map(agent => ({ agent, models: [], efforts: [] })),
    relays: { retire: async () => undefined, prepare: async () => ({ url: 'unix:///tmp/relay.sock', commit: () => true, close: async () => undefined }),
      unavailable: () => false, selection: () => ({ cwd: '/thread' }) },
    startCodexRuntime: async () => undefined,
    loadSkills,
    log, notify,
    delay: async () => undefined,
    platform: 'darwin',
  };
  const liveClaude = () => {
    state.projector = FILE;
    state.agent = { ...state.agent, agentName: 'Claude Code', agentVerified: true, agentStatus: 'complete' };
  };
  return { bridge: createChatBridge(deps), deps, state, shell, typed, written, tuiSend, managed, notify, log, subscribe, unsubscribe,
    loadSkills, liveClaude, dir, gateAlive: (gate: Promise<void> | undefined) => { aliveGate = gate; } };
}

const phoneSend = (text = 'hello', extra: Record<string, unknown> = {}) =>
  ({ owner: 'device:a' as const, id: 'pane', agentSessionId: 'conv', historyEpoch: fileHistoryEpoch('claude', 'conv', 'a.jsonl'),
    clientMessageId: msgId(), text, managedReadOnly: true, ...extra });

describe('resolve', () => {
  it('follows the daemon order and never exposes the raw OpenCode epoch', async () => {
    const f = fixture();
    f.state.native = { status: TUI_STATUS, page: page('token-half:1:ses_one') };
    const tui = await f.bridge.resolve('pane');
    expect(tui).toMatchObject({ source: 'tui', epoch: tuiHistoryEpoch('token-half:1:ses_one'), rawEpoch: 'token-half:1:ses_one' });
    expect(tui.source === 'tui' && tui.epoch.includes('token-half')).toBe(false);

    f.state.native = { status: { available: false, reason: 'stale-session', agentAlive: true }, page: page('') };
    expect(await f.bridge.resolve('pane')).toMatchObject({ source: 'none', launch: { ready: false, reason: 'agent-running' } });

    f.state.native = null; f.state.agent.agentName = 'OpenCode';
    expect(await f.bridge.resolve('pane')).toMatchObject({ source: 'none', status: { available: false, reason: 'unavailable' },
      launch: { reason: 'agent-running' } });
  });

  it('names why an OpenCode pane is unreadable from the read itself, without changing its reason', async () => {
    const f = fixture(); f.state.agent.agentName = 'OpenCode';
    let failure: 'no-record' | 'transport-refused' | 'invalid-record' | 'owner-mismatch' | 'error' = 'no-record';
    const read = vi.fn(async () => null);
    f.deps.terminalChat = () => ({ read, send: f.tuiSend as never, subscribe: f.subscribe, unsubscribe: f.unsubscribe,
      inspect: async () => ({ failure }) });
    const bridge = createChatBridge(f.deps);
    expect(await bridge.resolve('pane')).toMatchObject({ source: 'none', status: { reason: 'unavailable' }, cause: 'opencode-plugin-missing' });
    failure = 'transport-refused';
    expect(await bridge.resolve('pane')).toMatchObject({ cause: 'opencode-plugin-unreachable' });
    for (failure of ['invalid-record', 'owner-mismatch', 'error'] as const) {
      expect(await bridge.resolve('pane')).not.toHaveProperty('cause');
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('picks a managed record only with no live agent and no transcript', async () => {
    const f = fixture();
    f.managed.has.mockReturnValue(true);
    f.managed.status.mockReturnValue({ available: true, reason: 'ok', agentSessionId: 'native-session' });
    expect(await f.bridge.resolve('pane')).toMatchObject({ source: 'managed', epoch: 'm1:epoch' });
    f.liveClaude();
    expect((await f.bridge.resolve('pane')).source).toBe('file');
  });

  it('overlays send on a file binding and binds its epoch to the native id and file', async () => {
    const f = fixture(); f.liveClaude();
    const file = await f.bridge.resolve('pane');
    expect(file).toMatchObject({ source: 'file', epoch: fileHistoryEpoch('claude', 'conv', 'a.jsonl'),
      status: { agentAlive: true, terminal: { capabilities: { send: true } } } });
    f.state.projector = { ...FILE, transcriptBasename: undefined };
    expect(await f.bridge.resolve('pane')).not.toHaveProperty('epoch');
    f.state.agent.agentVerified = false;
    expect(await f.bridge.resolve('pane')).toMatchObject({ source: 'file', status: { terminal: { capabilities: { send: false } } } });
  });

  it('serves the running episode only through turn(), never on the shared status', async () => {
    const f = fixture(); f.liveClaude();
    expect(f.bridge.turn('pane')).toBeUndefined();
    f.state.agent.turn = { id: 't1:abc.2', state: 'running', startedAt: 5 };
    expect(f.bridge.turn('pane')).toEqual({ id: 't1:abc.2', state: 'running', startedAt: 5 });
    expect((await f.bridge.resolve('pane')).status).not.toHaveProperty('turn');
    expect(await f.bridge.status('pane')).not.toHaveProperty('turn');
  });

  it('maps a live agent without a transcript to none/agent-running', async () => {
    const f = fixture(); f.state.agent.agentName = 'Codex CLI';
    expect(await f.bridge.resolve('pane')).toMatchObject({ source: 'none', launch: { ready: false, reason: 'agent-running' } });
  });

  it('previews launch readiness cheaply, in the launch order', async () => {
    const f = fixture();
    expect(await f.bridge.resolve('pane')).toMatchObject({ source: 'none',
      launch: { ready: true, reason: 'ok', agents: ['claude', 'codex'], maxPromptUnits: 2000 } });
    const reason = async () => (await f.bridge.resolve('pane') as { launch: { reason: string } }).launch.reason;
    f.shell.empty = false; expect(await reason()).toBe('shell-not-empty');
    f.state.pane!.promptLog.isCommandRunning = () => true; expect(await reason()).toBe('shell-busy');
    f.state.pendingApproval = 'apr_1'; expect(await reason()).toBe('approval-pending');
    (f.state.pane!.promptLog as { size: number }).size = 0; expect(await reason()).toBe('not-integrated');
    f.state.pane!.meta.exec = { command: 'htop' }; expect(await reason()).toBe('not-integrated');
    f.state.pane!.meta.wslTarget = { distro: 'Ubuntu' }; expect(await reason()).toBe('unsupported-shell');
  });

  it('keeps the desktop status answer as before', async () => {
    const f = fixture(); f.state.agent.agentName = 'OpenCode';
    expect(await f.bridge.status('pane')).toEqual({ available: false, reason: 'unavailable' });
    expect(await f.bridge.snapshot('pane')).toBeNull();
  });
});

describe('blocked', () => {
  it('prefers an approval, then awaiting input, then the send screen gate; never for a brain pane', async () => {
    const f = fixture(); f.liveClaude();
    expect(await f.bridge.blocked('pane', await f.bridge.resolve('pane'))).toBeUndefined();
    f.state.screen = ['Select model', '❯ 1. Sonnet', '  2. Opus', 'Esc to cancel'];
    expect(await f.bridge.blocked('pane', await f.bridge.resolve('pane'))).toEqual({ by: 'terminal' });
    f.state.agent.agentStatus = 'awaiting_input';
    expect(await f.bridge.blocked('pane', await f.bridge.resolve('pane'))).toEqual({ by: 'terminal' });
    f.state.pendingApproval = 'apr_1';
    expect(await f.bridge.blocked('pane', await f.bridge.resolve('pane'))).toEqual({ by: 'approval', approvalId: 'apr_1' });
    const resolved = await f.bridge.resolve('pane');
    f.state.pane!.meta.env = { WMUX_BRAIN_PTY: '1' };
    expect(await f.bridge.blocked('pane', resolved)).toBeUndefined();
    f.state.pane!.meta.env = {};
    expect(await f.bridge.blocked('brain-1', resolved)).toBeUndefined();
  });
});

describe('send', () => {
  it('submits on the file path and replays the stored verdict for the same id', async () => {
    const f = fixture(); f.liveClaude();
    const req = phoneSend();
    expect(await f.bridge.send(req)).toMatchObject({ result: 'sent', effect: 'submitted', replayed: false });
    expect(f.written).toEqual(['\x1b[200~hello\x1b[201~', '\r']);
    expect(await f.bridge.send(req)).toMatchObject({ result: 'sent', effect: 'submitted', replayed: true });
    expect(await f.bridge.send({ ...req, text: 'other' })).toMatchObject({ error: 'message-id-conflict', effect: 'none' });
    expect(f.bridge.receipt('device:a', 'pane', req.clientMessageId)).toMatchObject({ state: 'submitted', result: 'sent' });
    expect(f.bridge.receipt('device:b', 'pane', req.clientMessageId).state).toBe('unknown');
    expect(f.written).toHaveLength(2);
  });

  it('dispatches once for two concurrent sends with the same id', async () => {
    const f = fixture(); f.liveClaude();
    let release!: () => void; f.gateAlive(new Promise<void>(resolve => { release = resolve; }));
    const req = phoneSend();
    const first = f.bridge.send(req);
    const second = f.bridge.send(req);
    expect(await second).toEqual({ clientMessageId: req.clientMessageId, replayed: true, pending: true });
    expect(f.bridge.receipt('device:a', 'pane', req.clientMessageId).state).toBe('pending');
    release();
    expect(await first).toMatchObject({ result: 'sent', effect: 'submitted' });
    expect(f.written.filter(w => w.startsWith('\x1b[200~'))).toHaveLength(1);
  });

  it('replays sent after the binding became none (agent exited)', async () => {
    const f = fixture(); f.liveClaude();
    const req = phoneSend();
    await f.bridge.send(req);
    f.state.projector = { available: false, reason: 'no-hook' }; f.state.agent.agentName = null;
    expect(await f.bridge.send(req)).toMatchObject({ result: 'sent', replayed: true, effect: 'submitted' });
    expect(await f.bridge.send(phoneSend())).toMatchObject({ error: 'no-conversation', effect: 'none' });
  });

  it('reports none when the grant is withdrawn before the paste, uncertain with no Enter when before Enter', async () => {
    const f = fixture(); f.liveClaude();
    expect(await f.bridge.send(phoneSend('a', { authorized: async () => false })))
      .toMatchObject({ error: 'authorization-expired', result: 'error', effect: 'none' });
    expect(f.written).toEqual([]);
    let calls = 0;
    const req = phoneSend('b', { authorized: async () => ++calls === 1 });
    expect(await f.bridge.send(req)).toMatchObject({ error: 'authorization-expired', result: 'error', effect: 'uncertain' });
    expect(f.written).toEqual(['\x1b[200~b\x1b[201~']);
    expect(f.bridge.receipt('device:a', 'pane', req.clientMessageId).state).toBe('uncertain');
  });

  it('tells the caller which write each re-authorization guards', async () => {
    const f = fixture(); f.liveClaude();
    const stages: unknown[] = [];
    const authorized = async (stage?: string) => { stages.push(stage); return true; };
    expect(await f.bridge.send(phoneSend('a', { authorized }))).toMatchObject({ result: 'sent' });
    f.state.projector = { available: false, reason: 'no-hook' }; f.state.agent.agentName = null;
    expect(await f.bridge.launch({ id: 'pane', agent: 'claude', prompt: 'go', authorized })).toMatchObject({ ok: true });
    expect(stages).toEqual(['first-write', 'submit', 'first-write']);
  });

  it('refuses before any receipt: bad ids, blank or long text, identity changes, no conversation, managed', async () => {
    const f = fixture(); f.liveClaude();
    expect(await f.bridge.send(phoneSend('x', { clientMessageId: 'nope' }))).toMatchObject({ error: 'invalid-chat-request', effect: 'none' });
    expect(await f.bridge.send(phoneSend('x', { clientMessageId: `${Date.now() - 25 * 3600_000}-${randomUUID()}` })))
      .toMatchObject({ error: 'message-id-expired', effect: 'none' });
    expect(await f.bridge.send(phoneSend('  '))).toMatchObject({ error: 'invalid-chat-request' });
    expect(await f.bridge.send(phoneSend('x'.repeat(16_001)))).toMatchObject({ error: 'text-too-long', limit: 'units' });
    expect(await f.bridge.send(phoneSend('x', { historyEpoch: 'h1:stale' })))
      .toMatchObject({ error: 'session-changed', effect: 'none', agentSessionId: 'conv', historyEpoch: fileHistoryEpoch('claude', 'conv', 'a.jsonl') });
    expect(await f.bridge.send(phoneSend('x', { agentSessionId: 'other' }))).toMatchObject({ error: 'session-changed' });
    f.state.agent.agentVerified = false;
    expect(await f.bridge.send(phoneSend())).toMatchObject({ error: 'chat-unavailable', effect: 'none' });
    f.state.projector = { available: false, reason: 'no-hook' }; f.state.agent.agentName = null;
    f.managed.has.mockReturnValue(true); f.managed.status.mockReturnValue({ available: true, reason: 'ok', agentSessionId: 'conv' });
    expect(await f.bridge.send(phoneSend())).toMatchObject({ error: 'managed-read-only', effect: 'none' });
    expect(f.managed.send).not.toHaveBeenCalled();
    expect(f.written).toEqual([]);
  });

  it('maps the file results the phone must tell apart', async () => {
    const f = fixture(); f.liveClaude();
    f.state.agent.agentStatus = 'idle';
    expect(await f.bridge.send(phoneSend())).toMatchObject({ error: 'input-not-provably-empty', result: 'unconfirmed', effect: 'none' });
    f.state.agent.agentStatus = 'complete'; f.state.screen = ['Select', '❯ 1. Yes', '  2. No'];
    expect(await f.bridge.send(phoneSend())).toMatchObject({ error: 'chat-blocked', blockedBy: 'terminal', effect: 'none' });
    f.state.screen = ['❯ ']; f.state.pendingApproval = 'apr_1';
    expect(await f.bridge.send(phoneSend())).toMatchObject({ error: 'chat-blocked', blockedBy: 'approval', effect: 'none' });
    f.state.pendingApproval = undefined;
    // Human input between paste and Enter: the paste may be visible.
    const deps = f.deps; const original = deps.write;
    deps.write = (id, data) => { const ok = original(id, data); f.state.agent.inputRevision++; return ok; };
    expect(await f.bridge.send(phoneSend())).toMatchObject({ error: 'send-interrupted', result: 'error', effect: 'uncertain' });
  });

  it('checks the OpenCode byte budget and epoch before anything reaches the plugin', async () => {
    const f = fixture();
    f.state.native = { status: TUI_STATUS, page: page('raw:1:ses_one') };
    const tui = (text: string, extra: Record<string, unknown> = {}) =>
      phoneSend(text, { agentSessionId: 'ses_one', historyEpoch: tuiHistoryEpoch('raw:1:ses_one'), ...extra });
    expect(await f.bridge.send(tui('가'.repeat(9000))))
      .toMatchObject({ error: 'text-too-long', limit: 'bytes', maxSendBytes: OPENCODE_MAX_SEND_BYTES, effect: 'none' });
    expect(f.tuiSend).not.toHaveBeenCalled();
    const req = tui('hi');
    expect(await f.bridge.send(req)).toMatchObject({ result: 'sent', effect: 'submitted' });
    expect(f.tuiSend).toHaveBeenCalledWith('pane', 'ses_one', 'hi', req.clientMessageId, expect.objectContaining({ expectedRawEpoch: 'raw:1:ses_one' }));
    f.tuiSend.mockResolvedValueOnce({ result: 'unavailable', reason: 'receipts-full' });
    expect(await f.bridge.send(tui('a'))).toMatchObject({ error: 'opencode-receipts-full', result: 'unavailable', effect: 'none' });
    f.tuiSend.mockResolvedValueOnce({ result: 'unavailable' });
    expect(await f.bridge.send(tui('b'))).toMatchObject({ error: 'chat-unavailable', effect: 'none' });
    f.tuiSend.mockResolvedValueOnce({ result: 'unconfirmed', reason: 'transport-lost' });
    expect(await f.bridge.send(tui('c'))).toMatchObject({ error: 'delivery-unconfirmed', effect: 'uncertain' });
    f.tuiSend.mockResolvedValueOnce({ result: 'error', reason: 'unauthorized' });
    expect(await f.bridge.send(tui('d'))).toMatchObject({ error: 'authorization-expired', effect: 'none' });
  });

  it('answers chat-persist-failed and message-history-full without writing', async () => {
    const f = fixture(); f.liveClaude();
    const failing = createChatBridge({ ...f.deps, receipts: new ChatSendReceiptStore(f.dir, { write: () => { throw new Error('disk'); } }) });
    expect(await failing.send(phoneSend())).toMatchObject({ error: 'chat-persist-failed', effect: 'none' });
    const full = createChatBridge({ ...f.deps, receipts: new ChatSendReceiptStore(fs.mkdtempSync(path.join(f.dir, 'x')), { limit: 0 }) });
    expect(await full.send(phoneSend())).toMatchObject({ error: 'message-history-full', effect: 'none' });
    const none = createChatBridge({ ...f.deps, receipts: null });
    expect(await none.send(phoneSend())).toMatchObject({ error: 'chat-persist-failed' });
    expect(f.written).toEqual([]);
  });

  it('desktop: a full or unwritable receipt store falls back to dispatch without dedup', async () => {
    const f = fixture(); f.liveClaude();
    const failing = createChatBridge({ ...f.deps, receipts: new ChatSendReceiptStore(f.dir, { write: () => { throw new Error('disk'); } }) });
    expect(await failing.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'a', requestId: msgId() }))
      .toEqual({ result: 'sent', effect: 'submitted', replayed: false });
    const full = createChatBridge({ ...f.deps, receipts: new ChatSendReceiptStore(fs.mkdtempSync(path.join(f.dir, 'x')), { limit: 0 }) });
    expect(await full.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'b', requestId: msgId() }))
      .toEqual({ result: 'sent', effect: 'submitted', replayed: false });
    expect(f.written).toEqual(['\x1b[200~a\x1b[201~', '\r', '\x1b[200~b\x1b[201~', '\r']);
  });

  it('desktop: mints an id for a legacy request id and keeps the desktop result enum', async () => {
    const f = fixture(); f.liveClaude();
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'hi', requestId: randomUUID() }))
      .toEqual({ result: 'sent', effect: 'submitted', replayed: false });
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'x'.repeat(16_001), requestId: undefined }))
      .toMatchObject({ result: 'error', effect: 'none' });
    f.state.projector = { available: false, reason: 'no-hook' }; f.state.agent.agentName = null;
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'hi', requestId: msgId() }))
      .toMatchObject({ result: 'unavailable', effect: 'none' });
    // Desktop managed sends keep their own receipts, keyed by the verbatim request id.
    f.managed.has.mockReturnValue(true); f.managed.status.mockReturnValue({ available: true, reason: 'ok', agentSessionId: 'conv' });
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'hi', requestId: 'legacy-1' }))
      .toMatchObject({ result: 'sent', effect: 'submitted' });
    expect(f.managed.send).toHaveBeenCalledWith('pane', 'conv', 'hi', 'legacy-1');
  });

  // Claude Code 2.1 composer: the prompt row between two rules, nothing typed.
  const RULE = '─'.repeat(40);
  it('marks a send Claude accepted mid-turn as queued, in the answer, the replay and the receipt', async () => {
    const f = fixture(); f.liveClaude();
    f.state.agent.agentStatus = 'running';
    f.state.screen = ['✢ Effecting… (9s · thinking)', RULE, '❯ ', RULE];
    const req = phoneSend('then this');
    expect(await f.bridge.send(req)).toMatchObject({ result: 'sent', effect: 'submitted', queued: true });
    expect(f.written).toEqual(['\x1b[200~then this\x1b[201~', '\r']);
    expect(await f.bridge.send(req)).toMatchObject({ result: 'sent', replayed: true, queued: true });
    expect(f.bridge.receipt('device:a', 'pane', req.clientMessageId)).toMatchObject({ state: 'submitted', queued: true });
    expect(f.bridge.sendInFlight('pane')).toBe(false);
    // A draft in the running composer is never joined.
    f.state.screen = [RULE, '❯ half-typed', RULE];
    expect(await f.bridge.send(phoneSend())).toMatchObject({ error: 'chat-busy', effect: 'none' });
    // An idle agent is submitted, not queued.
    f.state.agent.agentStatus = 'complete'; f.state.screen = ['● done', RULE, '❯ ', RULE];
    const idle = await f.bridge.send(phoneSend());
    expect(idle).toMatchObject({ result: 'sent', effect: 'submitted' });
    expect(idle).not.toHaveProperty('queued');
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'more', requestId: msgId() })).not.toHaveProperty('queued');
  });

  it('desktop: pastes image paths first, fingerprints them, and is uncertain once one was pasted', async () => {
    const f = fixture(); f.liveClaude();
    f.state.screen = ['● done', RULE, '❯ ', RULE];
    // Text-only fingerprints stay what stored receipts were written with.
    expect(ChatSendReceiptStore.fingerprint('pane', 'conv', undefined, 'hi', []))
      .toBe(ChatSendReceiptStore.fingerprint('pane', 'conv', undefined, 'hi'));
    const requestId = msgId();
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'look', requestId, attachments: ['/tmp/a.png'] }))
      .toEqual({ result: 'sent', effect: 'submitted', replayed: false });
    expect(f.written).toEqual(['\x1b[200~/tmp/a.png\x1b[201~', '\x1b[200~ look\x1b[201~', '\r']);
    // The same id with other images is a different message, not a replay.
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'look', requestId, attachments: ['/tmp/b.png'] }))
      .toMatchObject({ result: 'error', effect: 'none', replayed: false });
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'look', requestId, attachments: ['/tmp/a.png'] }))
      .toMatchObject({ result: 'sent', replayed: true });
    expect(f.written).toHaveLength(3);

    // Typing lands after the first image path: nothing more is written, and the send is uncertain.
    const deps = f.deps; const original = deps.write;
    deps.write = (id, data) => { const ok = original(id, data); f.state.agent.inputRevision++; return ok; };
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'look', requestId: msgId(), attachments: ['/tmp/a.png', '/tmp/b.png'] }))
      .toMatchObject({ result: 'error', effect: 'uncertain' });
    expect(f.written).toHaveLength(4);
    deps.write = original;

    // No attachment input on an OpenCode TUI binding: refused before the plugin.
    f.state.native = { status: TUI_STATUS, page: page('raw:1:ses_one') };
    expect(await f.bridge.desktopSend({ id: 'pane', agentSessionId: 'ses_one', text: 'look', requestId: msgId(), attachments: ['/tmp/a.png'] }))
      .toMatchObject({ result: 'unavailable', effect: 'none' });
    expect(f.tuiSend).not.toHaveBeenCalled();
  });
});

describe('launch', () => {
  it('types the fixed launcher once and consumes the empty prompt', async () => {
    const f = fixture();
    expect(await f.bridge.launch({ id: 'pane', agent: 'claude', prompt: "it's done" })).toEqual({ ok: true, effect: 'submitted' });
    expect(f.typed).toEqual(["claude -- 'it'\\''s done'\r"]);
    expect(await f.bridge.launch({ id: 'pane', agent: 'claude', prompt: 'again' }))
      .toMatchObject({ ok: false, error: 'launch-not-ready', reason: 'shell-not-empty', effect: 'none' });
  });

  it('routes Codex through the relay', async () => {
    const f = fixture();
    expect(await f.bridge.launch({ id: 'pane', agent: 'codex', prompt: 'go', mode: 'yolo' })).toMatchObject({ ok: true });
    expect(f.typed).toEqual(["codex --remote unix:///tmp/relay.sock --dangerously-bypass-approvals-and-sandbox -- 'go'\r"]);
  });

  it('names each refusal', async () => {
    const f = fixture();
    const go = (extra: Record<string, unknown> = {}) => f.bridge.launch({ id: 'pane', agent: 'claude', prompt: 'go', ...extra });
    expect(await go({ prompt: 'bad\x07' })).toMatchObject({ error: 'invalid-chat-request', effect: 'none' });
    expect(await go({ mode: 'yolo' })).toMatchObject({ error: 'invalid-chat-request' });
    f.state.idle = { ok: false, reason: 'shell-has-children' };
    expect(await go()).toMatchObject({ error: 'launch-unsupported', reason: 'shell-has-children', effect: 'none' });
    f.state.idle = { ok: false, reason: 'unsupported-shell' };
    expect(await go()).toMatchObject({ error: 'launch-unsupported', reason: 'unsupported-shell' });
    f.state.idle = { ok: true }; f.state.installed = ['codex'];
    expect(await go()).toMatchObject({ error: 'agent-not-installed' });
    f.state.installed = ['claude', 'codex'];
    f.state.pendingApproval = 'apr';
    expect(await go()).toMatchObject({ error: 'launch-not-ready', reason: 'approval-pending' });
    f.state.pendingApproval = undefined; f.liveClaude();
    expect(await go({ refuseConversation: true })).toMatchObject({ error: 'conversation-exists' });
    f.state.pane!.meta.wslTarget = { distro: 'Ubuntu' };
    f.state.projector = { available: false, reason: 'no-hook' }; f.state.agent.agentName = null;
    expect(await go()).toMatchObject({ error: 'launch-unsupported', reason: 'unsupported-shell' });
    expect(f.typed).toEqual([]);
  });

  it('refuses while another launch runs, and when the runtime cannot start', async () => {
    const f = fixture();
    let release!: () => void;
    f.deps.idleShell = () => new Promise(resolve => { release = () => resolve({ ok: true }); });
    const slow = createChatBridge(f.deps);
    const first = slow.launch({ id: 'pane', agent: 'claude', prompt: 'one' });
    expect(await slow.launch({ id: 'pane', agent: 'claude', prompt: 'two' })).toMatchObject({ error: 'launch-pending' });
    expect(await slow.resolve('pane')).toMatchObject({ launch: { reason: 'launch-pending' } });
    f.deps.idleShell = async () => ({ ok: true });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(f.typed).toHaveLength(1);
    const g = fixture();
    g.deps.relays.prepare = async () => { throw Object.assign(new Error('no socket'), { code: 'ENOENT' }); };
    g.deps.relays.unavailable = () => true;
    g.deps.startCodexRuntime = async () => { throw new Error('no runtime'); };
    expect(await createChatBridge(g.deps).launch({ id: 'pane', agent: 'codex', prompt: 'go' })).toMatchObject({ error: 'agent-runtime-unavailable', effect: 'none' });
  });

  it('starts the shared Codex runtime with no WMUX_* key', async () => {
    const f = fixture();
    f.state.pane!.meta.env = { WMUX_WORKSPACE_ID: 'ws-a', WMUX_WORKSPACE_NAME: 'A', WMUX_SURFACE_ID: 'sf-a',
      WMUX_PTY_ID: 'pty-a', WMUX_MEMBER_ID: 'pty-a', WMUX_BRAIN_PTY: '1', WMUX_DATA_SUFFIX: '-demo', KEEP_ME: 'yes' };
    let prepared = 0;
    f.deps.relays.prepare = async () => {
      if (prepared++ === 0) throw Object.assign(new Error('no socket'), { code: 'ENOENT' });
      return { url: 'unix:///tmp/relay.sock', commit: () => true, close: async () => undefined };
    };
    f.deps.relays.unavailable = () => true;
    const started: NodeJS.ProcessEnv[] = [];
    f.deps.startCodexRuntime = async (env) => { started.push(env); };
    expect(await createChatBridge(f.deps).launch({ id: 'pane', agent: 'codex', prompt: 'go' })).toMatchObject({ ok: true });
    expect(started).toHaveLength(1);
    expect(Object.keys(started[0]).filter((k) => k.startsWith('WMUX_'))).toEqual([]);
    expect(started[0]).toMatchObject({ KEEP_ME: 'yes' });
  });

  it('types nothing when the grant is gone, and is uncertain when typing throws', async () => {
    const f = fixture();
    expect(await f.bridge.launch({ id: 'pane', agent: 'claude', prompt: 'go', authorized: async () => false }))
      .toMatchObject({ error: 'authorization-expired', effect: 'none' });
    expect(f.typed).toEqual([]);
    f.state.pane!.ptyProcess.write = () => { throw new Error('EIO'); };
    expect(await f.bridge.launch({ id: 'pane', agent: 'claude', prompt: 'go' })).toMatchObject({ error: 'launch-unconfirmed', effect: 'uncertain' });
  });
});

describe('skills, watch and trace', () => {
  it('uses spawnCwd for the phone, the relay thread cwd for Codex, and the live cwd for the desktop', async () => {
    const f = fixture();
    expect(await f.bridge.skills('pane', 'claude')).toEqual({ skills: [], state: 'ready', reason: 'bridge-outdated' });
    expect(f.loadSkills).toHaveBeenLastCalledWith('claude', '/spawn', expect.any(Object));
    await f.bridge.skills('pane', 'codex');
    expect(f.loadSkills).toHaveBeenLastCalledWith('codex', '/thread', expect.any(Object));
    await f.bridge.desktopSkills('pane', 'claude');
    expect(f.loadSkills).toHaveBeenLastCalledWith('claude', '/live', expect.any(Object));
    f.state.pane!.meta.spawnCwd = undefined;
    expect(await f.bridge.skills('pane', 'claude')).toEqual({ skills: [], state: 'unavailable' });
    f.state.agent.agentName = 'Codex CLI';
    expect(await f.bridge.desktopSkills('pane', 'claude')).toEqual({ skills: [], state: 'unavailable' });
  });

  it('watches OpenCode under the synthetic web client key', () => {
    const f = fixture();
    f.bridge.watch('pane'); f.bridge.unwatch('pane');
    expect(f.subscribe).toHaveBeenCalledWith(WEB_BRIDGE_CLIENT, 'pane');
    expect(f.unsubscribe).toHaveBeenCalledWith(WEB_BRIDGE_CLIENT, 'pane');
  });

  it('logs every dangerous launch and notifies the host only when it reached typing', () => {
    const f = fixture();
    const trace = { at: 1, owner: 'device:a' as const, paneId: 'pane', agent: 'codex' as const, mode: 'yolo' as const, clientLaunchId: 'x' };
    f.bridge.traceDangerousLaunch({ ...trace, outcome: 'dangerous-mode-unconfirmed' });
    expect(f.notify).not.toHaveBeenCalled();
    f.bridge.traceDangerousLaunch({ ...trace, outcome: 'submitted' });
    expect(f.notify).toHaveBeenCalledWith('pane', expect.any(String), expect.stringContaining('Codex with approvals and sandbox off'));
    expect(f.log).toHaveBeenCalledTimes(2);
    expect(f.log.mock.calls[0][1]).toMatch(/^\[chat\] dangerous-launch \{/);
  });
});

describe('a terminal_prompt record: reported as the terminal, fenced like any approval', () => {
  it('reads as blocked by the terminal, with no approvalId to act on', async () => {
    const f = fixture(); f.liveClaude();
    f.state.pendingApproval = 'apr_t'; f.state.pendingKind = 'terminal_prompt';
    const blocked = await f.bridge.blocked('pane', await f.bridge.resolve('pane'));
    expect(blocked).toMatchObject({ by: 'terminal' });
    expect(blocked).not.toHaveProperty('approvalId');
    // What reaches the wire for either kind of caller, for a non-answerable record.
    expect(projectChatBlocked(blocked, { terminalPromptAnswer: false })).toEqual({ by: 'terminal' });
    expect(projectChatBlocked(blocked, { terminalPromptAnswer: true })).toEqual({ by: 'terminal' });
    f.state.pendingKind = 'awaiting_permission';
    expect(await f.bridge.blocked('pane', await f.bridge.resolve('pane'))).toEqual({ by: 'approval', approvalId: 'apr_t' });
  });

  it('an answerable record reads as an approval only for a capable caller', async () => {
    const f = fixture(); f.liveClaude();
    f.state.pendingApproval = 'apr_t'; f.state.pendingKind = 'terminal_prompt'; f.state.pendingAnswerable = true;
    const blocked = await f.bridge.blocked('pane', await f.bridge.resolve('pane'));
    expect(projectChatBlocked(blocked, { terminalPromptAnswer: true })).toEqual({ by: 'approval', approvalId: 'apr_t' });
    expect(projectChatBlocked(blocked, { terminalPromptAnswer: false })).toEqual({ by: 'terminal' });
    // The write fence does not care: still closed.
    expect(f.bridge.hasOpenApproval('pane')).toBe(true);
  });

  it('a send is refused before the first write and reports the terminal', async () => {
    const f = fixture(); f.liveClaude();
    f.state.pendingApproval = 'apr_t'; f.state.pendingKind = 'terminal_prompt';
    expect(await f.bridge.send(phoneSend())).toMatchObject({ error: 'chat-blocked', blockedBy: 'terminal', effect: 'none' });
    expect(f.written).toEqual([]);
  });

  it('the pre-write recheck refuses a record that appears after the screen read', async () => {
    const f = fixture(); f.liveClaude();
    const read = f.deps.readScreen;
    f.deps.readScreen = async (id) => {
      const rows = await read(id);
      f.state.pendingApproval = 'apr_t'; f.state.pendingKind = 'terminal_prompt';
      return rows;
    };
    const outcome = await f.bridge.send(phoneSend());
    expect(outcome).toMatchObject({ effect: 'none' });
    expect(outcome).not.toMatchObject({ result: 'sent' });
    expect(f.written).toEqual([]);
  });

  it('the fence is kind-blind: any pending record, or no registry, holds every chat write', () => {
    const f = fixture();
    expect(f.bridge.hasOpenApproval('pane')).toBe(false);
    for (const kind of ['terminal_prompt', 'awaiting_input', 'awaiting_permission']) {
      f.state.pendingApproval = 'apr'; f.state.pendingKind = kind;
      expect(f.bridge.hasOpenApproval('pane'), kind).toBe(true);
    }
    f.state.pendingApproval = undefined;
    f.deps.approvals = () => null;
    expect(f.bridge.hasOpenApproval('pane')).toBe(true);
  });

  it('a chat Stop through interruptChatTurn is blocked by it', async () => {
    const f = fixture(); f.liveClaude();
    f.state.agent.agentStatus = 'running';
    f.state.pendingApproval = 'apr_t'; f.state.pendingKind = 'terminal_prompt';
    const { interruptChatTurn } = await import('../../transcript/interruptChatTurn');
    const writes: string[] = [];
    const result = await interruptChatTurn('conv', {
      getTranscriptSessionId: () => 'conv',
      hasOpenApproval: () => f.bridge.hasOpenApproval('pane'),
      readScreen: async () => ['✢ Ruminating… (8s · ↓ 238 tokens)'],
      getAgentState: () => ({ slug: 'claude', status: 'running' }),
      write: (data) => { writes.push(data); return true; },
    });
    expect(result).toBe('blocked');
    expect(writes).toEqual([]);
  });
});

describe('cancel', () => {
  const RUNNING = ['✢ Ruminating… (8s · ↓ 238 tokens)', '─'.repeat(40), '❯ ', '─'.repeat(40)];
  const EPOCH = fileHistoryEpoch('claude', 'conv', 'a.jsonl');
  const running = () => {
    const f = fixture(); f.liveClaude();
    f.state.agent = { ...f.state.agent, agentStatus: 'running', turn: { id: 't1:n.3', state: 'running', startedAt: Date.now() - 5_000 } };
    f.state.screen = RUNNING;
    return f;
  };
  const phoneCancel = (extra: Record<string, unknown> = {}) =>
    ({ owner: 'device:a' as const, id: 'pane', agentSessionId: 'conv', historyEpoch: EPOCH, turnId: 't1:n.3', clientCancelId: msgId(), ...extra });

  it('writes one ESC for the named running turn and replays the same id without writing again', async () => {
    const f = running();
    const req = phoneCancel();
    expect(await f.bridge.cancel(req)).toEqual({ clientCancelId: req.clientCancelId, replayed: false, effect: 'interrupt-requested', turnId: 't1:n.3' });
    expect(f.written).toEqual(['\x1b']);
    expect(await f.bridge.cancel(req)).toEqual({ clientCancelId: req.clientCancelId, replayed: true, effect: 'interrupt-requested', turnId: 't1:n.3' });
    expect(await f.bridge.cancel({ ...req, turnId: 't1:n.4' })).toMatchObject({ error: 'cancel-id-conflict', effect: 'none' });
    // A second id in the same turn is refused: the turn already has its ESC.
    expect(await f.bridge.cancel(phoneCancel())).toMatchObject({ error: 'turn-already-interrupted', turnId: 't1:n.3', effect: 'none' });
    expect(f.written).toEqual(['\x1b']);
    expect(f.bridge.sendInFlight('pane')).toBe(false);
  });

  it('a refused cancel writes no receipt at all, so the same id re-evaluates', async () => {
    const f = running();
    const STREAMING = ['  one hundred four', '─'.repeat(40), '❯ ', '─'.repeat(40)];
    f.state.screen = STREAMING;
    const req = phoneCancel();
    expect(await f.bridge.cancel(req)).toMatchObject({ error: 'turn-not-running', turn: { id: 't1:n.3', state: 'running' }, effect: 'none' });
    expect(fs.existsSync(path.join(f.dir, 'chat-cancel-receipts.json'))).toBe(false);
    // Mid-stream: no row on screen, but the agent's title spinner is fresh.
    f.shell.title = { title: '◑ English number words 1-200', at: Date.now() };
    expect(await f.bridge.cancel(req)).toMatchObject({ effect: 'interrupt-requested', replayed: false });
    expect(f.written).toEqual(['\x1b']);
    expect(await f.bridge.cancel(req)).toMatchObject({ effect: 'interrupt-requested', replayed: true });
    expect(f.written).toEqual(['\x1b']);
  });

  it('a stale or idle title is no evidence', async () => {
    const f = running();
    f.state.screen = ['  one hundred four', '─'.repeat(40), '❯ ', '─'.repeat(40)];
    f.shell.title = { title: '◑ English number words 1-200', at: Date.now() - 10_000 };
    expect(await f.bridge.cancel(phoneCancel())).toMatchObject({ error: 'turn-not-running' });
    f.shell.title = { title: '✳ English number words 1-200', at: Date.now() };
    expect(await f.bridge.cancel(phoneCancel())).toMatchObject({ error: 'turn-not-running' });
    expect(f.written).toEqual([]);
  });

  it('a write that throws is uncertain, latches the turn, and replays with its 500 kept', async () => {
    const f = running();
    const bridge = createChatBridge({ ...f.deps, write: () => { throw new Error('EIO'); } });
    const req = phoneCancel();
    expect(await bridge.cancel(req)).toEqual({ clientCancelId: req.clientCancelId, replayed: false, effect: 'uncertain', turnId: 't1:n.3', error: 'cancel-failed' });
    expect(await bridge.cancel(req)).toMatchObject({ replayed: true, effect: 'uncertain', error: 'cancel-failed' });
    // The maybe-written ESC holds the latch: no second ESC this turn, from anyone.
    expect(await bridge.cancel(phoneCancel())).toMatchObject({ error: 'turn-already-interrupted' });
    expect(await bridge.desktopInterrupt('pane', 'conv')).toBe('not_running');
  });

  it('names the turn it aimed at, even if a new one opens during the write', async () => {
    const f = running();
    const bridge = createChatBridge({ ...f.deps, write: (id, data) => {
      f.state.agent.turn = { id: 't1:n.4', state: 'running', startedAt: Date.now() };
      return f.deps.write(id, data);
    } });
    const req = phoneCancel();
    expect(await bridge.cancel(req)).toMatchObject({ effect: 'interrupt-requested', turnId: 't1:n.3' });
    expect(await bridge.cancel(req)).toMatchObject({ replayed: true, turnId: 't1:n.3' });
  });

  it('a throw after the receipt frees the id for a retry', async () => {
    const f = running();
    const store = new ChatCancelReceiptStore(f.dir);
    const insert = store.insertPending.bind(store);
    let fail = true;
    vi.spyOn(store, 'insertPending').mockImplementation((...args) => {
      const inserted = insert(...args);
      if (fail) { fail = false; throw new Error('late failure'); }
      return inserted;
    });
    const bridge = createChatBridge({ ...f.deps, cancelReceipts: store });
    const req = phoneCancel();
    expect(await bridge.cancel(req)).toMatchObject({ error: 'cancel-failed', effect: 'none' });
    expect(f.written).toEqual([]);
    expect(await bridge.cancel(req)).toMatchObject({ effect: 'interrupt-requested', replayed: false });
  });

  it('desktop cooldown reads as not_running, never the prompt notice', async () => {
    const f = running();
    f.shell.escAt = Date.now() - 500;
    f.state.agent.turn = { id: 't1:n.3', state: 'running', startedAt: f.shell.escAt + 100 };
    expect(await f.bridge.desktopInterrupt('pane', 'conv')).toBe('not_running');
  });

  it('a receipt that cannot be stored refuses before the ESC', async () => {
    const f = running();
    const store = new ChatCancelReceiptStore(f.dir, { write: () => { throw new Error('disk full'); } });
    const bridge = createChatBridge({ ...f.deps, cancelReceipts: store });
    expect(await bridge.cancel(phoneCancel())).toMatchObject({ error: 'chat-persist-failed', effect: 'none' });
    expect(f.written).toEqual([]);
  });

  it('turn mismatch, idle turn, dead agent: turn-not-running and nothing written', async () => {
    const f = running();
    expect(await f.bridge.cancel(phoneCancel({ turnId: 't1:n.2' }))).toMatchObject({ error: 'turn-not-running', turn: { id: 't1:n.3' } });
    f.state.agent.agentStatus = 'complete';
    expect(await f.bridge.cancel(phoneCancel())).toMatchObject({ error: 'turn-not-running' });
    f.state.agent.agentStatus = 'running'; f.state.agent.agentVerified = false;
    expect(await f.bridge.cancel(phoneCancel())).toMatchObject({ error: 'turn-not-running' });
    expect(f.written).toEqual([]);
  });

  it('prompt-active names the pending record and who answers it', async () => {
    const f = running();
    f.state.pendingApproval = 'apr_t'; f.state.pendingKind = 'terminal_prompt';
    expect(await f.bridge.cancel(phoneCancel())).toMatchObject({ error: 'prompt-active', by: 'terminal', approvalId: 'apr_t' });
    f.state.pendingKind = 'permission';
    expect(await f.bridge.cancel(phoneCancel())).toMatchObject({ error: 'prompt-active', by: 'approval', approvalId: 'apr_t' });
    f.state.pendingApproval = undefined; f.state.agent.agentStatus = 'awaiting_input';
    const awaiting = await f.bridge.cancel(phoneCancel());
    expect(awaiting).toMatchObject({ error: 'prompt-active', by: 'terminal' });
    expect(awaiting).not.toHaveProperty('approvalId');
    expect(f.written).toEqual([]);
  });

  it('session, id and binding refusals', async () => {
    const f = running();
    expect(await f.bridge.cancel(phoneCancel({ agentSessionId: 'other' }))).toMatchObject({ error: 'session-changed', agentSessionId: 'conv', historyEpoch: EPOCH });
    expect(await f.bridge.cancel(phoneCancel({ historyEpoch: 'h1:stale' }))).toMatchObject({ error: 'session-changed' });
    expect(await f.bridge.cancel(phoneCancel({ clientCancelId: 'nope' }))).toMatchObject({ error: 'invalid-chat-request' });
    expect(await f.bridge.cancel(phoneCancel({ clientCancelId: `${Date.now() - 25 * 3600_000}-${randomUUID()}` }))).toMatchObject({ error: 'message-id-expired' });
    f.state.native = { status: TUI_STATUS, page: page('raw') };
    expect(await f.bridge.cancel(phoneCancel())).toMatchObject({ error: 'cancel-unsupported' });
    expect(f.written).toEqual([]);
  });

  it('refuses without a cancel receipt store', async () => {
    const f = running();
    const bridge = createChatBridge({ ...f.deps, cancelReceipts: null });
    expect(await bridge.cancel(phoneCancel())).toMatchObject({ error: 'chat-persist-failed' });
  });

  it('a desktop Stop and a phone cancel landing together write one ESC', async () => {
    const f = running();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const bridge = createChatBridge({ ...f.deps, readScreen: async () => { await gate; return RUNNING; } });
    const desktop = bridge.desktopInterrupt('pane', 'conv');
    const phone = bridge.cancel(phoneCancel());
    release();
    expect(await desktop).toBe('sent');
    expect(await phone).toMatchObject({ error: 'chat-busy', effect: 'none' });
    expect(f.written).toEqual(['\x1b']);
    // Sequential: the phone finds the turn's ESC, the desktop hears not_running.
    expect(await bridge.cancel(phoneCancel())).toMatchObject({ error: 'turn-already-interrupted' });
    expect(await bridge.desktopInterrupt('pane', 'conv')).toBe('not_running');
    expect(f.written).toEqual(['\x1b']);
  });

  it('cooldown: an ESC from anywhere less than 2 s ago holds a new turn\'s cancel', async () => {
    const f = running();
    f.shell.escAt = Date.now() - 500;
    f.state.agent.turn = { id: 't1:n.3', state: 'running', startedAt: f.shell.escAt + 100 };
    const refused = await f.bridge.cancel(phoneCancel());
    expect(refused).toMatchObject({ error: 'cancel-cooldown', effect: 'none' });
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(1500);
    expect(f.written).toEqual([]);
  });

  it('a send right after an ESC waits out the quiet window before pasting', async () => {
    const f = running();
    const delays: number[] = [];
    const bridge = createChatBridge({ ...f.deps, delay: async (ms) => { delays.push(ms); } });
    f.shell.escAt = Date.now();
    await bridge.send(phoneSend('next'));
    expect(delays[0]).toBeGreaterThan(200);
    expect(delays[0]).toBeLessThanOrEqual(300);
  });

  it('desktop keeps its enum: unavailable without a registry or on a native binding', async () => {
    const f = running();
    expect(await createChatBridge({ ...f.deps, approvals: () => null }).desktopInterrupt('pane', 'conv')).toBe('unavailable');
    f.state.native = { status: TUI_STATUS, page: page('raw') };
    expect(await f.bridge.desktopInterrupt('pane', 'conv')).toBe('unavailable');
    expect(f.written).toEqual([]);
  });
});

describe('cancel (OpenCode plugin abort)', () => {
  const TURN = 't1:oc.0123456789abcdef01234567';
  const RAW = 'raw:1:ses_one';
  const ABORTABLE: TranscriptStatus = { ...TUI_STATUS, agentStatus: 'running',
    terminal: { ...TUI_STATUS.terminal!, capabilities: { ...TUI_STATUS.terminal!.capabilities, send: false, cancel: true } } };
  const opencode = (status: TranscriptStatus = ABORTABLE) => {
    const f = fixture();
    // Like the service: the last authorization step runs right before the request leaves.
    const answer = vi.fn<() => Promise<TerminalChatAbortOutcome>>(async () => ({ result: 'sent', turn: { id: TURN, state: 'running' } }));
    const abort = vi.fn(async (_id: string, _session: string, opts: { authorized?: () => Promise<boolean> } = {}): Promise<TerminalChatAbortOutcome> =>
      opts.authorized && !await opts.authorized() ? { result: 'error', reason: 'unauthorized' } : answer());
    f.state.native = { status, page: page(RAW) };
    const read = async () => f.state.native ? { ...f.state.native, turn: { id: TURN, state: 'running' as const, startedAt: 5 } } : null;
    f.deps.terminalChat = () => ({ read, send: f.tuiSend as never, subscribe: f.subscribe, unsubscribe: f.unsubscribe, abort });
    return { ...f, abort, answer, bridge: createChatBridge(f.deps) };
  };
  const tuiCancel = (extra: Record<string, unknown> = {}) =>
    ({ owner: 'device:a' as const, id: 'pane', agentSessionId: 'ses_one', historyEpoch: tuiHistoryEpoch(RAW), turnId: TURN, clientCancelId: msgId(), ...extra });

  it('resolves the plugin turn for /turns', async () => {
    const f = opencode();
    expect(await f.bridge.resolve('pane')).toMatchObject({ source: 'tui', turn: { id: TURN, state: 'running' } });
  });

  it('aborts through the plugin with the compared raw epoch and turn, and replays without a second abort', async () => {
    const f = opencode();
    const authorized = vi.fn(async () => true);
    const req = tuiCancel({ authorized });
    const first = await f.bridge.cancel(req);
    expect(first).toEqual({ clientCancelId: req.clientCancelId, replayed: false, effect: 'interrupt-requested', turnId: TURN });
    expect(cancelResponse(first).status).toBe(202);
    expect(f.abort).toHaveBeenCalledWith('pane', 'ses_one', expect.objectContaining({ expectedRawEpoch: RAW, turnId: TURN,
      read: expect.objectContaining({ page: expect.objectContaining({ cursor: expect.objectContaining({ historyEpoch: RAW }) }) }) }));
    expect(authorized).toHaveBeenCalledTimes(1);
    const again = await f.bridge.cancel(req);
    expect(again).toMatchObject({ replayed: true, effect: 'interrupt-requested', turnId: TURN });
    expect(cancelResponse(again).status).toBe(200);
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.written).toEqual([]);
  });

  it('maps plugin refusals to the route codes and stores no receipt', async () => {
    const f = opencode();
    const rows: Array<[TerminalChatAbortOutcome, number, Record<string, unknown>]> = [
      [{ result: 'not_running', turn: { id: TURN, state: 'idle' } }, 409, { error: 'turn-not-running', turn: { id: TURN, state: 'idle' } }],
      [{ result: 'prompt_active' }, 409, { error: 'prompt-active', by: 'terminal' }],
      [{ result: 'pending' }, 409, { error: 'cancel-cooldown', retryAfterMs: 500 }],
      // The identity the phone holds is still current: re-reading would not help.
      [{ result: 'session_changed' }, 409, { error: 'chat-unavailable' }],
      [{ result: 'unavailable' }, 409, { error: 'chat-unavailable' }],
      [{ result: 'error', reason: 'unauthorized' }, 401, { error: 'authorization-expired' }],
    ];
    const req = tuiCancel();
    for (const [aborted, status, body] of rows) {
      f.answer.mockResolvedValueOnce(aborted);
      const outcome = await f.bridge.cancel(req);
      const wire = cancelResponse(outcome);
      expect(wire.status, aborted.result).toBe(status);
      expect(wire.body, aborted.result).toMatchObject({ ...body, effect: 'none' });
    }
    // Every refusal freed the id: the same one re-evaluates and can still stop the turn.
    expect(await f.bridge.cancel(req)).toMatchObject({ effect: 'interrupt-requested', replayed: false });
  });

  it('session_changed with a new identity is session-changed, carrying it', async () => {
    const f = opencode();
    f.answer.mockImplementationOnce(async () => {
      f.state.native = { status: { ...ABORTABLE, agentSessionId: 'ses_two' }, page: page(RAW) };
      return { result: 'session_changed' };
    });
    expect(await f.bridge.cancel(tuiCancel())).toMatchObject({ error: 'session-changed', agentSessionId: 'ses_two' });
  });

  it('writes the receipt only once the request is authorized to leave', async () => {
    const f = opencode();
    const req = tuiCancel({ authorized: async () => false });
    expect(await f.bridge.cancel(req)).toMatchObject({ error: 'authorization-expired', effect: 'none' });
    expect(fs.existsSync(path.join(f.dir, 'chat-cancel-receipts.json'))).toBe(false);
    expect(f.answer).not.toHaveBeenCalled();
    // A thrown abort settles the receipt as uncertain; the id never stays pending.
    f.abort.mockImplementationOnce(async (_id, _session, opts = {}) => { await opts.authorized?.(); throw new Error('boom'); });
    const thrown = tuiCancel();
    expect(await f.bridge.cancel(thrown)).toMatchObject({ error: 'cancel-failed', effect: 'uncertain' });
    expect(await f.bridge.cancel(thrown)).toMatchObject({ replayed: true, effect: 'uncertain' });
  });

  it('a pending approval record names itself on prompt-active', async () => {
    const f = opencode();
    f.state.pendingApproval = 'apr_o'; f.state.pendingKind = 'permission';
    f.answer.mockResolvedValueOnce({ result: 'prompt_active' });
    expect(await f.bridge.cancel(tuiCancel())).toMatchObject({ error: 'prompt-active', by: 'approval', approvalId: 'apr_o' });
  });

  it('an unconfirmed abort is uncertain and replays with its 500', async () => {
    const f = opencode();
    f.answer.mockResolvedValueOnce({ result: 'unconfirmed', reason: 'transport-lost' });
    const req = tuiCancel();
    const first = await f.bridge.cancel(req);
    expect(first).toMatchObject({ effect: 'uncertain', error: 'cancel-failed', turnId: TURN });
    expect(cancelResponse(first).status).toBe(500);
    expect(cancelResponse(await f.bridge.cancel(req))).toMatchObject({ status: 500, body: { replayed: true, effect: 'uncertain' } });
    expect(f.abort).toHaveBeenCalledTimes(1);
  });

  it('a stale turn, session or epoch is refused before the plugin', async () => {
    const f = opencode();
    expect(await f.bridge.cancel(tuiCancel({ turnId: 't1:oc.ffffffffffffffffffffffff' })))
      .toMatchObject({ error: 'turn-not-running', turn: { id: TURN, state: 'running' } });
    expect(await f.bridge.cancel(tuiCancel({ agentSessionId: 'ses_two' }))).toMatchObject({ error: 'session-changed', agentSessionId: 'ses_one' });
    expect(await f.bridge.cancel(tuiCancel({ historyEpoch: 't1:stale' }))).toMatchObject({ error: 'session-changed' });
    expect(f.abort).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.dir, 'chat-cancel-receipts.json'))).toBe(false);
  });

  it('an old plugin (no abort advertised) is cancel-unsupported and never asked', async () => {
    const f = opencode(TUI_STATUS);
    expect(await f.bridge.cancel(tuiCancel())).toMatchObject({ error: 'cancel-unsupported', effect: 'none' });
    expect(cancelResponse(await f.bridge.cancel(tuiCancel())).status).toBe(422);
    expect(await f.bridge.desktopInterrupt('pane', 'ses_one')).toBe('unavailable');
    expect(f.abort).not.toHaveBeenCalled();
  });

  it('the desktop Stop aborts through the plugin and keeps its enum', async () => {
    const f = opencode();
    expect(await f.bridge.desktopInterrupt('pane', 'ses_one')).toBe('sent');
    expect(f.abort).toHaveBeenCalledWith('pane', 'ses_one', expect.objectContaining({ read: expect.anything() }));
    f.answer.mockResolvedValueOnce({ result: 'prompt_active' });
    expect(await f.bridge.desktopInterrupt('pane', 'ses_one')).toBe('blocked');
    f.answer.mockResolvedValueOnce({ result: 'not_running' });
    expect(await f.bridge.desktopInterrupt('pane', 'ses_one')).toBe('not_running');
    f.answer.mockResolvedValueOnce({ result: 'pending' });
    expect(await f.bridge.desktopInterrupt('pane', 'ses_one')).toBe('not_running');
    f.answer.mockResolvedValueOnce({ result: 'unconfirmed' });
    expect(await f.bridge.desktopInterrupt('pane', 'ses_one')).toBe('error');
    expect(f.written).toEqual([]);
  });
});

describe('daemon queue (chat-queue)', () => {
  const RULE = '─'.repeat(40);
  const IDLE = ['● done', RULE, '❯ ', RULE];
  const allow = async () => true;
  const queued = (f: ReturnType<typeof fixture>, opts: { authorized?: (stage?: string) => Promise<boolean>; ttl?: number; now?: () => number } = {}) => {
    const events: ChatQueueEvent[] = [];
    const bridge = createChatBridge({ ...f.deps, queue: new ChatQueueStore(f.dir), onQueueEvent: (e) => events.push(e),
      queueTickMs: 3_600_000, ...(opts.ttl !== undefined ? { queueTtlMs: opts.ttl } : {}), ...(opts.now ? { now: opts.now } : {}) });
    const send = (text: string, extra: Record<string, unknown> = {}) =>
      bridge.send(phoneSend(text, { queue: { authorized: opts.authorized ?? allow }, ...extra }));
    return { bridge, events, send };
  };
  const runningTurn = (f: ReturnType<typeof fixture>, n: number) => {
    f.state.agent = { ...f.state.agent, agentStatus: 'running', turn: { id: `t1:n.${n}`, state: 'running', startedAt: n } };
  };
  const idleTurn = (f: ReturnType<typeof fixture>, n: number) => {
    f.state.agent = { ...f.state.agent, agentStatus: 'complete', turn: { id: `t1:n.${n}`, state: 'idle', startedAt: n } };
    f.state.screen = IDLE;
  };
  const pastes = (f: ReturnType<typeof fixture>) => f.written.filter((w) => w.startsWith('\x1b[200~'));

  it('holds three sends made during a turn and delivers them in order, one per ended turn', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    const answers = [await q.send('one'), await q.send('two'), await q.send('three')];
    for (const answer of answers) expect(answer).toMatchObject({ replayed: false, queueState: 'queued' });
    expect(answers[0]).not.toHaveProperty('effect');
    await q.bridge.kickQueue('pane');
    expect(f.written).toEqual([]);

    idleTurn(f, 1);
    await q.bridge.kickQueue('pane');
    expect(pastes(f)).toEqual(['\x1b[200~one\x1b[201~']);
    // A stale `complete` of the same turn delivers nothing more.
    await q.bridge.kickQueue('pane');
    expect(pastes(f)).toHaveLength(1);
    runningTurn(f, 2); await q.bridge.kickQueue('pane');
    expect(pastes(f)).toHaveLength(1);
    idleTurn(f, 2); await q.bridge.kickQueue('pane');
    idleTurn(f, 3); await q.bridge.kickQueue('pane');
    expect(pastes(f)).toEqual(['\x1b[200~one\x1b[201~', '\x1b[200~two\x1b[201~', '\x1b[200~three\x1b[201~']);
    expect(q.bridge.queue('device:a', 'pane').map((item) => [item.preview, item.state]))
      .toEqual([['one', 'delivered'], ['two', 'delivered'], ['three', 'delivered']]);
    const first = answers[0].clientMessageId;
    expect(q.events.filter((e) => e.clientMessageId === first).map((e) => e.state)).toEqual(['queued', 'delivering', 'delivered']);
    // The delivered message has a v1 send receipt; a re-post replays the queue's state.
    expect(q.bridge.receipt('device:a', 'pane', first)).toMatchObject({ state: 'submitted', result: 'sent', queue: { state: 'delivered' } });
    expect(await q.bridge.send(phoneSend('one', { clientMessageId: first }))).toMatchObject({ replayed: true, queueState: 'delivered' });
    expect(await q.bridge.send(phoneSend('other', { clientMessageId: first }))).toMatchObject({ error: 'message-id-conflict' });
    expect(q.bridge.delivered('device:a', 'pane').map((m) => m.clientMessageId)).toEqual(answers.map((a) => a.clientMessageId));
    expect(q.bridge.delivered('device:b', 'pane')).toEqual([]);
  });

  it('the episode a delivery opens must be seen running before the next item goes', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    // As in the daemon: the Enter opens the next episode at once, while the
    // status still reads idle until the agent's first bytes or hook.
    const bridge = createChatBridge({ ...f.deps, queue: new ChatQueueStore(f.dir), queueTickMs: 3_600_000,
      write: (id, data) => {
        const ok = f.deps.write(id, data);
        if (data === '\r') f.state.agent = { ...f.state.agent, turn: { id: 't1:n.2', state: 'idle', startedAt: 2 } };
        return ok;
      } });
    const send = (text: string) => bridge.send(phoneSend(text, { queue: { authorized: allow } }));
    await send('one'); await send('two');
    idleTurn(f, 1);
    await bridge.kickQueue('pane');
    expect(f.state.agent.turn?.id).toBe('t1:n.2');
    await bridge.kickQueue('pane');
    expect(pastes(f)).toEqual(['\x1b[200~one\x1b[201~']);
    runningTurn(f, 2); await bridge.kickQueue('pane');
    idleTurn(f, 2); await bridge.kickQueue('pane');
    expect(pastes(f)).toEqual(['\x1b[200~one\x1b[201~', '\x1b[200~two\x1b[201~']);
  });

  it('a queued re-post replays the queue state and a different body conflicts', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    const req = phoneSend('one', { queue: { authorized: allow } });
    await q.bridge.send(req);
    expect(await q.bridge.send(req)).toMatchObject({ replayed: true, queueState: 'queued' });
    expect(await q.bridge.send({ ...req, text: 'other' })).toMatchObject({ error: 'message-id-conflict' });
    expect(q.bridge.receipt('device:a', 'pane', req.clientMessageId)).toMatchObject({ state: 'queued', queue: { state: 'queued' } });
  });

  it('fails a queued message on a draft left in the composer, and never retries it', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    const { clientMessageId } = await q.send('one');
    f.state.agent = { ...f.state.agent, agentStatus: 'idle', turn: { id: 't1:n.1', state: 'idle' } };
    f.state.screen = [RULE, '❯ half-typed', RULE];
    await q.bridge.kickQueue('pane');
    expect(f.written).toEqual([]);
    expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ clientMessageId, state: 'failed', reason: 'draft-present' });
    expect(q.bridge.receipt('device:a', 'pane', clientMessageId))
      .toMatchObject({ state: 'refused', queue: { state: 'failed', reason: 'draft-present' } });
    await q.bridge.kickQueue('pane');
    expect(f.written).toEqual([]);
  });

  it('holds on a dialog until the TTL, then fails it as blocked', async () => {
    let clock = Date.now();
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f, { ttl: 60_000, now: () => clock });
    const { clientMessageId } = await q.send('one');
    idleTurn(f, 1);
    f.state.screen = ['Select model', '❯ 1. Sonnet', '  2. Opus', 'Esc to cancel'];
    await q.bridge.kickQueue('pane');
    expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ clientMessageId, state: 'queued' });
    clock += 61_000;
    await q.bridge.kickQueue('pane');
    expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ state: 'failed', reason: 'blocked' });
    expect(f.written).toEqual([]);
  });

  it('without the cap a Claude send mid-turn still takes the native queue', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    f.state.screen = ['✢ Effecting… (9s · thinking)', RULE, '❯ ', RULE];
    const q = queued(f);
    expect(await q.bridge.send(phoneSend('now'))).toMatchObject({ result: 'sent', effect: 'submitted', queued: true });
    expect(q.bridge.queue('device:a', 'pane')).toEqual([]);
  });

  it('a non-empty pane queue holds even an idle send; the desktop never enqueues', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    await q.send('one', { owner: 'device:b' });
    idleTurn(f, 1);
    f.state.pendingApproval = 'apr_1';
    expect(await q.send('two')).toMatchObject({ queueState: 'queued' });
    f.state.pendingApproval = undefined;
    expect(await q.bridge.desktopSend({ id: 'pane', agentSessionId: 'conv', text: 'desk', requestId: msgId() })).toMatchObject({ result: 'sent' });
  });

  it('re-authorizes at delivery: an unpaired or read-only owner, or a restarted pane, cancels without a write', async () => {
    for (const change of ['revoked', 'restart'] as const) {
      const f = fixture(); f.liveClaude(); runningTurn(f, 1);
      let ok = true;
      const q = queued(f, { authorized: async () => ok });
      const { clientMessageId } = await q.send('one');
      if (change === 'revoked') ok = false; else f.state.pane!.meta.incarnationId = 'inc-2';
      idleTurn(f, 1);
      await q.bridge.kickQueue('pane');
      expect(f.written).toEqual([]);
      expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ clientMessageId, state: 'canceled', reason: 'authorization-revoked' });
    }
  });

  it('a grant withdrawn between paste and Enter leaves the item uncertain, never resendable', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const stages: string[] = [];
    const q = queued(f, { authorized: async (stage) => { stages.push(String(stage)); return stage !== 'submit'; } });
    await q.send('one');
    idleTurn(f, 1);
    await q.bridge.kickQueue('pane');
    expect(stages).toEqual(['first-write', 'first-write', 'submit']);
    const [{ clientMessageId }] = q.bridge.queue('device:a', 'pane');
    expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ state: 'uncertain', reason: 'delivery-unconfirmed' });
    expect(q.bridge.receipt('device:a', 'pane', clientMessageId)).toMatchObject({ state: 'uncertain', queue: { state: 'uncertain' } });
    expect(await q.bridge.send(phoneSend('one', { clientMessageId }))).toMatchObject({ replayed: true, queueState: 'uncertain' });
  });

  it('two concurrent sends with one id make one record, and a DELETE during a pass writes nothing', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    const req = phoneSend('one', { queue: { authorized: allow } });
    const [a, b] = await Promise.all([q.bridge.send(req), q.bridge.send(req)]);
    expect([a.queueState, b.queueState]).toEqual(['queued', 'queued']);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(q.bridge.queue('device:a', 'pane')).toHaveLength(1);
    const other = await Promise.all([q.bridge.send({ ...req, text: 'two' })]);
    expect(other[0]).toMatchObject({ error: 'message-id-conflict' });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = createChatBridge({ ...f.deps, queue: new ChatQueueStore(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-q-'))),
      queueTickMs: 3_600_000 });
    const held = await slow.send(phoneSend('late', { queue: { authorized: async () => { await gate; return true; } } }));
    idleTurn(f, 1);
    const pass = slow.kickQueue('pane');
    expect(slow.dequeue('device:a', 'pane', held.clientMessageId)).toEqual({ ok: true });
    release();
    await pass;
    expect(f.written).toEqual([]);
    expect(slow.queue('device:a', 'pane')[0]).toMatchObject({ state: 'canceled', reason: 'user' });
  });

  it('a draft in a complete (not idle) Claude composer still fails the item', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    await q.send('one');
    f.state.agent = { ...f.state.agent, agentStatus: 'complete', turn: { id: 't1:n.1', state: 'idle' } };
    f.state.screen = ['● done', RULE, '❯ half-typed', RULE];
    await q.bridge.kickQueue('pane');
    expect(f.written).toEqual([]);
    expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ state: 'failed', reason: 'draft-present' });
  });

  it('OpenCode: one item per turn, even while the plugin still reads complete after a delivery', async () => {
    const f = fixture();
    f.state.native = { status: { ...TUI_STATUS, agentStatus: 'running' }, page: page('raw:ses_one') };
    const q = queued(f);
    const tui = (text: string) => q.bridge.send({ owner: 'device:a', id: 'pane', agentSessionId: 'ses_one',
      historyEpoch: tuiHistoryEpoch('raw:ses_one'), clientMessageId: msgId(), text, managedReadOnly: true, queue: { authorized: allow } });
    await tui('one'); await tui('two');
    f.state.native = { status: TUI_STATUS, page: page('raw:ses_one') };
    await q.bridge.kickQueue('pane');
    await q.bridge.kickQueue('pane');
    expect(f.tuiSend).toHaveBeenCalledTimes(1);
    f.state.native = { status: { ...TUI_STATUS, agentStatus: 'running' }, page: page('raw:ses_one') };
    await q.bridge.kickQueue('pane');
    f.state.native = { status: TUI_STATUS, page: page('raw:ses_one') };
    await q.bridge.kickQueue('pane');
    expect(f.tuiSend).toHaveBeenCalledTimes(2);
  });

  it('an OpenCode answer lost after the plugin took the request is uncertain', async () => {
    const f = fixture();
    f.state.native = { status: { ...TUI_STATUS, agentStatus: 'running' }, page: page('raw:ses_one') };
    f.tuiSend.mockResolvedValueOnce({ result: 'unconfirmed' });
    const q = queued(f);
    const { clientMessageId } = await q.bridge.send({ owner: 'device:a', id: 'pane', agentSessionId: 'ses_one',
      historyEpoch: tuiHistoryEpoch('raw:ses_one'), clientMessageId: msgId(), text: 'x', managedReadOnly: true, queue: { authorized: allow } });
    f.state.native = { status: TUI_STATUS, page: page('raw:ses_one') };
    await q.bridge.kickQueue('pane');
    expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ clientMessageId, state: 'uncertain', reason: 'delivery-unconfirmed' });
    expect(q.bridge.receipt('device:a', 'pane', clientMessageId).state).toBe('uncertain');
  });

  it('while the agent works, a pass reads neither the roster nor the binding; a long turn never expires the item', async () => {
    let clock = Date.now();
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const authorized = vi.fn(async () => true);
    const q = queued(f, { authorized, ttl: 60_000, now: () => clock });
    const status = vi.spyOn(f.deps.projector, 'status');
    await q.send('one');
    status.mockClear();
    clock += 30 * 60_000;
    await q.bridge.kickQueue('pane');
    expect(authorized).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    idleTurn(f, 1);
    await q.bridge.kickQueue('pane');
    expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ state: 'delivered' });
  });

  it('gives up after repeated failures to persist delivering, with backoff between tries', async () => {
    let clock = Date.now();
    let failing = false;
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const store = new ChatQueueStore(f.dir, { write: (file, data) => {
      if (failing && JSON.stringify(data).includes('"delivering"')) throw new Error('disk full');
      fs.writeFileSync(file, JSON.stringify(data));
    } });
    const bridge = createChatBridge({ ...f.deps, now: () => clock, queue: store, queueTickMs: 3_600_000 });
    await bridge.send(phoneSend('one', { queue: { authorized: allow } }));
    idleTurn(f, 1);
    failing = true;
    await bridge.kickQueue('pane');
    await bridge.kickQueue('pane');
    expect(bridge.queue('device:a', 'pane')[0].state).toBe('queued');
    for (let i = 0; i < 3; i++) { clock += 10_000; await bridge.kickQueue('pane'); }
    expect(bridge.queue('device:a', 'pane')[0]).toMatchObject({ state: 'failed', reason: 'delivery-unconfirmed' });
    expect(f.written).toEqual([]);
  });

  it('a restarted daemon never replays another pane\'s record for the same id', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    const { clientMessageId } = await q.send('one');
    const after = createChatBridge({ ...f.deps, queue: new ChatQueueStore(f.dir), queueTickMs: 3_600_000 });
    expect(await after.send(phoneSend('one', { clientMessageId, id: 'elsewhere' }))).toMatchObject({ error: 'message-id-conflict' });
    expect(await after.send(phoneSend('one', { clientMessageId }))).toMatchObject({ replayed: true, queueState: 'canceled' });
  });

  it('drops the memory half when the store prunes a record', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    const first = (await q.send('first')).clientMessageId;
    q.bridge.dequeue('device:a', 'pane', first);
    for (let i = 0; i < 16; i++) { const { clientMessageId } = await q.send(`m${i}`); q.bridge.dequeue('device:a', 'pane', clientMessageId); }
    expect(q.bridge.queue('device:a', 'pane').some((item) => item.clientMessageId === first)).toBe(false);
    // A re-post of the pruned id is new again: no stale memo makes it conflict.
    expect(await q.send('different', { clientMessageId: first })).toMatchObject({ queueState: 'queued', replayed: false });
  });

  it('dropQueue cancels one owner immediately; paneClosed and a new session cancel the rest', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    await q.send('a1'); await q.send('b1', { owner: 'device:b' });
    q.bridge.dropQueue((owner) => owner === 'device:a', 'authorization-revoked');
    expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ state: 'canceled', reason: 'authorization-revoked' });
    expect(q.bridge.queue('device:b', 'pane')[0]).toMatchObject({ state: 'queued' });
    q.bridge.paneClosed('pane');
    expect(q.bridge.queue('device:b', 'pane')[0]).toMatchObject({ state: 'canceled', reason: 'pane-closed' });

    await q.send('a2');
    f.state.projector = { ...FILE, agentSessionId: 'conv-2', terminal: { ...FILE.terminal!, nativeSessionId: 'conv-2' } };
    idleTurn(f, 1);
    await q.bridge.kickQueue('pane');
    expect(q.bridge.queue('device:a', 'pane').at(-1)).toMatchObject({ state: 'canceled', reason: 'session-changed' });
    expect(f.written).toEqual([]);
  });

  it('dequeue answers per state and is owner-bound', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    const a = (await q.send('one')).clientMessageId;
    const b = (await q.send('two')).clientMessageId;
    expect(q.bridge.dequeue('device:b', 'pane', a)).toEqual({ ok: false, error: 'queue-item-not-found' });
    expect(q.bridge.dequeue('device:a', 'other', a)).toEqual({ ok: false, error: 'queue-item-not-found' });
    expect(q.bridge.dequeue('device:a', 'pane', b)).toEqual({ ok: true });
    expect(q.bridge.dequeue('device:a', 'pane', b)).toEqual({ ok: true });
    expect(q.events.at(-1)).toMatchObject({ clientMessageId: b, state: 'canceled', reason: 'user', owner: 'device:a', sessionId: 'pane' });
    idleTurn(f, 1);
    await q.bridge.kickQueue('pane');
    expect(q.bridge.dequeue('device:a', 'pane', a)).toMatchObject({ ok: false, error: 'already-delivered' });
    expect(pastes(f)).toEqual(['\x1b[200~one\x1b[201~']);
  });

  it('caps active items at eight per pane and owner', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    for (let i = 0; i < 8; i++) expect(await q.send(`m${i}`)).toMatchObject({ queueState: 'queued' });
    expect(await q.send('m8')).toMatchObject({ error: 'queue-full', effect: 'none' });
  });

  it('OpenCode: a running TUI queues, and delivers through the plugin when it is complete again', async () => {
    const f = fixture();
    f.state.native = { status: { ...TUI_STATUS, agentStatus: 'running' }, page: page('raw:ses_one') };
    const q = queued(f);
    const { clientMessageId } = await q.bridge.send({ owner: 'device:a', id: 'pane', agentSessionId: 'ses_one',
      historyEpoch: tuiHistoryEpoch('raw:ses_one'), clientMessageId: msgId(), text: 'tui', managedReadOnly: true, queue: { authorized: allow } });
    await q.bridge.kickQueue('pane');
    expect(f.tuiSend).not.toHaveBeenCalled();
    f.state.native = { status: TUI_STATUS, page: page('raw:ses_one') };
    await q.bridge.kickQueue('pane');
    expect(f.tuiSend).toHaveBeenCalledTimes(1);
    expect(q.bridge.queue('device:a', 'pane')[0]).toMatchObject({ clientMessageId, state: 'delivered' });
  });

  it('a restart cancels what was queued, and the text is gone', async () => {
    const f = fixture(); f.liveClaude(); runningTurn(f, 1);
    const q = queued(f);
    const { clientMessageId } = await q.send('secret words');
    expect(fs.readFileSync(path.join(f.dir, 'chat-queue.json'), 'utf8')).not.toContain('secret words');
    const after = createChatBridge({ ...f.deps, queue: new ChatQueueStore(f.dir), queueTickMs: 3_600_000 });
    expect(after.queue('device:a', 'pane')).toEqual([expect.objectContaining({ clientMessageId, state: 'canceled', reason: 'daemon-restart' })]);
    expect(after.queue('device:a', 'pane')[0]).not.toHaveProperty('preview');
    idleTurn(f, 1);
    await after.kickQueue('pane');
    expect(f.written).toEqual([]);
  });
});
