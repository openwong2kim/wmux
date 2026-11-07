import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The MCP broker hosts a session only for a peer the OS names, read through
// koffi (src/mcp/brokerPeer.ts, src/shared/peerPid.ts); without koffi it
// refuses every session. The packaged broker finds koffi only if build:mcp
// leaves it external and forge ships it beside mcp-bundle, so both are pinned
// over their source, as consoleStdioPackaging.test.ts pins the CLI's.
const repo = path.join(__dirname, '..', '..', '..');

describe('koffi ships with the MCP broker bundle', () => {
  it('build:mcp leaves koffi external to the broker bundle', () => {
    const src = fs.readFileSync(path.join(repo, 'scripts', 'build-mcp.js'), 'utf8');
    const broker = src.slice(src.indexOf("entryPoints: ['dist/mcp/mcp/broker.js']"));
    expect(broker.slice(0, broker.indexOf('});'))).toMatch(/external: \[[^\]]*'koffi'[^\]]*\]/);
  });

  it('the broker reads the peer at accept and decides on it', () => {
    const src = fs.readFileSync(path.join(repo, 'src', 'mcp', 'broker.ts'), 'utf8');
    expect(src).toMatch(/net\.createServer\(\(socket\) => \{\s*\/\/[^\n]*\n\s*const peer = peerPidOf\(socket\);/);
    expect(src).toMatch(/decidePeer\(\{ selfCheckOk: verdict === 'available', peer,/);
  });

  it('postPackage copies koffi into mcp-bundle/node_modules on macOS and Linux, and fails without either', () => {
    const src = fs.readFileSync(path.join(repo, 'forge.config.ts'), 'utf8');
    const step = src.slice(src.indexOf('// 5b.'), src.indexOf('// 6.'));
    expect(step).toMatch(/if \(koffiPlatform !== 'win32'\) \{/);
    expect(step).toMatch(/if \(!fs\.existsSync\(mcpBundleDir\)\) \{\s*throw new Error/);
    expect(step).toMatch(/if \(!koffiPresent\) \{\s*throw new Error/);
    expect(step).toMatch(/copyKoffiInto\(path\.join\(mcpBundleDir, 'node_modules'\)\);/);
  });
});
