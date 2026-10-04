import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { readThreadOwner, resolveThreadOwner, attributeThread, notifierOrigin } from '../bin/wmux-codex-thread.mjs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { persistCodexThreadOwner, invalidateCodexThreadOwner, trackCodexPaneOwnerCleanup } from '../../../src/daemon/web/codexThreadOwner';

const bin = path.join(__dirname, '..', 'bin');
const ROOT = '01a0582a-52b6-7a50-aaba-07e35bd05aba';
const OTHER = '01a0582a-52b6-7a50-aaba-07e35bd05abb';
const CHILD = '01a0582a-52b6-7a50-aaba-07e35bd05abc';
const SHARED = 'codex\x1fapp-server\x1f--managed-daemon\x1f';

describe('thread ownership across a shared app-server', { timeout: 20_000 }, () => {
  let home: string;
  let pipe: string;
  let server: net.Server;
  let received: any[];
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-attribution-'));
    pipe = process.platform === 'win32' ? `\\\\.\\pipe\\wmux-attribution-${randomUUID()}`
      : path.join(os.tmpdir(), `wa-${randomUUID()}.sock`);
    received = [];
    env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('WMUX_')) delete env[key];
    Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
      WMUX_CODEX_NOTIFIER_ARGV: 'codex\x1f', WMUX_DATA_SUFFIX: '-owner', WMUX_PIPE_NAME: pipe, WMUX_PTY_ID: 'pane-a', WMUX_WORKSPACE_ID: 'workspace-a' });
    rollout(ROOT, 'cli');
    rollout(OTHER, 'cli');
    fs.writeFileSync(path.join(home, '.wmux-owner-auth-token'), 'owner-token');
    server = net.createServer(socket => {
      let data = '';
      socket.on('data', chunk => {
        data += chunk;
        const nl = data.indexOf('\n');
        if (nl < 0) return;
        const request = JSON.parse(data.slice(0, nl));
        received.push(request);
        socket.end(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + '\n');
      });
      socket.on('error', () => {});
    });
    await new Promise<void>(resolve => server.listen(pipe, resolve));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  async function run(hook: boolean, id: string, extra: NodeJS.ProcessEnv = {}, event = 'SessionStart') {
    const payload = hook ? { hook_event_name: event, session_id: id, cwd: home, source: 'startup' }
      : { type: 'agent-turn-complete', 'thread-id': id, cwd: home };
    const child = spawn(process.execPath, [path.join(bin, hook ? 'wmux-codex-hooks-bridge.mjs' : 'wmux-codex-notify.mjs'),
      ...(hook ? [] : [JSON.stringify(payload)])], { env: { ...env, ...extra }, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.end(hook ? JSON.stringify(payload) : '');
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.on('exit', resolve));
    expect(stderr).toBe('');
    expect(code).toBe(0);
  }
  function rollout(id: string, source: unknown) {
    const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    const date = new Date(ms);
    const dir = path.join(env.CODEX_HOME!, 'sessions', String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-test-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, source } }) + '\n');
  }
  it('keeps a direct process in pane B even when pane A owns the recorded thread', async () => {
    await run(true, ROOT);
    received.length = 0;
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: 'codex\x1fresume\x1f', WMUX_PTY_ID: 'pane-b' });
    expect(received.map(r => r.params.ptyId)).toEqual(['pane-b']);
    received.length = 0;
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: 'codex\x1f', WMUX_PTY_ID: '' });
    expect(received).toEqual([]);
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: 'codex\x1f', WMUX_PTY_ID: '',
      WMUX_WORKSPACE_ID: '', WMUX_SURFACE_ID: '', WMUX_DATA_SUFFIX: '' });
    expect(received).toEqual([]);
  });
  it('preserves pane delivery for an unknown origin, including permission hooks', async () => {
    const unknown = { WMUX_CODEX_NOTIFIER_ARGV: 'node\x1f/x/wmux-codex-notify.mjs\x1f' };
    await run(false, ROOT, unknown);
    await run(true, ROOT, unknown, 'PermissionRequest');
    expect(received.map(r => r.params.kind)).toEqual(['agent.stop', 'agent.awaiting_input']);
    expect(received.every(r => r.params.ptyId === 'pane-a')).toBe(true);
  });
  it('invalidates an on-disk pointer for a recovered pane with no in-memory snapshot', async () => {
    const pane = { id: 'relay-pane', env: env as Record<string, string> };
    persistCodexThreadOwner(pane, { live: true, selection: { threadId: ROOT, cwd: home, generation: 1 } }, env.CODEX_HOME!, env);
    expect(readThreadOwner(ROOT, env)).toBeDefined();
    persistCodexThreadOwner({ ...pane }, { live: true }, env.CODEX_HOME!, env);
    expect(readThreadOwner(ROOT, env)).toBeUndefined();
  });
  it('propagates ENOSPC during a switch instead of keeping the old owner usable', () => {
    const pane = { id: 'relay-pane', env: env as Record<string, string> };
    persistCodexThreadOwner(pane, { live: true, selection: { threadId: ROOT, cwd: home, generation: 1 } }, env.CODEX_HOME!, env);
    const fail = vi.spyOn(mutableFs, 'writeFileSync').mockImplementation(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
    try {
      expect(() => persistCodexThreadOwner(pane, { live: true, selection: { threadId: OTHER, cwd: home, generation: 2 } }, env.CODEX_HOME!, env)).toThrow('disk full');
    } finally { fail.mockRestore(); }
    expect(readThreadOwner(ROOT, env)).toBeUndefined();
  });
  it('does not bind or record an unconfirmed SessionStart, then binds a confirmed Stop', async () => {
    await run(true, CHILD);
    expect(received[0]?.params.agentSessionId).toBeUndefined();
    expect(readThreadOwner(CHILD, env)).toBeUndefined();
    rollout(CHILD, 'cli');
    await run(true, CHILD, {}, 'Stop');
    expect(received[1]?.params.agentSessionId).toBe(CHILD);
  });
  it('records in the relay account even when pane.env names a different account', async () => {
    const attachedHome = path.join(home, 'attached-account');
    const pane = { id: 'relay-pane', env: env as Record<string, string> };
    persistCodexThreadOwner(pane, { live: true, selection: { threadId: ROOT, cwd: home, generation: 1 } }, attachedHome, env);
    expect(readThreadOwner(ROOT, env)).toBeUndefined();
    await run(false, ROOT, { CODEX_HOME: attachedHome, WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    expect(received.map(r => r.params.ptyId)).toEqual(['relay-pane']);
    invalidateCodexThreadOwner(pane, attachedHome, env);
    expect(readThreadOwner(ROOT, { ...env, CODEX_HOME: attachedHome })).toBeUndefined();
  });
  it.each(['session:died', 'session:destroyed'])('revokes a direct launch when %s closes its pane', async event => {
    const events = new EventEmitter();
    const onError = vi.fn();
    trackCodexPaneOwnerCleanup(events, env.CODEX_HOME!, onError, env);
    events.emit('session:created', { session: { id: 'pane-a', env } });
    await run(true, ROOT);
    expect(readThreadOwner(ROOT, env)).toBeDefined();
    events.emit(event, { id: 'pane-a' });
    expect(readThreadOwner(ROOT, env)).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
  it('retries an early missing owner once for 75ms and then routes the first turn', async () => {
    const delay = vi.fn(async (ms: number) => {
      expect(ms).toBe(75);
      persistCodexThreadOwner({ id: 'relay-pane', env: env as Record<string, string> },
        { live: true, selection: { threadId: ROOT, cwd: home, generation: 1 } }, env.CODEX_HOME!, env);
    });
    const routedEnv = { ...env };
    const readOwner = vi.fn(readThreadOwner);
    const resolveOwner = (id: string, target: NodeJS.ProcessEnv) => resolveThreadOwner(id, target, { delay, readOwner });
    expect(await attributeThread('shared-server', { rootId: ROOT }, routedEnv, resolveOwner)).toBe(true);
    expect(routedEnv.WMUX_PTY_ID).toBe('relay-pane');
    expect(delay).toHaveBeenCalledTimes(1);
    expect(readOwner).toHaveBeenCalledTimes(2);
    const missing = vi.fn(() => undefined);
    const noWait = vi.fn(async () => {});
    expect(await resolveThreadOwner(OTHER, env, { readOwner: missing, delay: noWait })).toBeUndefined();
    expect(missing).toHaveBeenCalledTimes(2);
    expect(noWait).toHaveBeenCalledTimes(1);
  });
  it('routes a no-identity record only after confirming a clean shared server', async () => {
    const pane = { id: 'pane-a', env: env as Record<string, string> };
    persistCodexThreadOwner(pane, { live: true, selection: { threadId: ROOT, cwd: home, generation: 1 } }, env.CODEX_HOME!, env);
    const clean = { HOME: home, CODEX_HOME: env.CODEX_HOME };
    expect(await attributeThread('unclaimed', { rootId: ROOT }, { ...clean }, resolveThreadOwner, () => 'process')).toBe(false);
    expect(await attributeThread('unclaimed', { rootId: ROOT }, { ...clean }, resolveThreadOwner, () => 'unknown')).toBe(false);
    const target = { ...clean };
    expect(await attributeThread('unclaimed', { rootId: ROOT }, target, resolveThreadOwner, () => 'shared-server')).toBe(true);
    expect(target).toHaveProperty('WMUX_PTY_ID', 'pane-a');
  });
  it('does not walk ancestors without an inherited identity', () => {
    const readChain = vi.fn(() => [['codex']]);
    expect(notifierOrigin({}, readChain)).toBe('unclaimed');
    expect(readChain).not.toHaveBeenCalled();
    expect(notifierOrigin(env, readChain)).toBe('process');
    expect(readChain).toHaveBeenCalledTimes(1);
  });
  it('propagates invalidation failure so the caller cannot forward a selection switch', () => {
    const pane = { id: 'relay-pane', env: env as Record<string, string> };
    persistCodexThreadOwner(pane, { live: true, selection: { threadId: ROOT, cwd: home, generation: 1 } }, env.CODEX_HOME!, env);
    const fail = vi.spyOn(mutableFs, 'unlinkSync').mockImplementation(() => { throw Object.assign(new Error('unlink refused'), { code: 'EPERM' }); });
    try { expect(() => persistCodexThreadOwner(pane, { live: true }, env.CODEX_HOME!, env)).toThrow('unlink refused'); }
    finally { fail.mockRestore(); }
  });
  it('routes a shared-server turn after the TUI relay selects it, without a pane-side hook', async () => {
    const pane = { id: 'relay-pane', env: env as Record<string, string> };
    persistCodexThreadOwner(pane, { live: true, selection: { threadId: ROOT, cwd: home, generation: 1 } }, env.CODEX_HOME!, env);
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED, WMUX_DATA_SUFFIX: '-foreign', WMUX_PIPE_NAME: 'wrong' });
    expect(received.map(r => r.params.ptyId)).toEqual(['relay-pane']);
    received.length = 0;
    persistCodexThreadOwner(pane, { live: true }, env.CODEX_HOME!, env);
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    expect(received).toEqual([]);
  });
  it('keeps relay ownership on link loss and does not reclaim it on repeated state notifications', async () => {
    const pane = { id: 'relay-pane', env: env as Record<string, string> };
    const observed = { live: true as const, selection: { threadId: ROOT, cwd: home, generation: 1 } };
    persistCodexThreadOwner(pane, observed, env.CODEX_HOME!, env);
    persistCodexThreadOwner(pane, { live: false }, env.CODEX_HOME!, env);
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    expect(received.map(r => r.params.ptyId)).toEqual(['relay-pane']);
    await run(true, ROOT, { WMUX_PTY_ID: 'attached-pane' });
    persistCodexThreadOwner(pane, observed, env.CODEX_HOME!, env);
    received.length = 0;
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    expect(received.map(r => r.params.ptyId)).toEqual(['attached-pane']);
  });
  it('delivers both threads to their TUI panes despite one shared server environment', async () => {
    await run(true, ROOT);
    await run(true, OTHER, { WMUX_PTY_ID: 'pane-b', WMUX_WORKSPACE_ID: 'workspace-b' });
    received.length = 0;
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    await run(false, OTHER, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    expect(received.map(r => [r.params.agentSessionId, r.params.ptyId, r.params.workspaceId])).toEqual([
      [ROOT, 'pane-a', 'workspace-a'], [OTHER, 'pane-b', 'workspace-b'],
    ]);
  });
  it('ignores the shared server suffix and endpoint from another instance', async () => {
    await run(true, ROOT);
    received.length = 0;
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED, WMUX_DATA_SUFFIX: '-foreign', WMUX_PIPE_NAME: 'wrong-pipe' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ token: 'owner-token', params: { ptyId: 'pane-a' } });
    expect(fs.existsSync(path.join(home, '.wmux-foreign', 'resume-spool'))).toBe(false);
  });
  it('drops an unknown thread, including a server with no pane identity', async () => {
    await run(false, OTHER, { WMUX_CODEX_NOTIFIER_ARGV: SHARED, WMUX_PTY_ID: '', WMUX_WORKSPACE_ID: '' });
    expect(received).toEqual([]);
    expect(fs.existsSync(path.join(home, '.wmux-owner', 'resume-spool'))).toBe(false);
  });
  it('does not let a shared-server SessionStart overwrite TUI ownership', async () => {
    await run(true, ROOT);
    await run(true, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED, WMUX_PTY_ID: 'stale-pane' });
    received.length = 0;
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    expect(received[0]?.params.ptyId).toBe('pane-a');
  });
  it('routes a shared sub-agent completion through its root owner without a binding id', async () => {
    rollout(ROOT, 'cli');
    rollout(CHILD, { subagent: { thread_spawn: { parent_thread_id: ROOT } } });
    await run(true, ROOT, { WMUX_PTY_ID: 'root-pane' });
    received.length = 0;
    await run(false, CHILD, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    expect(received).toHaveLength(1);
    expect(received[0].params).toMatchObject({ kind: 'agent.subagent_stop', ptyId: 'root-pane' });
    expect(received[0].params.agentSessionId).toBeUndefined();
  });
  it('invalidates the old thread when the pane starts or resumes another conversation', async () => {
    await run(true, ROOT);
    await run(true, OTHER);
    received.length = 0;
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    await run(false, OTHER, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    expect(received.map(r => r.params.agentSessionId)).toEqual([OTHER]);
  });
  it('moves ownership when a TUI attaches in a new pane', async () => {
    await run(true, ROOT);
    await run(true, ROOT, { WMUX_PTY_ID: 'attached-pane' });
    received.length = 0;
    await run(false, ROOT, { WMUX_CODEX_NOTIFIER_ARGV: SHARED });
    expect(received.map(r => r.params.ptyId)).toEqual(['attached-pane']);
  });
  it('sub-agent Stop and SessionStart never move the resume binding or spool', async () => {
    rollout(ROOT, 'cli');
    rollout(CHILD, { subagent: { thread_spawn: { parent_thread_id: ROOT } } });
    await run(true, ROOT);
    received.length = 0;
    await run(true, CHILD, {}, 'Stop');
    await run(true, CHILD);
    expect(received.map(r => r.params.kind)).toEqual(['agent.subagent_stop', 'agent.subagent_stop']);
    expect(received.every(r => !('agentSessionId' in r.params) && !('transcript_path' in r.params.payload))).toBe(true);
    fs.rmSync(path.join(home, '.wmux-owner-auth-token'));
    await run(true, CHILD, {}, 'Stop');
    expect(fs.existsSync(path.join(home, '.wmux-owner', 'resume-spool'))).toBe(false);
  });
});
