import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The pane-side writer (hooks bridge) and this module must agree on the v1
// file protocol byte for byte: digests, pointer names, required env keys.
import { recordThreadOwner, readThreadOwner } from '../../../integrations/codex/bin/wmux-codex-thread.mjs';
import {
  classifyMcpParent,
  codexHome,
  codexHomeFromParentChain,
  codexOwnerIndexAvailable,
  matchOwnerToLiveAnchor,
  readCodexThreadOwner,
  tokenizeCommandLine,
} from '../codexThreadIdentity';

// Windows thread-owner index: what the MCP side reads on win32, written by the
// same writer the pane-side Codex hooks use.

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

describe('Windows shapes', () => {
  it('has no owner index on win32 today, so an ownerless thread is not proof of a foreign caller', () => {
    expect(codexOwnerIndexAvailable('win32')).toBe(false);
    expect(codexOwnerIndexAvailable('darwin')).toBe(true);
  });

  it('finds the default home under USERPROFILE when HOME is unset', () => {
    expect(codexHome({ USERPROFILE: 'C:\\Users\\u' })).toBe(path.join('C:\\Users\\u', '.codex'));
    expect(codexHome({ USERPROFILE: 'C:\\Users\\u', CODEX_HOME: 'D:\\codex-work' })).toBe('D:\\codex-work');
  });

  it('derives a per-account CODEX_HOME from a WMI CommandLine of the managed daemon', () => {
    const daemon = tokenizeCommandLine(
      '"\\\\?\\C:\\Users\\u\\.codex-work\\packages\\app-server-daemon\\releases\\0.162.1\\bin\\codex.exe" app-server --listen unix:// --managed-daemon',
    );
    // A `cmd /d /s /c node <entry>` wrapper between them is this server's own launcher.
    const chain = [
      ['node', 'C:\\Users\\u\\.wmux\\mcp\\index.js'],
      tokenizeCommandLine('C:\\Windows\\system32\\cmd.exe /d /s /c node C:\\Users\\u\\.wmux\\mcp\\index.js'),
      daemon,
    ];
    expect(classifyMcpParent(chain)).toBe('shared-server');
    expect(codexHomeFromParentChain(chain)).toBe('C:\\Users\\u\\.codex-work');
  });

  it('does not let a pane-side Codex TUI vouch for a thread', () => {
    // The #2007 tree: MCP ← app-server ← pane-B codex ← pane-B shell. Only the
    // nearest non-launcher ancestor decides; a TUI parent is 'other'.
    const tui = tokenizeCommandLine('"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe"');
    expect(classifyMcpParent([['node', 'C:\\Users\\u\\.wmux\\mcp\\index.js'], tui])).toBe('other');
  });
});
