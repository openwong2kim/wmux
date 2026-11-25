// The chat-v2 host running a Codex chat: its decisions go to the registry
// under `via: 'chat-v2'` with the driver's tag and the card's revision, an
// answer reaches only the card the driver raised last, and what is Claude's
// alone (the terminal handoff, bypass) is refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRegistry } from '../../../approvals/ApprovalRegistry';
import { CodexDriver } from '../codex/codexDriver';
import { createChatV2Host } from '../host';
import type { ChatV2Host, ChatV2HostDeps, ChatV2TerminalDeps } from '../types';
import { FakeCodex, THREAD_ID } from './fakeCodex';
import { tick, until } from './fakeClaude';

vi.mock('../../../../shared/execEnv', () => ({
  agentExecEnv: async (env: NodeJS.ProcessEnv) => ({ ...env }),
}));

const PANE = 'pty-codex-1';
const DIFF = '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatv2-host-codex-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function rig(options: { owners?: (call: number) => string[]; nativeOn?: boolean; commandLine?: string; settingsUpdate?: 'ok' | 'refuse'; failWrite?: FakeCodex['failWrite'] } = {}) {
  let ownerCalls = 0;
  const killed: number[] = [];
  const clock = { now: 100_000 };
  const fakes: FakeCodex[] = [];
  // Set once below; the registry's answer path reads it lazily.
  const ref: { host?: ChatV2Host } = {};
  const registry = new ApprovalRegistry({
    wmuxDir: dir,
    now: () => clock.now,
    readScreenTail: async () => null,
    writeToSession: () => false,
    answerNative: async (native, reply, sessionId) => ref.host?.answerNative(native, reply, sessionId) ?? 'unavailable',
    phoneDecisions: () => ({ native: options.nativeOn ?? true, stepwise: true }),
  });
  const pane = { meta: { spawnCwd: dir, incarnationId: 'inc-1', env: { PATH: '/usr/bin', WMUX_WORKSPACE_ID: 'ws-1' }, cmd: '/bin/zsh' } };
  const deps: ChatV2HostDeps = {
    wmuxDir: dir,
    log: () => undefined,
    now: () => clock.now,
    sessionManager: { getSession: ((id: string) => (id === PANE ? pane : undefined)) as unknown as ChatV2HostDeps['sessionManager']['getSession'] },
    approvals: () => registry,
    paneFree: async () => true,
    writeToPane: () => true,
    sendTo: () => true,
    processIdentity: async () => ({ startTime: 'start-1', commandLine: options.commandLine ?? '' }),
    killTree: async (pid) => { killed.push(pid); },
    processProbe: () => 'gone',
    codexThreadOwners: (threadId) => (threadId === THREAD_ID ? options.owners?.(++ownerCalls) ?? [] : []),
    // Present, so a refusal is the agent's and not "unavailable".
    terminal: {} as ChatV2TerminalDeps,
    drivers: (agent) => {
      if (agent !== 'codex') return null;
      const fake = new FakeCodex();
      fake.settingsUpdate = options.settingsUpdate ?? 'ok';
      fake.failWrite = options.failWrite ?? null;
      fakes.push(fake);
      return new CodexDriver({ command: 'codex', backend: fake.backend() });
    },
  };
  const host = createChatV2Host(deps);
  ref.host = host;
  const binding = () => {
    const b = host.bindingForPane(PANE);
    if (!b) throw new Error('no chat');
    return b;
  };
  const create = async () => {
    const res = await host.call('create', { paneId: PANE, agent: 'codex', mode: 'default' }, 'main');
    if (!res.ok) throw new Error(res.error.code);
    return res.binding;
  };
  const send = (text = 'go', clientMessageId = 'msg-00001') =>
    host.call('send', { paneId: PANE, chatSessionId: binding().chatSessionId, epoch: binding().epoch, clientMessageId, text }, 'main');
  const pending = () => registry.list().pending.filter((p) => p.sessionId === PANE);
  return { host, registry, clock, killed, fakes, fake: () => fakes[fakes.length - 1], binding, create, send, pending };
}

