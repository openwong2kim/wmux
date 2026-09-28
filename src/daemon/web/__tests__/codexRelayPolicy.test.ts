import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_NOTIFICATIONS, CLIENT_REQUEST_CLASSES, PROTECTED_KEYS, classify, effectiveWmuxMcp, reviewClientFrame,
  splitDottedKey, threadIdentityEnv, threadIdsFromResponse, withIdentityConfig, withIdentityEnv, type PolicyContext,
} from '../codexRelayPolicy';

const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-app-server-methods.json'), 'utf8')) as
  { requests: string[]; notifications: string[] };

describe('method table', () => {
  it('classifies exactly the pinned protocol, so a new method fails closed until it is reviewed', () => {
    expect(Object.keys(CLIENT_REQUEST_CLASSES).sort()).toEqual([...pinned.requests].sort());
    expect([...CLIENT_NOTIFICATIONS].sort()).toEqual([...pinned.notifications].sort());
    expect(classify({ id: 1, method: 'thread/somethingNew' })).toEqual({ refuse: expect.any(String) });
    expect(classify({ method: 'somethingNew' })).toEqual({ refuse: expect.any(String) });
    expect(classify([{ id: 1, method: 'thread/list' }])).toEqual({ refuse: expect.any(String) });
    expect(classify({ id: 1, result: {} })).toBe('response');
    expect(classify({ id: 1.5, method: 'thread/list' })).toEqual({ refuse: expect.any(String) });
    expect(classify({ id: 2 ** 60, method: 'thread/list' })).toEqual({ refuse: expect.any(String) });
    expect(classify({ id: null, method: 'thread/list' })).toEqual({ refuse: expect.any(String) });
  });

  it('puts every thread-creating and command-running method outside "pass"', () => {
    for (const m of ['thread/start', 'thread/resume', 'thread/fork']) expect(CLIENT_REQUEST_CLASSES[m]).toBe('identity');
    expect(CLIENT_REQUEST_CLASSES['command/exec']).toBe('exec');
    expect(CLIENT_REQUEST_CLASSES['process/spawn']).toBe('exec');
    for (const m of ['environment/add', 'remoteControl/enable']) expect(CLIENT_REQUEST_CLASSES[m]).toBe('deny');
    for (const m of ['turn/start', 'turn/steer', 'thread/shellCommand', 'review/start', 'mcpServer/tool/call']) {
      expect(CLIENT_REQUEST_CLASSES[m]).toBe('ownThread');
    }
  });
});

describe('threadIdentityEnv', () => {
  it('sets every protected key; values only from the session record (routing/credential keys blank when absent)', () => {
    const env = threadIdentityEnv({ id: 'pty-a', env: { WMUX_WORKSPACE_ID: 'ws-a', WMUX_PTY_ID: 'forged', WMUX_AUTH_TOKEN: 'tok' } },
      { WMUX_DATA_SUFFIX: '-demo', WMUX_SOCKET_PATH: '/daemon', WMUX_AUTH_TOKEN: 'daemon-tok' });
    expect(Object.keys(env).sort()).toEqual([...PROTECTED_KEYS].sort());
    expect(env).toMatchObject({ WMUX_PTY_ID: 'pty-a', WMUX_WORKSPACE_ID: 'ws-a', WMUX_MEMBER_ID: 'pty-a',
      WMUX_AUTH_TOKEN: 'tok', WMUX_SOCKET_PATH: '', WMUX_DATA_SUFFIX: '-demo', WMUX_COMMANDER_TOKEN: '' });
  });
});

describe('withIdentityConfig', () => {
  const ID = { WMUX_PTY_ID: 'pty-a', WMUX_WORKSPACE_ID: 'ws-a' };
  it('removes client values in dotted and nested form, and writes the identity last', () => {
    const c = withIdentityConfig({
      'shell_environment_policy.set.WMUX_PTY_ID': 'x',
      shell_environment_policy: { set: { WMUX_WORKSPACE_ID: 'y', KEEP: '1' }, inherit: 'all' },
      'mcp_servers.wmux': { command: 'node', env: { WMUX_PTY_ID: 'z', OTHER: 'q' } },
      model: 'm',
    }, ID, { mcp: true })!;
    expect(c).toEqual({
      model: 'm',
      'shell_environment_policy.set.KEEP': '1',
      'shell_environment_policy.set.WMUX_PTY_ID': 'pty-a',
      'shell_environment_policy.set.WMUX_WORKSPACE_ID': 'ws-a',
      'shell_environment_policy.inherit': 'all',
      'mcp_servers.wmux.command': 'node',
      'mcp_servers.wmux.env.WMUX_PTY_ID': 'pty-a',
      'mcp_servers.wmux.env.WMUX_WORKSPACE_ID': 'ws-a',
    });
  });
  it('keeps the identity through an include_only list, from the client or the effective config', () => {
    expect(withIdentityConfig({ 'shell_environment_policy.include_only': ['PATH'] }, ID, { mcp: false })!['shell_environment_policy.include_only'])
      .toEqual(['PATH', 'WMUX_PTY_ID', 'WMUX_WORKSPACE_ID']);
    expect(withIdentityConfig({}, ID, { mcp: false, effectiveIncludeOnly: ['HOME'] })!['shell_environment_policy.include_only'])
      .toEqual(['HOME', 'WMUX_PTY_ID', 'WMUX_WORKSPACE_ID']);
  });
  it('refuses configs it cannot normalize', () => {
    expect(withIdentityConfig('x', ID, { mcp: false })).toBeUndefined();
    expect(withIdentityConfig({ 'shell_environment_policy.include_only': 'PATH' }, ID, { mcp: false })).toBeUndefined();
    expect(withIdentityConfig({ 'mcp_servers."a.b".command': 'x' }, ID, { mcp: false })).toBeUndefined();
  });
  it('splits quoted dotted keys', () => {
    expect(splitDottedKey('a."b.c".d')).toEqual(['a', 'b.c', 'd']);
    expect(splitDottedKey('a..b')).toBeUndefined();
  });
});

