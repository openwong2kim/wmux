import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWmuxMcpProbe, rewriteThreadFrame, threadIdentityEnv } from '../codexThreadIdentity';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('threadIdentityEnv', () => {
  it('takes identity from the session record and blanks what the pane lacks', () => {
    const env = threadIdentityEnv(
      { id: 'pty-a', env: { WMUX_WORKSPACE_ID: 'ws-a', WMUX_MEMBER_ID: 'm-a', WMUX_PTY_ID: 'forged', WMUX_SOCKET_PATH: '/pane.sock' } },
      { WMUX_DATA_SUFFIX: '-demo', WMUX_SOCKET_PATH: '/daemon.sock' },
    );
    expect(env).toEqual({
      WMUX_PTY_ID: 'pty-a', WMUX_WORKSPACE_ID: 'ws-a', WMUX_WORKSPACE_NAME: '', WMUX_SURFACE_ID: '',
      WMUX_MEMBER_ID: 'm-a', WMUX_SOCKET_PATH: '/pane.sock', WMUX_DATA_SUFFIX: '-demo',
    });
  });

  it('defaults the member id to the pane id', () => {
    expect(threadIdentityEnv({ id: 'web-1', env: {} }, {}).WMUX_MEMBER_ID).toBe('web-1');
  });
});

describe('rewriteThreadFrame', () => {
  const id = { WMUX_PTY_ID: 'pty-a' };
  it('passes non-thread and title frames', () => {
    expect(rewriteThreadFrame({ id: 1, method: 'turn/start', params: {} }, id, { mcp: true })).toEqual({ kind: 'pass' });
    expect(rewriteThreadFrame({ id: 1, method: 'thread/start', params: { ephemeral: true, threadSource: 'thread_title' } }, id, { mcp: true }))
      .toEqual({ kind: 'pass' });
  });
  it('refuses without identity or with malformed params/config', () => {
    expect(rewriteThreadFrame({ id: 1, method: 'thread/start' }, undefined, { mcp: true }).kind).toBe('refuse');
    expect(rewriteThreadFrame({ id: 1, method: 'thread/start', params: [] }, id, { mcp: true }).kind).toBe('refuse');
    expect(rewriteThreadFrame({ id: 1, method: 'thread/resume', params: { config: [1] } }, id, { mcp: true }).kind).toBe('refuse');
  });
  it('accepts a frame with no params at all', () => {
    const r = rewriteThreadFrame({ id: 1, method: 'thread/start' }, id, { mcp: false });
    expect(r).toEqual({ kind: 'rewrite', message: { id: 1, method: 'thread/start', params: { config: { 'shell_environment_policy.set.WMUX_PTY_ID': 'pty-a' } } } });
  });
});

describe('createWmuxMcpProbe', () => {
  it('is true only when config.toml defines a command-based wmux server', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-cfg-')); dirs.push(home);
    const probe = createWmuxMcpProbe(home);
    expect(probe()).toBe(false);
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n[mcp_servers.other]\ncommand = "node"\n');
    expect(probe()).toBe(false);
    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.wmux]\ncommand = "node"\nargs = ["/x.js"]\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(home, 'config.toml'), later, later);
    expect(probe()).toBe(true);
  });
});
