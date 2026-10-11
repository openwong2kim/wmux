import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The pane-side writer (hooks bridge) and the MCP server's reader must agree
// on the v1 owner files byte for byte: digests, pointer names, env keys.
import { recordThreadOwner, readThreadOwner } from '../bin/wmux-codex-thread.mjs';
import { matchOwnerToLiveAnchor, readCodexThreadOwner } from '../../../src/mcp/codexThreadIdentity';

const T1 = '019a0000-0000-7000-8000-000000000001';
const T2 = '019a0000-0000-7000-8000-000000000002';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-win-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** A pane env as wmux stamps it on Windows (named pipe, no HOME). */
function paneEnv(ptyId: string, workspaceId: string, suffix = ''): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: home,
    WMUX_PTY_ID: ptyId,
    WMUX_WORKSPACE_ID: workspaceId,
    WMUX_SURFACE_ID: `surface-${ptyId}`,
    WMUX_DATA_SUFFIX: suffix,
    WMUX_PIPE_NAME: `\\\\.\\pipe\\wmux${suffix}`,
    WMUX_HOOKS_TO_MAIN: '1',
  };
}

describe('owner record written by the hooks writer, read by the MCP server', () => {
  it('round-trips a Windows pane identity', () => {
    expect(recordThreadOwner(T1, paneEnv('daemon-a', 'ws-a'))).toBe(true);
    expect(readCodexThreadOwner(T1, home)).toEqual({ ptyId: 'daemon-a', workspaceId: 'ws-a', dataSuffix: '' });
    // And the writer's own reader agrees on the same files.
    expect(readThreadOwner(T1, paneEnv('daemon-a', 'ws-a'))?.env.WMUX_PTY_ID).toBe('daemon-a');
  });

  it('keeps an isolated instance apart through its data suffix', () => {
    recordThreadOwner(T1, paneEnv('daemon-a', 'ws-a', '-dev'));
    const owner = readCodexThreadOwner(T1, home);
    expect(owner?.dataSuffix).toBe('-dev');
    expect(matchOwnerToLiveAnchor(T1, owner, [{ ptyId: 'daemon-a', workspaceId: 'ws-a' }], '').status).toBe('miss');
    expect(matchOwnerToLiveAnchor(T1, owner, [{ ptyId: 'daemon-a', workspaceId: 'ws-a' }], '-dev')).toEqual(
      { status: 'hit', wsId: 'ws-a', ptyId: 'daemon-a' },
    );
  });

  it('drops the old thread when the same pane starts another one (/new)', () => {
    recordThreadOwner(T1, paneEnv('daemon-a', 'ws-a'));
    recordThreadOwner(T2, paneEnv('daemon-a', 'ws-a'));
    expect(readCodexThreadOwner(T1, home)).toBeUndefined();
    expect(readCodexThreadOwner(T2, home)?.ptyId).toBe('daemon-a');
  });

  it('never resolves a thread nobody recorded', () => {
    recordThreadOwner(T1, paneEnv('daemon-a', 'ws-a'));
    const owner = readCodexThreadOwner(T2, home);
    expect(owner).toBeUndefined();
    expect(matchOwnerToLiveAnchor(T2, owner, [{ ptyId: 'daemon-a', workspaceId: 'ws-a' }], '').status).toBe('miss');
  });
});