describe('withIdentityEnv / effectiveWmuxMcp / threadIdsFromResponse', () => {
  it('replaces WMUX_* in exec env and unsets blanks', () => {
    expect(withIdentityEnv({ WMUX_PTY_ID: 'x', A: 'b', WMUX_OTHER: 'y' }, { WMUX_PTY_ID: 'p', WMUX_SOCKET_PATH: '' }))
      .toEqual({ A: 'b', WMUX_PTY_ID: 'p', WMUX_SOCKET_PATH: null });
    expect(withIdentityEnv({ A: 1 }, {})).toBeUndefined();
  });
  it('reads the effective wmux MCP from config/read', () => {
    expect(effectiveWmuxMcp({ config: { mcp_servers: { wmux: { command: 'node' } } } })).toBe(true);
    expect(effectiveWmuxMcp({ config: { mcp_servers: {} } })).toBe(false);
    expect(effectiveWmuxMcp({ config: {} })).toBe(false);
    expect(effectiveWmuxMcp(undefined)).toBeUndefined();
  });
  it('takes thread ids from thread and review responses', () => {
    expect(threadIdsFromResponse('thread/fork', { thread: { id: 't2' } })).toEqual(['t2']);
    expect(threadIdsFromResponse('review/start', { reviewThreadId: 't3' })).toEqual(['t3']);
  });
});

describe('reviewClientFrame', () => {
  const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
    paneId: 'pty-a', identity: { WMUX_PTY_ID: 'pty-a' }, serverProven: false,
    owner: () => undefined,
    query: async (m) => (m === 'config/read' ? { config: { mcp_servers: { wmux: { command: 'node' } } } } : { data: [], nextCursor: null }),
    ...over,
  });
  it('fork carries this pane\'s identity; refused when the source belongs to another live pane', async () => {
    const ok = await reviewClientFrame({ id: 1, method: 'thread/fork', params: { threadId: 't1' } }, ctx());
    expect(ok).toMatchObject({ kind: 'forward', message: { params: { config: { 'mcp_servers.wmux.env.WMUX_PTY_ID': 'pty-a' } } } });
    const other = await reviewClientFrame({ id: 1, method: 'thread/fork', params: { threadId: 't1' } },
      ctx({ owner: () => ({ paneId: 'pty-b', live: true }) }));
    expect(other.kind).toBe('refuse');
  });
  it('a resume by path (no thread id) on an unproven server is refused; allowed once proven', async () => {
    const msg = { id: 1, method: 'thread/resume', params: { path: '/x.jsonl' } };
    expect((await reviewClientFrame(msg, ctx())).kind).toBe('refuse');
    expect((await reviewClientFrame(msg, ctx({ serverProven: true }))).kind).toBe('forward');
  });
  it('a client profile makes the MCP config undeterminable: refused unless proven, then no MCP override', async () => {
    const msg = { id: 1, method: 'thread/start', params: { config: { profile: 'p' } } };
    expect((await reviewClientFrame(msg, ctx())).kind).toBe('refuse');
    const v = await reviewClientFrame(msg, ctx({ serverProven: true }));
    expect(v.kind).toBe('forward');
    expect(JSON.stringify(v)).not.toContain('mcp_servers');
  });
  it('denied methods and remote execution environments are refused', async () => {
    expect((await reviewClientFrame({ id: 1, method: 'remoteControl/enable', params: {} }, ctx())).kind).toBe('refuse');
    expect((await reviewClientFrame({ id: 1, method: 'thread/start', params: { environments: [{ environmentId: 'e', cwd: '/' }] } },
      ctx({ serverProven: true }))).kind).toBe('refuse');
    const spawn = await reviewClientFrame({ id: 1, method: 'process/spawn', params: { command: ['x'], env: { WMUX_PTY_ID: 'x' } } }, ctx());
    expect(spawn).toMatchObject({ kind: 'forward', message: { params: { env: { WMUX_PTY_ID: 'pty-a' } } } });
  });
  it('command/exec without a committed pane is refused', async () => {
    expect((await reviewClientFrame({ id: 1, method: 'command/exec', params: { command: ['x'] } }, ctx({ identity: undefined }))).kind)
      .toBe('refuse');
  });
  it('turns run only on this pane\'s threads', async () => {
    const msg = { id: 1, method: 'turn/start', params: { threadId: 't1', input: [] } };
    expect((await reviewClientFrame(msg, ctx({ owner: () => ({ paneId: 'pty-a', live: true }) }))).kind).toBe('forward');
    expect((await reviewClientFrame(msg, ctx())).kind).toBe('refuse');
  });
});
