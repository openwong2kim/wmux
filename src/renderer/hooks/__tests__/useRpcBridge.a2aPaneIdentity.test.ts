import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Wiring guards for Part A (pane-level A2A identity + addressing). The pure
 * address logic is unit-tested in a2aAddressing.test.ts; useRpcBridge itself
 * can't be imported under vitest (pulls in the store/window), so these are
 * source-structural assertions that the derivations + addressing stay wired.
 */
describe('useRpcBridge — pane-level A2A identity wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');

  function region(start: string, end: string): string {
    const m = src.match(new RegExp(`${start}[\\s\\S]*?${end}`));
    if (!m) throw new Error(`region ${start} → ${end} not found in useRpcBridge.ts`);
    return m[0];
  }

  it('surface.list labels each surface from the surfaceAgent map', () => {
    const block = region("method === 'surface\\.list'", 'return surfaces;');
    expect(block).toMatch(/store\.surfaceAgent\[s\.ptyId\]/);
    expect(block).toMatch(/agentName:/);
    expect(block).toMatch(/agentStatus:/);
  });

  it('pane.list exposes per-leaf agents derived from surfaceAgent', () => {
    const block = region("method === 'pane\\.list'", 'return leaves\\.map');
    // the agents[] derivation lives in the leaves.map body
    const mapBody = region("method === 'pane\\.list'", 'pane\\.focus');
    expect(mapBody).toMatch(/agents:\s*l\.surfaces\.flatMap/);
    expect(mapBody).toMatch(/store\.surfaceAgent\[s\.ptyId\]/);
    void block;
  });

  it('a2a.discover returns per-pane addressable entries', () => {
    const block = region("method === 'a2a\\.discover'", "method === 'a2a\\.task\\.send'");
    expect(block).toMatch(/panes/);
    expect(block).toMatch(/store\.surfaceAgent\[s\.ptyId\]/);
    expect(block).toMatch(/paneId:/);
    expect(block).toMatch(/surfaceId:/);
  });

  it('a2a.task.send resolves an explicit address and HARD-rejects an invalid one (no active-pane fallback)', () => {
    const block = region("method === 'a2a\\.task\\.send'", "method === 'a2a\\.task\\.query'");
    expect(block).toMatch(/resolvePaneAddress\(findLeafPanes\(target\.rootPane\)/);
    // an 'error' from the resolver short-circuits the send
    expect(block).toMatch(/if \('error' in addr\) return \{ error: `a2a\.task\.send:/);
    // reply pins to the originally-addressed pane
    expect(block).toMatch(/resolvePaneAddress\(findLeafPanes\(targetWs\.rootPane\)/);
    // reply fails CLOSED when the pinned address no longer resolves (no
    // active-pane fallback that could land on the wrong agent)
    expect(block).toMatch(/pinnedAddressLost/);
    // the resolved target ws id is returned for the main-side execute path
    expect(block).toMatch(/toWorkspaceId: target\.id/);
  });
});

describe('a2a.rpc — execute uses the resolved workspaceId', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'main', 'pipe', 'handlers', 'a2a.rpc.ts'),
    'utf-8',
  );
  it('reads toWorkspaceId from the renderer result instead of the raw fuzzy `to`', () => {
    // The resolved id is pulled off the renderer result and preferred over params.to.
    expect(src).toMatch(/resolvedTo\b/);
    expect(src).toMatch(/toWorkspaceId/);
    expect(src).toMatch(/resolvedTo[\s\S]*?:\s*\(typeof params\.to/); // fallback to params.to
  });
});