describe('chat v2 host: a Codex chat', () => {
  it('changes effort on the thread between turns, and a refused level leaves the chat as it was and usable', async () => {
    const r = rig();
    const b = await r.create();
    r.fake().settingsUpdate = 'refuse';
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: 'xhigh' }, 'main'))
      .toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(r.host.sessionForPane(PANE)!.modelSettings.effort).toBeUndefined();
    expect(r.host.statusForPane(PANE)).toBe('idle');
    expect(r.fakes).toHaveLength(1);
    r.fake().settingsUpdate = 'ok';
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: 'high' }, 'main'))
      .toMatchObject({ ok: true, applied: 'live' });
    expect(r.fake().calls('thread/settings/update').at(-1)?.params).toMatchObject({ threadId: expect.any(String), effort: 'high' });
    expect(r.host.sessionForPane(PANE)!.modelSettings.effort).toBe('high');
    expect(await r.send()).toMatchObject({ ok: true });
    await r.host.dispose();
  });

  it('restarts when a change goes unanswered, and records the level the new process runs, not one it refused', async () => {
    const options: { settingsUpdate: 'ok' | 'refuse' } = { settingsUpdate: 'ok' };
    const r = rig(options);
    const b = await r.create();
    // The write fails: whether Codex took it is unknown, so it restarts with the change.
    r.fake().failWrite = (line) => line.method === 'thread/settings/update';
    options.settingsUpdate = 'refuse';
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: 'xhigh' }, 'main'))
      .toMatchObject({ ok: true, applied: 'restarted' });
    expect(r.fakes).toHaveLength(2);
    expect(r.host.sessionForPane(PANE)!.modelSettings.effort).toBe('');
    expect(await r.send()).toMatchObject({ ok: true });
    await r.host.dispose();
  });

  it('starts anyway when Codex refuses the effort a new chat asked for', async () => {
    const r = rig({ settingsUpdate: 'refuse' });
    const res = await r.host.call('create', { paneId: PANE, agent: 'codex', mode: 'default', effort: 'xhigh' }, 'main');
    expect(res).toMatchObject({ ok: true, binding: { status: 'idle' } });
    expect(r.fake().calls('thread/settings/update')).toHaveLength(1);
    await until(() => r.host.sessionForPane(PANE)?.modelSettings.effort === '');
    expect(await r.send()).toMatchObject({ ok: true });
    await r.host.dispose();
  });

  it('does not start when the effort a new chat asked for goes unanswered', async () => {
    const r = rig({ failWrite: (line) => line.method === 'thread/settings/update' });
    expect(await r.host.call('create', { paneId: PANE, agent: 'codex', mode: 'default', effort: 'xhigh' }, 'main')).toMatchObject({ ok: false });
    await r.host.dispose();
  });

  it('goes back to the default effort by a new thread before the first turn, and refuses it after one', async () => {
    const r = rig();
    const b = await r.create();
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: 'high' }, 'main')).toMatchObject({ ok: true, applied: 'live' });
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: '' }, 'main')).toMatchObject({ ok: true, applied: 'restarted' });
    expect(r.fakes).toHaveLength(2);
    expect(r.fake().calls('thread/start')).toHaveLength(1);
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: 'high' }, 'main')).toMatchObject({ ok: true, applied: 'live' });
    expect(await r.send()).toMatchObject({ ok: true });
    r.fake().note('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
    await until(() => r.host.statusForPane(PANE) === 'idle');
    // A resume keeps the thread's last level, so the default cannot be reached.
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: '' }, 'main')).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(r.fakes).toHaveLength(2);
    expect(r.host.sessionForPane(PANE)!.modelSettings.effort).toBe('high');
    await r.host.dispose();
  });

  it('with no agent running, refuses the default effort for a thread that has turns, and still saves a level', async () => {
    const r = rig();
    const b = await r.create();
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: 'high' }, 'main')).toMatchObject({ ok: true, applied: 'live' });
    await r.send();
    r.fake().note('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
    await until(() => r.host.statusForPane(PANE) === 'idle');
    r.fake().exit(1, null);
    await until(() => r.host.statusForPane(PANE) === 'stopped');
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: '' }, 'main')).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    expect(r.host.sessionForPane(PANE)!.modelSettings.effort).toBe('high');
    expect(await r.host.call('configure', { paneId: PANE, chatSessionId: b.chatSessionId, effort: 'xhigh' }, 'main')).toMatchObject({ ok: true, applied: 'saved' });
    expect(r.host.sessionForPane(PANE)!.modelSettings.effort).toBe('xhigh');
    await r.host.dispose();
  });

  it('records its decisions as chat-v2 Codex ones, and an answer approves only the card raised last', async () => {
    const r = rig();
    const b = await r.create();
    expect(b).toMatchObject({ agent: 'codex', capabilities: { toTerminal: false } });
    await r.send();
    // The approval before its item: a card that approves nothing yet.
    r.fake().request(3, 'item/fileChange/requestApproval', { itemId: 'fc_1' });
    await until(() => r.pending().length === 1);
    const first = r.pending()[0];
    expect(first).toMatchObject({ agent: 'codex', summary: 'File changes (details loading)', native: { adapter: 'codex', via: 'chat-v2', threadId: b.chatSessionId, relayId: b.epoch } });
    expect(first.native?.requestId).toMatch(/^[0-9a-f]{16}\.3$/);
    // The diff arrives: the card is raised again, a new record with a new revision.
    r.fake().note('item/started', { item: { type: 'fileChange', id: 'fc_1', status: 'inProgress', changes: [{ path: `${dir}/a.txt`, kind: { type: 'update' }, diff: DIFF }] } });
    await until(() => r.pending()[0]?.summary === 'a.txt +1 −1');
    const second = r.pending()[0];
    expect(r.pending()).toHaveLength(1);
    expect(second.native?.requestId).toBe(first.native?.requestId);
    expect(second.native?.digest).not.toBe(first.native?.digest);
    // An answer to the card shown before the change reaches nothing.
    if (!first.native) throw new Error('not native');
    expect(await r.host.answerNative(first.native, { decision: 'approve', formKind: 'permission' }, PANE)).toBe('changed');
    expect(r.fake().replies(3)).toEqual([]);
    r.clock.now += 2_000;
    // No automated resolver answers it, approve or deny (ApprovalRegistry resolveNative).
    for (const decision of ['approve', 'deny'] as const) {
      expect(await r.registry.resolve({ id: second.id, decision, resolvedBy: 'brain', resolver: 'automated' })).toMatchObject({ ok: false, reason: 'answer-in-terminal' });
    }
    expect(r.fake().replies(3)).toEqual([]);
    // The desktop's Allow carries the revision of the card it answers: it lands.
    expect(await r.host.call('answer', { paneId: PANE, chatSessionId: b.chatSessionId, requestId: '3', decision: 'allow' }, 'main')).toEqual({ ok: true });
    await until(() => r.fake().replies(3).length === 1);
    expect(r.fake().replies(3)[0].result).toEqual({ decision: 'accept' });
    await r.host.dispose();
  });

  it('with phone decisions off, the desktop\'s Allow still carries the card\'s revision', async () => {
    const r = rig({ nativeOn: false });
    const b = await r.create();
    await r.send();
    r.fake().note('item/started', { item: { type: 'commandExecution', id: 'call_1', command: 'touch a', status: 'inProgress' } });
    r.fake().request(5, 'item/commandExecution/requestApproval', { itemId: 'call_1', command: 'touch a', availableDecisions: ['accept', 'decline'] });
    await until(() => r.pending().length === 1);
    expect(r.pending()[0].channel).toBe('none');
    // The registry lists the card before the host has stamped it (notedAt is set
    // once noteNativeDecision returns); the card block follows that stamp, so the
    // clock moves only after it, as a person's click would.
    await until(() => !!r.host.sessionForPane(PANE)?.blocks.some((b) => b.approval?.requestId === '5'));
    r.clock.now += 2_000;
    expect(await r.host.call('answer', { paneId: PANE, chatSessionId: b.chatSessionId, requestId: '5', decision: 'allow' }, 'main')).toEqual({ ok: true });
    await until(() => r.fake().replies(5).length === 1);
    expect(r.fake().replies(5)[0].result).toEqual({ decision: 'accept' });
    await r.host.dispose();
  });

  it('labels Deny by what it sends, and keeps a restarted driver\'s request apart from one already settled', async () => {
    const r = rig();
    const b = await r.create();
    await r.send();
    r.fake().note('item/started', { item: { type: 'commandExecution', id: 'call_1', command: 'rm -rf build', status: 'inProgress' } });
    r.fake().request(0, 'item/commandExecution/requestApproval', { itemId: 'call_1', command: 'rm -rf build', availableDecisions: ['accept', 'cancel'] });
    await until(() => r.pending().length === 1);
    expect(r.pending()[0].form?.actions).toEqual([{ id: 'approve', label: 'Allow once' }, { id: 'deny', label: 'No, stop the turn' }]);
    r.clock.now += 2_000;
    expect(await r.host.call('answer', { paneId: PANE, chatSessionId: b.chatSessionId, requestId: '0', decision: 'deny' }, 'main')).toEqual({ ok: true });
    await until(() => r.fake().replies(0).length === 1);
    expect(r.fake().replies(0)[0].result).toEqual({ decision: 'cancel' });

    // A new Codex process numbers its requests from 0 again: still a card of its own.
    expect(await r.host.call('close', { paneId: PANE, chatSessionId: b.chatSessionId }, 'main')).toEqual({ ok: true });
    await r.create();
    await r.send();
    r.fake().note('item/started', { item: { type: 'commandExecution', id: 'call_9', command: 'ls', status: 'inProgress' } });
    r.fake().request(0, 'item/commandExecution/requestApproval', { itemId: 'call_9', command: 'ls', availableDecisions: ['accept', 'decline'] });
    await until(() => r.pending().length === 1);
    await tick(20);
    expect(r.fake().replies(0)).toEqual([]);
    await r.host.dispose();
  });

  it('refuses bypass, the terminal handoff both ways, and a resume while a terminal Codex holds the thread', async () => {
    const r = rig({ owners: () => ['pty-other'] });
    expect(await r.host.call('create', { paneId: PANE, agent: 'codex', mode: 'bypass' }, 'main')).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    const b = await r.create();
    expect(await r.host.call('toTerminal', { paneId: PANE, chatSessionId: b.chatSessionId }, 'main')).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    expect(await r.host.call('fromTerminal', { paneId: PANE, preview: true }, 'main')).toMatchObject({ ok: false, error: { code: 'handoff-refused' } });
    await r.send();
    r.fake().note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await until(() => r.host.statusForPane(PANE) === 'idle');
    // The process goes; the next turn resumes the thread, which a terminal Codex now has selected.
    r.fake().exit(1, null);
    await until(() => r.host.statusForPane(PANE) === 'stopped');
    const res = await r.send('again', 'msg-00002');
    expect(res).toMatchObject({ ok: false, error: { code: 'agent-running-in-pane', message: expect.stringContaining('terminal Codex') } });
    // Refused before a second app-server could load the thread.
    expect(r.fakes).toHaveLength(1);
    await r.host.dispose();
  });

  it('stops a resumed chat whose thread a terminal Codex took while it was starting', async () => {
    // Free before the spawn, held by the time the driver is up.
    const r = rig({ owners: (call) => (call > 1 ? ['pty-other'] : []) });
    await r.create();
    await r.send();
    r.fake().note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await until(() => r.host.statusForPane(PANE) === 'idle');
    r.fake().exit(1, null);
    await until(() => r.host.statusForPane(PANE) === 'stopped');
    expect(await r.send('again', 'msg-00002')).toMatchObject({ ok: false, error: { code: 'agent-running-in-pane', message: expect.stringContaining('The chat was stopped') } });
    expect(r.fakes[1].calls('thread/resume')).toHaveLength(1);
    await until(() => r.fakes[1].exited);
    await r.host.dispose();
  });

  it('gives way when a terminal Codex in another pane selects its thread (#2730)', async () => {
    const r = rig();
    await r.create();
    await r.send();
    r.fake().note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await until(() => r.host.statusForPane(PANE) === 'idle');
    expect(r.binding().providerSessionId).toBe(THREAD_ID);
    r.host.terminalHolds('pty-other', 'codex', '019a1b2c-3d4e-7f60-8a9b-ffffffffffff', true);
    r.host.terminalHolds(PANE, 'codex', THREAD_ID, true);
    await tick(20);
    expect(r.host.statusForPane(PANE)).toBe('idle');
    r.host.terminalHolds('pty-other', 'codex', THREAD_ID, true);
    await until(() => r.host.statusForPane(PANE) === 'handed-off');
    expect(r.binding()).toMatchObject({ continuedIn: { paneId: 'pty-other' } });
    await until(() => r.fakes[0].exited);
    expect(r.host.activeSessionIds()).toEqual([]);
    expect(await r.send('again', 'msg-00002')).toMatchObject({ ok: false, error: { code: 'handed-off' } });
    expect(r.fakes).toHaveLength(1);
    await r.host.dispose();
  });

  it('a daemon that starts again stops the app-server the last one left, by the chat id in its argv', async () => {
    const first = rig();
    const b = await first.create();
    // A card left open in the transcript, its id a bare 3.
    await first.send();
    first.fake().note('item/started', { item: { type: 'commandExecution', id: 'call_1', command: 'ls', status: 'inProgress' } });
    first.fake().request(3, 'item/commandExecution/requestApproval', { itemId: 'call_1', command: 'ls', availableDecisions: ['accept', 'decline'] });
    await until(() => first.pending().length === 1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'chat-sessions', 'v2', `${b.chatSessionId}.json`), 'utf8')) as { process?: { pid: number; marker: string } };
    expect(saved.process?.marker).toBe(b.chatSessionId);
    const pid = saved.process?.pid;
    // The daemon dies: nothing is disposed, the record keeps the process.
    const again = rig({ commandLine: `codex -c wmux_chat_session="${b.chatSessionId}" app-server --listen stdio://` });
    // A terminal Codex card on this pane under the same bare id: not the dead process's.
    const relayCard = await again.registry.noteNativeDecision({
      sessionId: PANE, agent: 'codex', native: { adapter: 'codex', requestId: '3', threadId: THREAD_ID, relayId: 'relay-1' },
      form: { v: 1, kind: 'permission', actions: [{ id: 'approve', label: 'Allow once' }, { id: 'deny', label: 'Reject' }] }, question: 'Run ls?', toolName: 'Shell', summary: 'ls',
    });
    await again.host.start();
    expect(again.killed).toEqual([pid]);
    expect(again.pending().map((p) => p.id)).toEqual([relayCard]);
    const other = rig({ commandLine: 'codex app-server --listen stdio://' });
    await other.host.start();
    expect(other.killed).toEqual([]);
    // Every host this test started is stopped before the folder is removed:
    // dispose() waits for the write-back of the records each one loaded. One
    // at a time, since all three hold the same record.
    await other.host.dispose();
    await again.host.dispose();
    await first.host.dispose();
  });
});
