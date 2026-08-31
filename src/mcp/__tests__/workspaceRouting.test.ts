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
//      identity, matching browser_session_stop/list — so it can never reintroduce
//      the active-workspace fallback bug. browser_session_status is the exception:
//      it scopes per-workspace on the chrome backend (which profile THIS
//      workspace is bound to), so it resolves its own workspaceId through the
//      fail-soft read resolver (below), like surface_list / pane_list.
//   4. Every Playwright browser tool injects requireWorkspaceId() at its
//      production registration site, so isolated unit tests cannot mask
//      accidental weak wiring or an unscoped fallback/lease path.
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

  // Slice one registration block by its quoted name, bounded by the next legacy
  // or catalog registration. Phase 1 migrates one domain at a time, so keying
  // only on server.tool() would silently widen these source invariants as soon
  // as an in-index domain moves to defineWmuxTool().
  function toolBlock(toolName: string): string {
    const start = src.indexOf(`'${toolName}'`);
    expect(start).toBeGreaterThan(0);
    const tailStart = start + toolName.length;
    const nextOffset = src
      .slice(tailStart)
      .search(/(?:server\.tool\(|defineWmuxTool\(\s*\{)/);
    expect(
      nextOffset,
      `${toolName} source invariant needs a following registration boundary`,
    ).toBeGreaterThanOrEqual(0);
    return src.slice(start, tailStart + nextOffset);
  }

  it('the weak resolveWorkspaceId() is called only by requireWorkspaceId and the fail-soft read resolver — exactly three call sites', () => {
    // requireWorkspaceId is the sanctioned caller for WRITE/identity tools: it
    // throws when the resolver returns falsy, so a write (browser_open, a2a_*,
    // terminal routing) never silently lands on the UI-active workspace — the
    // exact bug this invariant guards. It calls the weak resolver ONCE.
    //
    // resolveScopedReadWorkspaceId is the fail-soft read resolver behind
    // surface_list/pane_list. It calls the weak resolver TWICE: once normally,
    // then again after invalidating a stale cached id (#243 P2-1). No tool
    // handler calls the weak resolver directly anymore — reads route through
    // resolveScopedReadWorkspaceId, writes through requireWorkspaceId — so any NEW
    // direct call site must be reviewed against this read-vs-write split. Hence
    // the exact count: 1 (requireWorkspaceId) + 2 (resolveScopedReadWorkspaceId).
    //
    // The `(?<!function )` lookbehind excludes the parameter-less declaration
    // (`async function resolveWorkspaceId()`) so only call sites are counted.
    const directCalls = src.match(/(?<!function )resolveWorkspaceId\(\)/g) ?? [];
    expect(directCalls).toHaveLength(3);
  });

  it('surface_list/pane_list route through resolveScopedReadWorkspaceId, not the weak resolver (#243)', () => {
    for (const tool of ['surface_list', 'pane_list']) {
      const block = toolBlock(tool);
      expect(block, `${tool} should resolve via resolveScopedReadWorkspaceId`).toMatch(/resolveScopedReadWorkspaceId\(\)/);
    }
  });

  it('resolveScopedReadWorkspaceId revalidates a stale id and prefers the pin (#243 P2-1/P2-2)', () => {
    const start = src.indexOf('async function resolveScopedReadWorkspaceId');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, start + 600);
    expect(block, 'P2-1: must revalidate liveness').toMatch(/isLiveWorkspace/);
    expect(block, 'P2-1: must invalidate a stale cached id').toMatch(/invalidateWorkspaceId/);
    expect(block, 'P2-2: must prefer the external pin').toMatch(/getPinnedRoute/);
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

  it('stale RPC outcomes invalidate identity and only the route generation they used', () => {
    // A deleted first-party workspace is recovered through the verified cache;
    // a deleted external claim is recovered through paneResolver. Leaving the
    // latter intact makes every later terminal call reuse the dead PTY until
    // the MCP process restarts.
    const start = src.indexOf('function invalidateStaleRoute');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('\n}', start) + 2);
    expect(block).toContain('invalidateWorkspaceId()');
    expect(block).toContain('clearPinnedRoute(pinnedRouteAtDispatch)');

    const callRpcStart = src.indexOf('async function callRpc');
    const callRpcBlock = src.slice(callRpcStart, src.indexOf('\n}', callRpcStart) + 2);
    expect(callRpcBlock).toMatch(
      /const pinnedRouteAtDispatch = getPinnedRoute\(\);[\s\S]*await sendRpc/,
    );
    expect(
      callRpcBlock.match(/invalidateStaleRoute\(pinnedRouteAtDispatch\)/g),
    ).toHaveLength(2);
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

  it('every Playwright browser tool receives the same strict workspace resolver (#695)', () => {
    // Unit tests inject a resolver in isolation. This source lock covers the
    // complementary production seam: every browser registration must share the
    // strict requireWorkspaceId dependency, never the weak/UI-active resolver.
    expect(src).toMatch(
      /const browserToolDeps\s*=\s*\{\s*resolveWorkspaceId:\s*requireWorkspaceId\s*\}/,
    );
    for (const name of [
      'Navigation',
      'Interaction',
      'Inspection',
      'State',
      'Wait',
      'File',
      'Utility',
      'Extraction',
    ]) {
      const allCalls = src.match(new RegExp(`register${name}Tools\\(`, 'g')) ?? [];
      expect(allCalls, `${name} tools must be registered exactly once`).toHaveLength(1);
      const strictCalls = src.match(
        new RegExp(
          `register${name}Tools\\(\\s*server\\s*,\\s*browserToolDeps\\s*(?:,|\\))`,
          'g',
        ),
      ) ?? [];
      expect(strictCalls, `${name} tools must receive exactly browserToolDeps`).toHaveLength(1);
    }
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

  it('browser_session_status is workspace-SCOPED — routes through the fail-soft read resolver so the chrome backend reports the caller\'s own binding', () => {
    // Unlike start/stop/list, status answers "which profile THIS workspace is
    // bound to", which scopes per-workspace on the chrome backend
    // (statusForWorkspace). The server has no ctx→workspace lane for a normal
    // agent, so the MCP layer MUST resolve and pass the caller's workspaceId, or
    // status silently reports the 'default' profile for a live-bound workspace
    // (undermining #1105's "this workspace" promise). It is a READ, so it resolves
    // via the fail-soft resolveScopedReadWorkspaceId ('' on an unresolvable
    // identity → the builtin path never throws), never requireWorkspaceId nor the
    // raw weak resolver.
    const block = toolBlock('browser_session_status');
    expect(block).toMatch(/resolveScopedReadWorkspaceId\(\)/);
    expect(block).not.toMatch(/requireWorkspaceId\(\)/);
    expect(block).not.toMatch(/resolveWorkspaceId\(\)/);
  });

  it('pane/surface lifecycle tools are wired in with the fail-soft read resolver (#285)', () => {
    // registerPaneLifecycleTools lives in paneLifecycle.ts; its behavioral
    // coverage is in src/mcp/__tests__/paneLifecycle.test.ts. THIS guard catches
    // the one thing the helper test can't (codex outside-voice finding): that
    // index.ts actually WIRES the registration. A forgotten call would leave all
    // five tools silently unregistered while every other test stayed green.
    expect(src, 'index.ts must call registerPaneLifecycleTools(server, …)').toMatch(
      /registerPaneLifecycleTools\(\s*server/,
    );
    // DR-1: the CREATE family (pane_split / surface_new) resolves the caller's
    // OWN workspace via the fail-soft read resolver — never the weak
    // resolveWorkspaceId() (counted by the invariant above) and never
    // requireWorkspaceId (a create degrades to active-ws, it does not hard-fail).
    // Pin the injected resolver at the wiring site.
    expect(src, 'lifecycle CREATE family must inject resolveScopedReadWorkspaceId').toMatch(
      /registerPaneLifecycleTools\([\s\S]*?resolveCallerWorkspaceId:\s*resolveScopedReadWorkspaceId/,
    );
    // The launch-time surface is decided once, from argv-derived flags, and
    // commander wins a contradictory `--commander --core` launch (fail-closed:
    // the security role never yields to the optimization profile).
    expect(src, 'surface profile must derive from COMMANDER_MODE, then ctx.coreMode').toMatch(
      /const SURFACE_PROFILE: WmuxToolProfile\s*=\s*COMMANDER_MODE\s*\?\s*'commander'\s*:\s*ctx\.coreMode\s*\?\s*'core'\s*:\s*'full'/,
    );
    expect(src, 'catalog profile must derive from SURFACE_PROFILE').toMatch(
      /const MCP_CATALOG_OPTIONS[\s\S]*?profile:\s*SURFACE_PROFILE/,
    );
    expect(src, 'catalog invocation must remain explicitly unattributed').toMatch(
      /const MCP_CATALOG_OPTIONS[\s\S]*?principal:[\s\S]*?kind:\s*'unattributed'/,
    );
    expect(src, 'lifecycle registration must use the shared catalog options').toMatch(
      /registerPaneLifecycleTools\([\s\S]*?MCP_CATALOG_OPTIONS\s*,?\s*\)/,
    );
  });

  it('browser_wait is wired through the same immutable catalog profile', () => {
    expect(src).toMatch(
      /registerWaitTools\(\s*server\s*,\s*browserToolDeps\s*,\s*MCP_CATALOG_OPTIONS\s*\)/,
    );
  });
});
