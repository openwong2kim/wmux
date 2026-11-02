// @wmux-lane integration
// Builds a real Hermes SQLite database in a temp folder (hermesFixture) and reads it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { HermesChatService, routeTerminalChat, type HermesChatDeps } from '../HermesChatService';
import { agentLaunchAt } from '../../agentLaunchAt';
import type { TerminalChatService } from '../TerminalChatService';
import { addMessage, addSession, hermesFixture } from './hermesFixture';

const RULE = '─'.repeat(80);
const prompt = (row: string) => ['Welcome to Hermes Agent!', ' ⚕ glm-5.2 │ ctx -- │ 2s ', RULE, row, RULE];

const writers: DatabaseSync[] = [];
afterEach(() => { for (const w of writers.splice(0)) { try { w.close(); } catch { /* closed */ } } });

function rig(overrides: Partial<HermesChatDeps> = {}) {
  const { home, writer } = hermesFixture('v0.19.0');
  writers.push(writer);
  const launchedAt = Date.now() - 60_000;
  addSession(writer, { id: '20261029_053840_ec122e', cwd: '/w/proj', startedAt: launchedAt + 10_000 });
  addMessage(writer, { session: '20261029_053840_ec122e', role: 'user', content: 'hello' });
  addMessage(writer, { session: '20261029_053840_ec122e', role: 'assistant', content: 'Hi.' });
  const writes: string[] = [];
  let screen = prompt('❯ ');
  let revision = 0;
  const deps: HermesChatDeps = {
    isHermes: (id) => id === 'p1',
    pane: () => ({ cwd: '/w/proj', env: { HERMES_HOME: home }, incarnationId: 'inc-1' }),
    launchAt: () => launchedAt,
    sharesFolder: () => false,
    readScreen: async () => screen,
    bracketedPaste: () => true,
    keyInput: () => ({ revision, quiet: true }),
    processAlive: async () => true,
    write: (_id, data) => { writes.push(data); revision++; return true; },
    emit: vi.fn(),
    delay: async () => undefined,
    ...overrides,
  };
  return { service: new HermesChatService(deps), writer, writes, setScreen: (rows: string[]) => { screen = rows; } };
}

describe('HermesChatService', () => {
  it('reads the pane\'s Hermes conversation, with send open only at the empty prompt', async () => {
    const { service, setScreen } = rig();
    expect(await service.read('other')).toBeNull();
    const read = await service.read('p1');
    expect(read?.status).toMatchObject({ available: true, agentSessionId: '20261029_053840_ec122e', agentStatus: 'complete',
      terminal: { agent: 'hermes', capabilities: { history: true, send: true, cancel: false } } });
    expect(read?.page.events.map((e) => e.kind)).toEqual(['user_text', 'assistant_text']);
    setScreen(prompt('⚕ ❯ '));
    expect((await service.read('p1'))?.status).toMatchObject({ agentStatus: 'running', terminal: { capabilities: { send: false } } });
    setScreen(prompt('⚠ ❯ '));
    expect((await service.read('p1'))?.status).toMatchObject({ agentStatus: 'awaiting_input', terminal: { capabilities: { send: false } } });
    setScreen(prompt('❯ draft the user is typing'));
    expect((await service.read('p1'))?.status.terminal?.capabilities.send).toBe(false);
  });

  it('binds a Hermes whose shell reported no command start, by its process start', async () => {
    // No OSC 133 command start (a shell without wmux integration): the launch
    // time is the Hermes process's own start, recorded on its launch edge.
    const startedAt = Date.now() - 60_000;
    const { service } = rig({ launchAt: () => agentLaunchAt(undefined, [undefined, { pid: 4242, startedAt }], 4242) });
    expect((await service.read('p1'))?.status).toMatchObject({ available: true, agentSessionId: '20261029_053840_ec122e' });
  });

  it('binds nothing it cannot tell apart', async () => {
    expect((await rig({ sharesFolder: () => true }).service.read('p1'))?.status).toMatchObject({ available: false, reason: 'stale-session' });
    expect((await rig({ launchAt: () => undefined }).service.read('p1'))?.status).toMatchObject({ available: false, reason: 'stale-session' });
    // A session from before this Hermes started is an earlier conversation.
    expect((await rig({ launchAt: () => Date.now() }).service.read('p1'))?.status).toMatchObject({ available: false, reason: 'stale-session' });
  });

  it('types a send into the prompt as one bracketed paste, then Enter', async () => {
    const { service, writes } = rig();
    const epoch = (await service.read('p1'))!.page.cursor.historyEpoch;
    expect(await service.send('p1', '20261029_053840_ec122e', 'fix the\ntests', 'm1', { expectedRawEpoch: epoch })).toEqual({ result: 'sent' });
    expect(writes).toEqual(['\x1b[200~fix the\ntests\x1b[201~', '\r']);
  });

  it('refuses before writing when the conversation or the prompt moved', async () => {
    const { service, writes, setScreen, writer } = rig();
    const epoch = (await service.read('p1'))!.page.cursor.historyEpoch;
    expect(await service.send('p1', 'another-session', 'x', 'm1')).toEqual({ result: 'session_changed' });
    setScreen(prompt('⚕ ❯ '));
    expect(await service.send('p1', '20261029_053840_ec122e', 'x', 'm2')).toEqual({ result: 'busy' });
    setScreen(prompt('⚠ ❯ '));
    expect(await service.send('p1', '20261029_053840_ec122e', 'x', 'm3')).toEqual({ result: 'blocked' });
    setScreen(prompt('❯ '));
    writer.exec('UPDATE messages SET active = 0');
    expect(await service.send('p1', '20261029_053840_ec122e', 'x', 'm4', { expectedRawEpoch: epoch })).toEqual({ result: 'session_changed' });
    expect(writes).toEqual([]);
  });

  it('a withdrawn grant types nothing; a key typed after the paste stops the Enter', async () => {
    const denied = rig();
    expect(await denied.service.send('p1', '20261029_053840_ec122e', 'x', 'm1', { authorized: async () => false })).toEqual({ result: 'error', reason: 'unauthorized' });
    expect(denied.writes).toEqual([]);
    let revision = 0;
    const raced = rig({ keyInput: () => ({ revision, quiet: true }), write: (_id, data) => { raced.writes.push(data); revision += 2; return true; } });
    expect(await raced.service.send('p1', '20261029_053840_ec122e', 'x', 'm2')).toEqual({ result: 'unconfirmed', reason: 'transport-lost' });
    expect(raced.writes).toEqual(['\x1b[200~x\x1b[201~']);
  });

  it('the router sends a Hermes pane here and every other pane to OpenCode', async () => {
    const { service } = rig();
    const openCode = { read: vi.fn(async () => null), inspect: vi.fn(async () => ({ failure: 'no-record' as const })), send: vi.fn(),
      abort: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() } as unknown as TerminalChatService;
    const router = routeTerminalChat(() => openCode, service);
    expect((await router.inspect('p1'))).toHaveProperty('read');
    expect(openCode.inspect).not.toHaveBeenCalled();
    expect(await router.inspect('p2')).toEqual({ failure: 'no-record' });
    expect(openCode.inspect).toHaveBeenCalledWith('p2');
    expect(await routeTerminalChat(() => null, service).inspect('p2')).toEqual({ failure: 'no-record' });
  });
});
