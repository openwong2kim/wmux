import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  classifyMcpParent,
  codexHome,
  codexHomeFromParentChain,
  codexOwnerIndexAvailable,
  tokenizeCommandLine,
} from '../codexThreadIdentity';

// Windows shapes of the thread-owner lookup. The writer/reader round-trip
// lives in integrations/codex/__tests__/codexThreadOwnerWindows.test.ts: this
// directory is compiled into the MCP bundle, which must not take in the .mjs.

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
