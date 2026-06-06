import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariant lock for MCP workspace routing.
//
// Bug (2026-06-03 — "called browser_open in workspace 2, browser opened in
// workspace 1"): browser_open used the weak resolveWorkspaceId(), which returns
// '' on a resolve miss instead of throwing. The empty id was then dropped by
// `...(workspaceId && { workspaceId })` across THREE layers — the MCP tool
// (src/mcp/index.ts), the main RPC handler (src/main/pipe/handlers/browser.rpc.ts),
// and finally the renderer (src/renderer/hooks/useRpcBridge.ts) fell back to
// `store.activeWorkspaceId`, opening the browser in the UI-active workspace rather
// than the calling one.
//
// Contract these invariants pin:
//   1. Only requireWorkspaceId() (which THROWS on a miss) may call the weak
//      resolveWorkspaceId() — exactly one call site. A tool reaching for the weak
//      resolver directly breaks the build instead of the user's routing.
//   2. browser_open is workspace-routed: it MUST use requireWorkspaceId().
//   3. browser_session_start is GLOBAL (one ProfileManager + PortAllocator in
//      browser.rpc.ts; the handler ignores workspaceId). It carries NO workspace
//      identity, matching browser_session_stop/status/list — so it can never
//      reintroduce the active-workspace fallback bug.
describe('MCP workspace routing (source-level invariants)', () => {
  const indexPath = path.join(__dirname, '..', 'index.ts');
  const rawSrc = fs.readFileSync(indexPath, 'utf-8');

  // Strip block + line comments before matching. These invariants key off source
  // text, and prose that mentions a resolver by name (e.g. a comment that writes
  // "resolveWorkspaceId()") must never trip them — only real call sites count.
  function stripComments(s: string): string {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }
  const src = stripComments(rawSrc);

  // Slice a single server.tool(...) block by its quoted name, bounded by the next
  // server.tool( call (or a fixed window for the last one). The 800-char fallback
  // only matters if a probed tool were the final server.tool( in the file; both
  // tools below are early in the file, each followed by more server.tool( calls.
  function toolBlock(toolName: string): string {
    const start = src.indexOf(`'${toolName}'`);
    expect(start).toBeGreaterThan(0);
    const next = src.indexOf('server.tool(', start + toolName.length);
    return src.slice(start, next > start ? next : start + 800);
  }

  it('only requireWorkspaceId() may CALL the weak resolveWorkspaceId() — exactly one call site', () => {
    // requireWorkspaceId is the single sanctioned caller: it throws when the
    // resolver returns falsy. Any tool handler that calls resolveWorkspaceId()
    // directly can silently fall back to the active workspace on a miss — the
    // exact bug. `resolveWorkspaceId` passed by REFERENCE (resolveDefaultPtyId
    // deps) has no parens and is intentionally excluded by the `()` in the regex.
    const directCalls = src.match(/resolveWorkspaceId\(\)/g) ?? [];
    expect(directCalls).toHaveLength(1);
  });

  it('browser_open routes through requireWorkspaceId, never the weak resolver', () => {
    const block = toolBlock('browser_open');
    expect(block).toMatch(/requireWorkspaceId\(\)/);
    expect(block).not.toMatch(/resolveWorkspaceId\(\)/);
  });

  it('terminal default routing uses verified identity, not the env-hint resolver', () => {
    const start = src.indexOf('function resolveDefaultPtyId');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('}', start) + 2);
    expect(block).toContain('resolveDefaultPtyIdImpl({ sendRpc, resolveWorkspaceId: resolveVerifiedWorkspaceId })');
  });

  it('browser_session_start is GLOBAL — carries no workspace identity (no resolver calls)', () => {
    // Session start manages a single global profile + CDP port; the RPC handler
    // ignores workspaceId. Requiring identity here would protect no routing and
    // only throw spuriously when the MCP server can't resolve its workspace.
    // Lock it global: neither resolver. If sessions ever become per-workspace,
    // this deliberate failure forces a conscious re-think of the routing contract.
    const block = toolBlock('browser_session_start');
    expect(block).not.toMatch(/requireWorkspaceId\(\)/);
    expect(block).not.toMatch(/resolveWorkspaceId\(\)/);
  });
});
