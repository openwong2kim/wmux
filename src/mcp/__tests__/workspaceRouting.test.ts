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

  it('only requireWorkspaceId() and the two fail-soft READ tools call the weak resolveWorkspaceId() — exactly three call sites', () => {
    // requireWorkspaceId is the sanctioned caller for WRITE/identity tools: it
    // throws when the resolver returns falsy, so a write (browser_open, a2a_*,
    // terminal routing) never silently lands on the UI-active workspace — the
    // exact bug this invariant guards.
    //
    // surface_list and pane_list are READ tools that deliberately call the weak
    // resolver directly: caller-scoped when identity resolves (converging with
    // a2a_whoami so a multi-agent workspace's surfaces are the CALLER's, not the
    // GUI-focused ones), and a fail-soft active fallback on a genuine miss — a
    // read must not throw during the boot reconcile window. They forward an
    // explicit workspaceId once resolved, so the fallback only fires on a true
    // identity miss. Any NEW direct call site must be reviewed against this
    // read-vs-write split — hence the exact count.
    //
    // The `(?<!function )` lookbehind excludes the parameter-less declaration
    // (`async function resolveWorkspaceId()`) so only call sites are counted.
    const directCalls = src.match(/(?<!function )resolveWorkspaceId\(\)/g) ?? [];
    expect(directCalls).toHaveLength(3);
  });

  it('browser_open routes through requireWorkspaceId, never the weak resolver', () => {
    const block = toolBlock('browser_open');
    expect(block).toMatch(/requireWorkspaceId\(\)/);
    expect(block).not.toMatch(/resolveWorkspaceId\(\)/);
  });

  it('browser_close routes through requireWorkspaceId, never the weak resolver', () => {
    // The close mirror of invariant 2: a surfaceId-less browser_close used to
    // fall back to the UI-active workspace and tore down whatever browser the
    // user was looking at — the same #190-class misroute browser_open had.
    const block = toolBlock('browser_close');
    expect(block).toMatch(/requireWorkspaceId\(\)/);
    expect(block).not.toMatch(/resolveWorkspaceId\(\)/);
  });

  it('terminal default routing binds the verified router, not the weak resolver (#163 Part 2)', () => {
    // resolveTerminalRouteBound wires resolveTerminalRoute to the verified
    // PID-map lookup + claim pinning. The cache getter MUST honor
    // workspaceResolved so an invalidated (stale) identity re-resolves instead
    // of being served from cache — otherwise callRpc's self-heal is defeated.
    const start = src.indexOf('function resolveTerminalRouteBound');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('\n}', start) + 2);
    expect(block).toContain('resolveTerminalRoute(');
    expect(block).toContain('lookupPidMapWorkspace');
    expect(block).toContain('claimPinnedRoute');
    // The verified-cache getter is gated on workspaceResolved (R1).
    expect(block).toMatch(/workspaceResolved\s*\?\s*MY_WORKSPACE_ID\s*:\s*''/);
  });

  it('the env-hint resolver (verifiedOnly) is fully removed — terminal IO never reaches it', () => {
    // resolveVerifiedWorkspaceId / the verifiedOnly opt were the old seam. They
    // are gone; terminal routing now has its own verified path. If they ever
    // reappear, terminal IO could regain the env-hint fallback.
    expect(src).not.toContain('resolveVerifiedWorkspaceId');
    expect(src).not.toContain('verifiedOnly');
  });

  it('every terminal IO tool routes through resolveTerminalRouteBound, never the workspaceId resolvers', () => {
    for (const tool of [
      'terminal_read',
      'terminal_read_events',
      'terminal_send',
      'terminal_send_key',
    ]) {
      const block = toolBlock(tool);
      expect(block, `${tool} must use resolveTerminalRouteBound`).toMatch(
        /resolveTerminalRouteBound\(/,
      );
      // Must NOT resolve workspaceId via the weak/A2A resolvers — those accept
      // the spoofable env hint.
      expect(block, `${tool} must not call requireWorkspaceId`).not.toMatch(
        /requireWorkspaceId\(\)/,
      );
      expect(block, `${tool} must not call resolveWorkspaceId`).not.toMatch(
        /resolveWorkspaceId\(\)/,
      );
    }
  });

  it('terminal tools always send workspaceId — never a conditional spread that could drop it', () => {
    // An absent/empty workspaceId makes the main-side assertWorkspaceOwnsPty
    // treat the call as an internal caller and skip the ownership check — the
    // exact bypass. workspaceId must come from route.workspaceId unconditionally.
    for (const tool of [
      'terminal_read',
      'terminal_read_events',
      'terminal_send',
      'terminal_send_key',
    ]) {
      const block = toolBlock(tool);
      expect(block, `${tool} must set workspaceId from route unconditionally`).toMatch(
        /workspaceId:\s*route\.workspaceId/,
      );
      expect(block, `${tool} must not conditionally spread workspaceId`).not.toMatch(
        /\.\.\.\(\s*workspaceId/,
      );
    }
  });

  it('PlaywrightEngine auto-open is wired to requireWorkspaceId (#190)', () => {
    // getPage()'s auto-open issues browser.open OUTSIDE any tool handler, so
    // the per-tool requireWorkspaceId() guard (invariant 2) cannot cover it.
    // index.ts injects the strict resolver into the engine so auto-open is
    // pinned to the calling session and fails closed (skips auto-open) on a
    // resolve miss, never reaching the renderer's active-workspace fallback.
    expect(src).toMatch(/setWorkspaceIdResolver\(\s*requireWorkspaceId\s*\)/);
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
