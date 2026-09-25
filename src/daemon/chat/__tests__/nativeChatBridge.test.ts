import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptPage, TranscriptStatus } from '../../../shared/transcript/turnEvents';
import { ChatSendReceiptStore } from '../ChatSendReceiptStore';
import { createChatBridge, WEB_BRIDGE_CLIENT, type ChatAgentState, type ChatPane, type NativeChatBridgeDeps } from '../nativeChatBridge';
import { OPENCODE_MAX_SEND_BYTES, fileHistoryEpoch, tuiHistoryEpoch } from '../chatBridge';

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
  const shell = { empty: true, revision: 0 };
  const pane: ChatPane = {
    meta: { id: 'pane', state: 'attached', pid: 100, cwd: '/live', env: {}, spawnCwd: '/spawn', incarnationId: 'inc' },
    bridge: { isEmptyShellPrompt: () => shell.empty, getInputRevision: () => shell.revision,
      noteInput: () => { shell.revision++; shell.empty = false; } },
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
    approvals: () => ({ pendingFor: () => state.pendingApproval }),
    readScreen: async () => state.screen,
    agentProcessAlive: async () => { await aliveGate; return true; },
    write: (_id, data) => { written.push(data); state.agent.inputRevision++; return true; },
    receipts: new ChatSendReceiptStore(dir),
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
