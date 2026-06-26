#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { clearClientIdentity, sendRpc, setClientIdentity } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';
import { claimPinnedRoute, getPinnedRoute } from './paneResolver';
import { resolveTerminalRoute, type PidMapLookup } from './terminalRouting';
import { classifyWorkspaceListResult, type WorkspaceLiveness } from './workspaceIdentity';
import { PlaywrightEngine } from './playwright/PlaywrightEngine';
import { registerNavigationTools } from './playwright/tools/navigation';
import { registerInteractionTools } from './playwright/tools/interaction';
import { registerInspectionTools } from './playwright/tools/inspection';
import { registerStateTools } from './playwright/tools/state';
import { registerWaitTools } from './playwright/tools/wait';
import { registerFileTools } from './playwright/tools/file';
import { registerUtilityTools } from './playwright/tools/utility';
import { registerExtractionTools } from './playwright/tools/extraction';
import { registerChannelTools } from './channels';
import { registerPaneLifecycleTools } from './paneLifecycle';
import { readFileSync } from 'fs';
import { join } from 'path';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Workspace identity.
//
// The PTY env var (WMUX_WORKSPACE_ID) is treated as a HINT only — it is
// frozen at PTY-create time and goes stale the moment the workspace id is
// re-minted (daemon respawn / session restore) while this process lives on.
// Trusting it permanently is what produced "no workspace found for ws-…":
// the agent reports a dead workspace and every identity-gated call fails
// until the MCP server is restarted. We instead resolve the CURRENT owner
// via a2a.resolve.identity (which now maps our PID → live workspace) and
// fall back to the env hint only when the live map is unavailable.
const ENV_WORKSPACE_HINT = process.env.WMUX_WORKSPACE_ID || '';
// Our OWN pane anchor from the spawn env (WMUX_PTY_ID). UNLIKE the workspace
// hint, the ptyId is immutable for the pane's lifetime — it is never re-minted
// by a daemon respawn / session restore — so it is a safe WEAK fallback for
// senderPtyId when the verified PID-map walk misses (the common Windows case,
// where the per-hop PowerShell process-tree walk is slow/flaky). It rides the
// same spoofable env channel as WMUX_WORKSPACE_ID, though, so a same-user
// process could forge it; see getTaskSenderPtyId for where this weak value is
// (and is NOT) trusted. Empty when the agent launcher didn't propagate the env
// to this MCP child — the case the diagnostic logging below exists to surface.
const ENV_PTY_HINT = process.env.WMUX_PTY_ID || '';
let MY_WORKSPACE_ID = '';
// Our OWN pane anchor (ptyId), captured alongside MY_WORKSPACE_ID on a PID-map
// hit — set by EITHER our client-side walk (unforgeable: our own process tree
// owns that live pane) OR main's server-side walk (main-correlated from a
// caller-asserted pid; forgeable within the #113 same-user ceiling — see
// a2a.rpc.ts). Threaded to a2a.task.send as `senderPtyId` so the renderer can
// reject a true self-send. Empty when no hit — getTaskSenderPtyId then falls
// back to the weak env hint for the A2A task tools, while a2a.channel.* stays
// hit-only.
let MY_PTY_ID = '';
let workspaceResolved = false;

/**
 * The MCP server's OWN pane anchor (ptyId) for the A2A task + terminal tools.
 *
 * Provenance split (WI-002):
 *   - MY_PTY_ID  — PID-map walk hit. Client-side walk is unforgeable (our own
 *                  process tree owns that live pane); server-side walk is
 *                  main-correlated from a caller-asserted pid (forgeable within
 *                  the #113 same-user ceiling). Both name a pane main resolved.
 *   - ENV_PTY_HINT — WEAK (WMUX_PTY_ID env). The spawn stamps the immutable
 *                  ptyId on the shell env; it reaches here only if the launcher
 *                  propagated it. Same spoofable channel as WMUX_WORKSPACE_ID.
 *
 * Prefer the verified value; fall back to the weak env hint so same-ws
 * pane-level A2A works even when the walk misses. A forged weak value can at
 * worst mislabel the SENDER's own pane (self-send guard / same-ws paste choice)
 * or trip the terminal omitted-ptyId guard (which only REJECTS — never grants),
 * all within the same-user trust ceiling (#113) the env hint already exposes.
 *
 * NOT used for a2a.channel.* — those mutation calls gate authz on a resolvable
 * senderPtyId (a2a.channel.rpc.ts), and feeding a weak env value there would
 * downgrade that gate from a main-resolved PID-map hit to a spoofable env var.
 * Channels keep using MY_PTY_ID (hit-only) via getSenderPtyId below — a
 * reliability mechanism within the #113 same-user ceiling (server-walk is
 * caller-asserted), not a same-user security boundary.
 */
function getTaskSenderPtyId(): string {
  return MY_PTY_ID || ENV_PTY_HINT;
}

/**
 * Diagnostic logging for identity resolution. MCP speaks its protocol over
 * STDOUT, so diagnostics MUST go to stderr (Claude Code surfaces MCP stderr in
 * its logs). Lets a failing launch-demo be diagnosed from the logs alone — most
 * importantly whether WMUX_PTY_ID propagated to this child.
 *
 * Deduped: on the target Windows path the walk MISSES and the env-hint branch is
 * intentionally NOT cached (so a re-minted workspace self-heals), meaning every
 * A2A/terminal call re-resolves. Without dedup the same MISS + env-hint lines
 * would repeat per call (review P2). The branch messages are stable for a pane's
 * steady state, so logging each DISTINCT line once shows every transition while
 * staying quiet on repeats. The set is bounded so a varying field (depth/pid)
 * can't grow it without limit — on overflow it resets and re-logs (rare, cheap).
 */
const loggedIdentityMsgs = new Set<string>();
function logIdentity(msg: string): void {
  if (loggedIdentityMsgs.has(msg)) return;
  if (loggedIdentityMsgs.size >= 50) loggedIdentityMsgs.clear();
  loggedIdentityMsgs.add(msg);
  console.error(`[wmux-mcp] identity: ${msg}`);
}

let identityEnvLogged = false;
function logIdentityEnvOnce(): void {
  if (identityEnvLogged) return;
  identityEnvLogged = true;
  logIdentity(
    `env WMUX_WORKSPACE_ID=${ENV_WORKSPACE_HINT ? 'present' : 'absent'} ` +
      `WMUX_PTY_ID=${ENV_PTY_HINT ? 'present' : 'absent'}`,
  );
}

const server = new McpServer({
  name: 'wmux',
  version: getVersion(),
});

// Detect an RPC outcome that means our cached workspace identity is stale
// (workspace id re-minted). Matches both error-shaped results and thrown
// errors so the next identity-gated call re-resolves the live owner.
function isStaleIdentityResult(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /no workspace found|not owned by workspace/i.test(text);
}

// Helper: wrap an RPC call as an MCP tool result
async function callRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<{ content: { type: 'text'; text: string }[] }> {
  try {
    const result = await sendRpc(method, params);
    if (isStaleIdentityResult(result)) invalidateWorkspaceId();
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (isStaleIdentityResult(err instanceof Error ? err.message : String(err))) {
      invalidateWorkspaceId();
    }
    throw err;
  }
}

/**
 * Drop the cached workspace identity so the next resolve re-queries the live
 * owner. Called when an RPC reports our cached id is stale (the workspace was
 * re-minted mid-session) so the server self-heals without a restart.
 */
function invalidateWorkspaceId(): void {
  workspaceResolved = false;
}

/**
 * Live PID→workspace lookup, classified so callers can tell apart a
 * confirmed-external caller (map populated, our process chain absent) from a
 * transient boot/respawn window (RPC down, or map momentarily empty).
 *
 * Process chain: MCP server → Claude Code → shell(PTY). A `hit` is verified
 * identity (our PID tree owns a live workspace); the env hint never reaches
 * here. Shared by the weak resolveWorkspaceId() (A2A routing) and the verified
 * terminal router (resolveTerminalRoute) so the walk lives in one place.
 */
async function lookupPidMapWorkspace(): Promise<PidMapLookup> {
  logIdentityEnvOnce();
  let mappings: Record<string, string> | undefined;
  let entries: Array<{ pid: string; ptyId: string; workspaceId: string }> | undefined;
  let resolved: { workspaceId?: unknown; ptyId?: unknown } | null | undefined;
  try {
    // callerPid lets main resolve our identity SERVER-SIDE: it walks our process
    // tree on its end (unsandboxed, reusing the port-watcher's process snapshot)
    // up to the owning shell's pid-map anchor. This is the PROPER fix for Codex,
    // which sandboxes our own per-hop PowerShell walk below AND strips the env
    // hints — leaving the client-side walk as its only, blocked, path. Older
    // main builds ignore the field and omit `resolved`, so we fall through to
    // the client-side walk unchanged (graceful degradation).
    const result = await sendRpc('a2a.resolve.identity' as RpcMethod, { callerPid: process.pid });
    mappings = (result as { mappings: Record<string, string> }).mappings;
    entries = (result as { entries?: Array<{ pid: string; ptyId: string; workspaceId: string }> }).entries;
    resolved = (result as { resolved?: { workspaceId?: unknown; ptyId?: unknown } | null }).resolved;
  } catch {
    logIdentity('resolve.identity rpc-down');
    return { status: 'rpc-down' };
  }

  // Server-side walk HIT (PROPER fix). main correlated our process tree to a
  // live pane on its side — env-independent and sandbox-independent, so this is
  // the path that lets Codex (and any agent whose client-side walk is blocked)
  // resolve identity at all.
  //
  // Provenance: main correlates from the LIVE process table, but the STARTING
  // pid is caller-asserted — we send our own process.pid and the pipe does not
  // bind the connection to a pid. So MY_PTY_ID set here is server-correlated, NOT
  // as strong as the client walk's own-ancestry proof: a same-user caller could
  // assert a foreign pid to adopt that pane's ptyId. This stays within the #113
  // same-user trust ceiling (a same-user caller already holds the pipe token and
  // is grandfathered allow-all), so the channel sender gate treats MY_PTY_ID as a
  // reliability mechanism, not a same-user security boundary.
  if (
    resolved &&
    typeof resolved.workspaceId === 'string' && resolved.workspaceId &&
    typeof resolved.ptyId === 'string' && resolved.ptyId
  ) {
    MY_PTY_ID = resolved.ptyId;
    logIdentity(`server-walk HIT ws=${resolved.workspaceId} pty=${resolved.ptyId}`);
    return { status: 'hit', wsId: resolved.workspaceId, ptyId: resolved.ptyId };
  }

  if (!mappings || Object.keys(mappings).length === 0) {
    logIdentity('resolve.identity empty-map');
    return { status: 'empty-map' };
  }

  // Prefer entries[] — it carries the immutable ptyId anchor per PID, so a
  // verified hit can also surface the caller's OWN ptyId (used by A2A send to
  // reject a true self-send). Fall back to mappings (pid→wsId, no ptyId) if an
  // older main omits entries; the wsId resolution is identical either way.
  const knownPids = new Map<number, { wsId: string; ptyId?: string }>();
  if (entries && entries.length > 0) {
    for (const e of entries) {
      const pid = parseInt(e.pid, 10);
      if (!isNaN(pid)) knownPids.set(pid, { wsId: e.workspaceId, ptyId: e.ptyId });
    }
  } else {
    for (const [pidStr, wsId] of Object.entries(mappings)) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) knownPids.set(pid, { wsId });
    }
  }

  // Walk process tree upward: MCP server → Claude Code → shell(PTY)
  let currentPid = process.ppid;
  let depth = 0;
  for (; depth < 10; depth++) {
    const match = knownPids.get(currentPid);
    if (match) {
      // Capture our OWN pane anchor on EVERY verified hit — including when a
      // terminal tool warms this lookup before any A2A call. resolveWorkspaceId's
      // cache fast-path returns without re-running this walk, so setting MY_PTY_ID
      // only there would leave it empty whenever a terminal op resolved identity
      // first (senderPtyId would then be silently absent on the next send).
      MY_PTY_ID = match.ptyId ?? '';
      logIdentity(
        `walk HIT ws=${match.wsId} pty=${match.ptyId ?? ''} depth=${depth} mapSize=${knownPids.size}`,
      );
      return { status: 'hit', wsId: match.wsId, ptyId: match.ptyId };
    }
    const parentPid = await getParentPid(currentPid);
    if (!parentPid || parentPid === currentPid || parentPid <= 1) break;
    currentPid = parentPid;
  }
  logIdentity(`walk MISS depth=${depth} lastPid=${currentPid} mapSize=${knownPids.size}`);
  return { status: 'miss' };
}

/**
 * Resolve workspace identity for A2A / non-terminal tools (the WEAK resolver):
 * 1. Verified PID-map lookup (caches a hit).
 * 2. Falls back to the unconfirmed env hint when no verified identity is
 *    available — NOT cached, so a later call retries live resolution.
 *
 * Terminal IO does NOT use this — it routes through resolveTerminalRoute,
 * which trusts only verified identity (issue #163 Part 2). The env-hint
 * fallback below is the bypass that fix closes for terminal IO; it remains
 * for A2A tools, which carry no PTY-ownership assertion.
 */
async function resolveWorkspaceId(): Promise<string> {
  if (workspaceResolved && MY_WORKSPACE_ID) return MY_WORKSPACE_ID;

  const lookup = await lookupPidMapWorkspace();
  if (lookup.status === 'hit') {
    MY_WORKSPACE_ID = lookup.wsId;
    // MY_PTY_ID is set inside lookupPidMapWorkspace on the hit (so the
    // terminal-route warm path populates it too — see there).
    workspaceResolved = true;
    return MY_WORKSPACE_ID;
  }

  // Last resort: the unconfirmed (possibly stale) env hint. Not cached.
  //
  // The hint must still not name a CONFIRMED ghost. The PID-map walk above
  // already fails closed once legacy "ws-" debris is pruned; the hint is the
  // only remaining path a re-minted ghost id can leak through. Drop it ONLY on
  // positive proof it is gone ('absent'); on 'unknown' (workspace.list
  // transiently unavailable during boot reconcile) keep trusting the hint,
  // since this fallback exists precisely to carry the call through while the
  // RPC layer is briefly down. Not cached, so a later call re-checks once the
  // renderer is ready.
  if (ENV_WORKSPACE_HINT) {
    if ((await isLiveWorkspace(ENV_WORKSPACE_HINT)) !== 'absent') {
      // WI-002: the workspace resolved from the env hint (walk did not hit), so
      // MY_PTY_ID is empty here — the A2A task tools recover senderPtyId from the
      // weak WMUX_PTY_ID env hint via getTaskSenderPtyId. Surface that this is
      // the path the launch demo depends on when the Windows walk is flaky.
      logIdentity(`resolved ws via env-hint (walk missed) senderPty=${getTaskSenderPtyId() ? 'weak-env' : 'none'}`);
      return ENV_WORKSPACE_HINT;
    }
  }

  // Last-resort cached identity. invalidateWorkspaceId() clears the
  // `workspaceResolved` flag but NOT MY_WORKSPACE_ID, so a re-minted/closed
  // workspace could otherwise leak back here and keep routing to a confirmed-
  // dead id — the ghost loop this whole change exists to stop. Gate it exactly
  // like the env hint: drop it only on positive proof it is 'absent' (and clear
  // the cache so the next call re-resolves clean); keep it on 'unknown'
  // (workspace.list transiently down) to carry the call through a boot blip.
  if (MY_WORKSPACE_ID && (await isLiveWorkspace(MY_WORKSPACE_ID)) === 'absent') {
    MY_WORKSPACE_ID = '';
    MY_PTY_ID = '';
    workspaceResolved = false;
  }
  return MY_WORKSPACE_ID;
}

/**
 * Classify whether `wsId` names a workspace that exists RIGHT NOW. Used to gate
 * the env-hint fallback: WMUX_WORKSPACE_ID is frozen at PTY-create time, so
 * after a daemon respawn / session restore the workspace id is re-minted and
 * the hint becomes a ghost (absent from workspace.list). Routing into a ghost
 * is what made browser_open fail with "no active workspace" and terminal ops
 * throw "not owned by workspace ws-…".
 *
 * Returns 'absent' only on positive proof the id is gone; 'unknown' when
 * workspace.list is unavailable (threw, or a retryable envelope during boot
 * reconcile) so callers keep trusting the hint instead of hard-failing. The
 * classification is shared with src/company/mcp via classifyWorkspaceListResult
 * so both surfaces behave identically.
 */
async function isLiveWorkspace(wsId: string): Promise<WorkspaceLiveness> {
  try {
    const result = await sendRpc('workspace.list' as RpcMethod, {});
    return classifyWorkspaceListResult(result, wsId);
  } catch {
    return 'unknown';
  }
}

async function getParentPid(pid: number): Promise<number | null> {
  try {
    // Async execFile (not execFileSync): this walk runs per hop on the
    // workspace-identity hot path, so a synchronous spawn would park the Node
    // event loop for the child's whole lifetime — up to the per-hop timeout ×
    // depth — freezing every other MCP operation. Awaiting a promisified
    // execFile keeps the loop free while each child process runs.
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    if (process.platform === 'win32') {
      const path = await import('path');
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const { stdout } = await execFileAsync(ps, [
        '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const parsed = parseInt(stdout.trim(), 10);
      return isNaN(parsed) ? null : parsed;
    } else {
      const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
      return parseInt(stdout.trim(), 10) || null;
    }
  } catch {
    return null;
  }
}

/**
 * Get workspace ID, requiring it for A2A operations.
 * Throws a user-friendly error if identity cannot be determined.
 */
async function requireWorkspaceId(): Promise<string> {
  const wsId = await resolveWorkspaceId();
  if (!wsId) {
    throw new Error(
      'Workspace identity unknown. This MCP server cannot determine which workspace it belongs to. ' +
      'Make sure you are running inside a wmux terminal workspace.'
    );
  }
  return wsId;
}

/**
 * Resolve the caller's workspace for fail-soft READ tools (surface_list /
 * pane_list). Hardens the omitted-workspace path beyond the weak
 * resolveWorkspaceId (codex P2 follow-ups, #243):
 *   - Staleness (P2-1): the resolveWorkspaceId fast path can return a cached id
 *     that is no longer live after a workspace re-mint (daemon respawn / session
 *     restore). For a fail-soft read that would otherwise keep reporting an empty
 *     list, revalidate the id and re-resolve clean once it is proven gone.
 *   - External pin (P2-2): a confirmed-external caller has no PID/env identity but
 *     may have claimed a dedicated workspace via terminal_read. Prefer that pin
 *     over the renderer's UI-active fallback so the read reports the caller's OWN
 *     workspace, not whatever the user has focused.
 * Still degrades to '' (renderer active-ws fallback) on a true miss — a read must
 * never throw.
 */
async function resolveScopedReadWorkspaceId(): Promise<string> {
  let wsId = await resolveWorkspaceId();
  if (wsId && (await isLiveWorkspace(wsId)) === 'absent') {
    invalidateWorkspaceId();
    wsId = await resolveWorkspaceId();
  }
  if (!wsId) {
    const pin = getPinnedRoute();
    if (pin?.workspaceId) wsId = pin.workspaceId;
  }
  return wsId;
}

// Verified terminal routing — see src/mcp/terminalRouting.ts for the full
// state machine. Binds the router's deps to this module's PID-map lookup,
// verified-identity cache, and external-claim pinning. Unlike A2A tools,
// terminal IO must not trust WMUX_WORKSPACE_ID: an external launcher can spoof
// it to a victim workspace and read/write that workspace's terminal
// (issue #163). The cache getter honors workspaceResolved so a stale identity
// invalidated by callRpc re-resolves instead of being served from cache.
function resolveTerminalRouteBound(explicitPtyId?: string) {
  return resolveTerminalRoute(
    {
      lookupPidMapWorkspace,
      getCachedVerifiedWorkspaceId: () => (workspaceResolved ? MY_WORKSPACE_ID : ''),
      cacheVerifiedWorkspaceId: (wsId: string) => {
        MY_WORKSPACE_ID = wsId;
        workspaceResolved = true;
      },
      getPinnedRoute,
      claimPinnedRoute: () => claimPinnedRoute({ sendRpc }),
    },
    explicitPtyId,
  );
}

// === Browser tools (RPC-based: surface management stays in main process) ===

server.tool(
  'browser_open',
  'Open a new browser panel in the active pane. Use this when no browser surface exists yet.',
  {
    url: z.string().optional().describe('Initial URL to load (defaults to google.com)'),
  },
  async ({ url }) => {
    // requireWorkspaceId (NOT the weak resolveWorkspaceId) so a failed identity
    // resolution THROWS instead of returning '' — which `...(workspaceId && …)`
    // would drop, letting the renderer (useRpcBridge.ts) fall back to
    // store.activeWorkspaceId and open the browser in the wrong (UI-active)
    // workspace. Matches every other workspace-routed tool.
    const workspaceId = await requireWorkspaceId();
    return callRpc('browser.open', { ...(url && { url }), workspaceId });
  },
);

server.tool(
  'browser_close',
  'Close the browser panel in the calling workspace',
  {
    surfaceId: z.string().optional().describe('Target a specific surface by ID (searched across all workspaces). Omit to close the browser surface in the calling workspace.'),
  },
  async ({ surfaceId }) => {
    // Same fail-closed identity rule as browser_open: without an explicit
    // workspaceId the renderer falls back to the UI-active workspace, so a
    // surfaceId-less close issued here would tear down whatever browser the
    // user is currently looking at — possibly in a different workspace.
    // An explicit surfaceId is unambiguous (renderer searches all
    // workspaces), but requireWorkspaceId is kept unconditional so both
    // shapes share one identity contract.
    const workspaceId = await requireWorkspaceId();
    return callRpc('browser.close', { ...(surfaceId && { surfaceId }), workspaceId });
  },
);

// === Playwright browser tools ===
registerNavigationTools(server);
registerInteractionTools(server);
registerInspectionTools(server);
registerStateTools(server);
registerWaitTools(server);
registerFileTools(server);
registerUtilityTools(server);
registerExtractionTools(server);

// The engine's auto-open (getPage Strategy 4) issues browser.open outside any
// tool handler, so it cannot rely on the per-tool requireWorkspaceId() guard
// above. Inject the strict resolver so the auto-opened surface is pinned to
// this session's workspace; on a resolve miss the engine fails closed (skips
// auto-open) rather than opening in an unspecified workspace.
PlaywrightEngine.getInstance().setWorkspaceIdResolver(requireWorkspaceId);

// === Browser session tools ===

server.tool(
  'browser_session_start',
  'Start a browser session with the specified profile',
  {
    profile: z.string().optional().describe('Profile name to use (defaults to "default")'),
  },
  // No workspaceId: browser sessions are GLOBAL — a single profile + CDP port via
  // the module-level ProfileManager/PortAllocator in browser.rpc.ts. The handler
  // ignores workspaceId entirely, so requiring identity here would protect no
  // routing and only throw spuriously when the MCP server can't resolve its
  // workspace (e.g. launched outside a wmux terminal). Matches browser_session_stop
  // /status/list, which are likewise global. Only browser_open is workspace-routed.
  async ({ profile }) => callRpc('browser.session.start', profile ? { profile } : {}),
);

server.tool(
  'browser_session_stop',
  'Stop the current browser session',
  {},
  async () => callRpc('browser.session.stop'),
);

server.tool(
  'browser_session_status',
  'Get current browser session status',
  {},
  async () => callRpc('browser.session.status'),
);

server.tool(
  'browser_session_list',
  'List available browser profiles',
  {},
  async () => callRpc('browser.session.list'),
);

// === Terminal tools ===

server.tool(
  'terminal_read',
  'Read the current visible text from a terminal. Omit ptyId to read the active terminal. Pass tail_lines to cap the response to the last N non-empty lines (saves tokens when the full viewport is not needed). For structured command boundaries / exit codes, use terminal_read_events instead.',
  {
    ptyId: z.string().optional().describe('Target a specific terminal by PTY ID. Omit to use the active terminal. Get PTY IDs from surface_list().'),
    tail_lines: z.number().int().positive().optional().describe('Return only the last N non-empty lines of the viewport. Omit to return everything the terminal buffer knows about.'),
  },
  async ({ ptyId, tail_lines }) => {
    const route = await resolveTerminalRouteBound(ptyId);
    const params: Record<string, unknown> = { workspaceId: route.workspaceId };
    if (route.ptyId) params.ptyId = route.ptyId;
    if (tail_lines !== undefined) params.tail_lines = tail_lines;
    return callRpc('input.readScreen', params);
  },
);

server.tool(
  'terminal_read_events',
  'Return structured OSC 133 prompt/command events (prompt_start, prompt_end, command_start, command_end with exit code) from a terminal. Requires shell integration — wmux auto-injects for pwsh and bash; cmd.exe is unsupported. Use this instead of terminal_read when you need command boundaries, exit codes, or byte offsets for diff-style reads.',
  {
    ptyId: z.string().optional().describe('Target a specific terminal by PTY ID. Omit to use the active terminal.'),
    limit: z.number().int().positive().optional().describe('Return the N most recent events (default 32). Ignored when sinceOffset or lastCommandOnly is set.'),
    sinceOffset: z.number().int().nonnegative().optional().describe('Return only events whose byteOffset is strictly greater than this value — for diff-style polling.'),
    lastCommandOnly: z.boolean().optional().describe('Skip the events list and only return lastCompletedRange (the byte-offset range + exit code of the most recently finished command).'),
  },
  async ({ ptyId, limit, sinceOffset, lastCommandOnly }) => {
    const route = await resolveTerminalRouteBound(ptyId);
    const params: Record<string, unknown> = { workspaceId: route.workspaceId };
    if (route.ptyId) params.ptyId = route.ptyId;
    if (limit !== undefined) params.limit = limit;
    if (sinceOffset !== undefined) params.sinceOffset = sinceOffset;
    if (lastCommandOnly) params.lastCommandOnly = true;
    return callRpc('terminal.readEvents', params);
  },
);

server.tool(
  'terminal_send',
  'Send text to a terminal. By default the text is written as-is — no Enter is pressed, so a shell command or TUI chat prompt will sit on the input line without being committed. Pass `submit: true` to append a carriage return (\\r) so the text is committed, equivalent to pressing Enter. Omit ptyId to target the active terminal. Use surface_list() to discover available PTY IDs. To send messages to OTHER workspaces, use a2a_task_send or a2a_broadcast instead.',
  {
    text: z.string().describe('Text to send to the terminal'),
    ptyId: z.string().optional().describe('Target a specific terminal by PTY ID. Omit to use the active terminal. Get PTY IDs from surface_list().'),
    submit: z.boolean().optional().describe('When true, append a carriage return (\\r) after the text so it is committed — equivalent to pressing Enter. Use this for shell commands and TUI chat prompts (e.g. Claude Code, REPLs). Default: false (text is written as-is; you must call terminal_send_key({ key: "enter" }) separately to commit).'),
  },
  async ({ text, ptyId, submit }) => {
    const route = await resolveTerminalRouteBound(ptyId);
    const base: Record<string, unknown> = { text, workspaceId: route.workspaceId };
    if (route.ptyId) base.ptyId = route.ptyId;
    // Forward our OWN ptyId so main can reject an omitted-ptyId send from an
    // agent (it would loop into its own pane or a non-deterministic sibling).
    // Verified PID-map hit preferred; falls back to the weak WMUX_PTY_ID env
    // hint (WI-002) so the self-loop guard still arms when the walk missed —
    // the guard only REJECTS, never grants, so a weak/forged value can't widen
    // access. Absent for external callers, where omitting ptyId legitimately
    // targets their pinned terminal.
    const senderPtyId = getTaskSenderPtyId();
    if (senderPtyId) base.senderPtyId = senderPtyId;
    if (submit) base.submit = true;
    return callRpc('input.send', base);
  },
);

server.tool(
  'terminal_send_key',
  'Send a named key to a terminal. Omit ptyId to target the active terminal. Use surface_list() to discover available PTY IDs.',
  {
    key: z.string().describe(
      'Key name: enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, escape, up, down, right, left',
    ),
    ptyId: z.string().optional().describe('Target a specific terminal by PTY ID. Omit to use the active terminal. Get PTY IDs from surface_list().'),
  },
  async ({ key, ptyId }) => {
    const route = await resolveTerminalRouteBound(ptyId);
    const params: Record<string, unknown> = { key, workspaceId: route.workspaceId };
    if (route.ptyId) params.ptyId = route.ptyId;
    // See terminal_send: forward our ptyId (verified hit, else weak WMUX_PTY_ID
    // env hint — WI-002) so main can reject an omitted-ptyId key send from an
    // agent (self-loop / sibling misroute).
    const senderPtyId = getTaskSenderPtyId();
    if (senderPtyId) params.senderPtyId = senderPtyId;
    return callRpc('input.sendKey', params);
  },
);

// === Workspace tools ===

server.tool(
  'workspace_list',
  'List all workspaces in wmux',
  {},
  async () => callRpc('workspace.list'),
);

server.tool(
  'surface_list',
  'List all surfaces (terminals and browsers) in a workspace. Returns surfaceId, ptyId, shell, CWD, git branch for each surface. Omit workspaceId to list your own workspace.',
  {
    workspaceId: z.string().optional().describe("Target a specific workspace by ID. Omit to use your own (the caller's) workspace."),
  },
  async ({ workspaceId }) => {
    // Scope to the CALLER's own workspace when omitted, not the GUI-focused one
    // (the a2a_whoami-vs-surface_list divergence). resolveScopedReadWorkspaceId
    // is fail-soft (returns '' on identity miss, never throws — unlike a write
    // tool, a read must not hard-fail), revalidates a stale cached id, and
    // prefers an external caller's pin (#243); an empty resolution falls back to
    // the renderer's active-ws default, preserving the old behavior.
    const resolved = workspaceId || (await resolveScopedReadWorkspaceId());
    return callRpc('surface.list', resolved ? { workspaceId: resolved } : {});
  },
);

server.tool(
  'pane_list',
  'List all panes in a workspace with CWD, git branch, and metadata. Omit workspaceId to list your own workspace.',
  {
    workspaceId: z.string().optional().describe("Target a specific workspace by ID. Omit to use your own (the caller's) workspace."),
  },
  async ({ workspaceId }) => {
    // Caller-scoped when omitted (see surface_list) — fail-soft via
    // resolveScopedReadWorkspaceId so a read never throws on identity miss.
    const resolved = workspaceId || (await resolveScopedReadWorkspaceId());
    return callRpc('pane.list', resolved ? { workspaceId: resolved } : {});
  },
);

server.tool(
  'pane_set_metadata',
  'Attach descriptive metadata (label/role/status + custom k/v) to a leaf pane in the calling workspace. The custom map is deep-merged when mergeMode="merge" (the default), so cooperating tools can each write their own keys without clobbering. Use mergeMode="replace" to overwrite the entire metadata object, or "replaceShared" (v2.9.0+) to overwrite label/role/status while preserving another tool\'s custom keys verbatim. Pass expectedVersion (v2.9.0+) for optimistic concurrency — the call fails with VERSION_CONFLICT if the pane has been updated since you last read it. Omit paneId to target the active pane in the calling workspace.',
  {
    paneId: z.string().optional().describe('Target leaf pane id. Omit to use the active pane in the calling workspace.'),
    label: z.string().max(64).optional().describe('Short human label, e.g. "Backend".'),
    role: z.string().max(64).optional().describe('Free-form role tag, e.g. "service" or "test-runner".'),
    status: z.string().max(128).optional().describe('Current status, e.g. "running-tests".'),
    custom: z.record(z.string(), z.string()).optional().describe('Additional string→string properties for tool-specific data. Deep-merged with existing custom map when mergeMode="merge". Recommended convention: namespace your keys with a tool prefix (e.g. "orchestrator.taskId", "qa.status") to avoid semantic collisions with other cooperating tools.'),
    merge: z.boolean().optional().describe('Legacy v2.8.x flag; prefer mergeMode. true → merge, false → replace. When both `merge` and `mergeMode` are provided, `mergeMode` wins.'),
    mergeMode: z.enum(['merge', 'replace', 'replaceShared']).optional().describe('Explicit merge semantics (v2.9.0+). "merge" patches and deep-merges custom (default). "replace" wipes the metadata object and writes only the provided fields. "replaceShared" overwrites label/role/status but preserves another tool\'s custom keys. Overrides legacy `merge` boolean when both are provided.'),
    expectedVersion: z.number().int().nonnegative().optional().describe('Optimistic concurrency guard (v2.9.0+). If the pane\'s current metadata version differs, the call fails with VERSION_CONFLICT and does not mutate. Read the current version from pane_get_metadata or pane_list. Omit for unconditional writes (legacy v2.8.x behavior). expectedVersion: 0 is the correct guard for a pane that has never been written; it succeeds iff no concurrent writer has set anything on this pane yet (useful for "claim a fresh pane" patterns).'),
  },
  async ({ paneId, label, role, status, custom, merge, mergeMode, expectedVersion }) => {
    const workspaceId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId };
    if (paneId !== undefined) params['paneId'] = paneId;
    if (label !== undefined) params['label'] = label;
    if (role !== undefined) params['role'] = role;
    if (status !== undefined) params['status'] = status;
    if (custom !== undefined) params['custom'] = custom;
    if (merge !== undefined) params['merge'] = merge;
    if (mergeMode !== undefined) params['mergeMode'] = mergeMode;
    if (expectedVersion !== undefined) params['expectedVersion'] = expectedVersion;
    return callRpc('pane.setMetadata', params);
  },
);

server.tool(
  'pane_get_metadata',
  'Read the metadata attached to a leaf pane in the calling workspace. Returns { paneId, metadata, version }. A version of 0 means no metadata has ever been written for this pane (the "never written" sentinel — pair with expectedVersion: 0 on pane_set_metadata to claim a fresh pane atomically).',
  {
    paneId: z.string().optional().describe('Target leaf pane id. Omit to use the active pane in the calling workspace.'),
  },
  async ({ paneId }) => {
    const workspaceId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId };
    if (paneId !== undefined) params['paneId'] = paneId;
    return callRpc('pane.getMetadata', params);
  },
);

server.tool(
  'wmux_search_panes',
  'Search across all live terminal panes in the caller\'s workspace. Returns up to 200 matches with paneId + matched line + 2-line context (truncated=true means more were found). Use to find which pane has the JWT error, failing test, or build warning instead of polling each pane individually. Live panes only (v1); regex uses JS RegExp with default flags (case-sensitive, no inline `(?i)` — use `[Ee]rror` for case-insensitive).',
  {
    query: z.string().min(1).describe('The text to search for. Required, non-empty. Treated as a literal substring unless regex=true.'),
    regex: z.boolean().optional().describe('If true, treat query as a JavaScript regex pattern (e.g. "ERROR|WARN", "\\\\bTODO\\\\b"). Default flags only — case-sensitive, no inline `(?i)`. Invalid pattern returns an error. Default false.'),
  },
  async ({ query, regex }) => {
    const workspaceId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId, query };
    if (regex !== undefined) params.regex = regex;
    return callRpc('pane.search', params);
  },
);

server.tool(
  'wmux_events_poll',
  'Poll the wmux EventBus for pane, process, agent, notification, and A2A task lifecycle events. Cursor-based: pass `cursor` = the last `seq` you saw (start with 0 to replay from oldest in the ring). Returns { events, nextCursor, resync? }. `resync: true` means your cursor drifted past the in-memory ring (1024 events) and you should reconcile via pane_list. Events are auto-scoped to the calling workspace — EXCEPT `a2a.task`, which is dual-party (visible to both the sending and receiving workspace; see the `types` field for details).',
  {
    cursor: z.number().int().nonnegative().optional().describe('Last seen seq number. Default 0 = replay all events still in the ring.'),
    types: z
      .array(z.enum([
        'pane.created',
        'pane.closed',
        'pane.focused',
        'pane.metadata.changed',
        'workspace.metadata.changed',
        'process.started',
        'process.exited',
        'agent.lifecycle',
        'notification.received',
        'a2a.task',
      ]))
      .optional()
      .describe('Filter to specific event types. Omit to receive all types. `notification.received` fires when a terminal program emits a desktop-notification escape sequence (OSC 9, OSC 777 notify, kitty OSC 99) and carries ptyId, source (osc9|osc777|osc99), title (nullable), and body. `agent.lifecycle` carries ptyId, kind (agent.stop|agent.subagent_stop|agent.awaiting_input), source (hook|detector|osc133), agent slug (nullable when source=osc133 and no agent context), decision (emit|dedup), and optional exitCode (osc133 only). It fires on three signals: (1) an inner agent (Claude Code, Codex CLI, ...) finishes a turn (source=hook|detector, kind=agent.stop), (2) an agent surfaces a y/N approval prompt mid-turn (source=detector, kind=agent.awaiting_input), or (3) any OSC 133-instrumented shell command completes (source=osc133, kind=agent.stop, with exitCode). Orchestrators that previously polled `terminal_read_events` for OSC 133 boundaries can switch to ring-buffer polling here at the same cadence. `a2a.task` fires on agent-to-agent task lifecycle and carries taskId, from (sender workspaceId), to (receiver workspaceId), kind (created|updated|cancelled), state (submitted|working|input-required|completed|failed|canceled), and an optional messagePreview (≤200 chars). It is a POINTER, not the payload — the body is omitted by default; follow up with a2a_task_query to fetch it. UNLIKE every other event type (scoped strictly to the calling workspace), `a2a.task` is DUAL-PARTY: visible to BOTH the sending (from) and receiving (to) workspace, and to no third workspace. An unscoped poll receives zero a2a.task events.'),
    max: z.number().int().positive().max(1024).optional().describe('Max events to return per poll. Default 256.'),
  },
  async ({ cursor, types, max }) => {
    const workspaceId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId };
    if (cursor !== undefined) params['cursor'] = cursor;
    if (types !== undefined) params['types'] = types;
    if (max !== undefined) params['max'] = max;
    return callRpc('events.poll', params);
  },
);

// === A2A (Agent-to-Agent) tools ===

// 1. a2a_whoami — Identify this workspace
server.tool(
  'a2a_whoami',
  'Returns this workspace\'s identity (name, ID, metadata). Call this if you are unsure which workspace you are in.',
  {},
  async () => {
    const wsId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId: wsId };
    // Forward our OWN ptyId so the renderer can answer pane-level ("which agent
    // am I in this multi-agent workspace?"), not just ws-level. Verified PID-map
    // hit preferred; falls back to the weak WMUX_PTY_ID env hint (WI-002) so
    // whoami answers pane-level even when the walk missed. Read-only — a forged
    // value only mislabels the caller's own pane. Server-derived, never an
    // agent-settable tool param.
    const senderPtyId = getTaskSenderPtyId();
    if (senderPtyId) params.senderPtyId = senderPtyId;
    return callRpc('a2a.whoami', params);
  },
);

// 2. a2a_discover — Agent Card discovery
server.tool(
  'a2a_discover',
  'List all available workspaces/agents and their names. ALWAYS call this first when the user references a workspace by number or name (e.g. "3번", "Workspace 1") so you know valid targets.',
  {},
  async () => callRpc('a2a.discover'),
);

// 3. send_message — Primary tool for inter-workspace communication
const sendMessageHandler = async ({ to, pane_id, surface_id, title, task_id, message, execute, silent, data, data_mime_type }: {
  to?: string; pane_id?: string; surface_id?: string; title?: string; task_id?: string; message: string; execute?: boolean; silent?: boolean;
  data?: Record<string, unknown>; data_mime_type?: string;
}) => {
  const wsId = await requireWorkspaceId();
  const params: Record<string, unknown> = {
    workspaceId: wsId,
    message,
  };
  // KS-1 (true self-send guard): include our OWN ptyId so the renderer can
  // reject addressing our own pane (bracket-paste + forced submit into our own
  // prompt = loop) and can safely allow a loud same-ws sibling paste. Verified
  // PID-map hit preferred; falls back to the weak WMUX_PTY_ID env hint (WI-002)
  // — THIS is the same-machine multi-agent launch-demo unblock: without a
  // senderPtyId the renderer fails closed and suppresses the same-ws paste, so a
  // walk miss silently broke agent↔agent messaging.
  //
  // BLAST-RADIUS ACK (review P2-3): with the weak hint present, a same-ws send
  // flips from suppressed (absent senderPtyId) to a LOUD pane-level bracket-paste.
  // A same-user attacker forging BOTH WMUX_WORKSPACE_ID + WMUX_PTY_ID could thus
  // paste loudly into an explicitly-addressed victim pane where ws-only forgery
  // was previously suppressed. This stays within the #113 ceiling: the control
  // pipe is auth-token-gated and a same-user process already holds that token, so
  // it can input.send an explicit-ptyId paste into any pane directly — no new
  // token-less attacker class, no escalation beyond the token already grants.
  const senderPtyId = getTaskSenderPtyId();
  if (senderPtyId) params.senderPtyId = senderPtyId;
  if (task_id) params.taskId = task_id;
  if (to) params.to = to;
  // Pane-level addressing: route delivery to a specific pane/surface inside the
  // target workspace (e.g. a workspace running two agents). Both optional and
  // ws-scoped — the id must belong to `to`, else the send fails (never silently
  // delivers to the active pane).
  if (pane_id) params.paneId = pane_id;
  if (surface_id) params.surfaceId = surface_id;
  if (title) params.title = title;
  if (execute) params.execute = true;
  // Forward `silent` whenever it is explicitly provided (true OR false), not
  // only when truthy: the renderer's silent-default treats an EXPLICIT
  // `silent:false` as "force the loud full-body paste even to a live TUI
  // agent". Dropping the `false` here would make that documented override
  // unreachable through the MCP tools (it would read as omitted → default).
  if (silent !== undefined) params.silent = silent;
  if (data) {
    params.data = data;
    params.dataMimeType = data_mime_type || 'application/json';
  }
  return callRpc('a2a.task.send', params);
};

const sendMessageParams = {
  to: z.string().optional().describe('Target: workspace number (1, 2, 3), name ("Workspace 1"), or ID'),
  pane_id: z.string().optional().describe('Optional: deliver to a specific pane inside the target workspace (from pane_list / a2a_discover panes[].paneId). Use when a workspace runs more than one agent. Must belong to "to".'),
  surface_id: z.string().optional().describe('Optional: deliver to a specific surface inside the target workspace (from surface_list / a2a_discover panes[].surfaceId). More specific than pane_id; if both are given they must agree. Must belong to "to".'),
  title: z.string().optional().describe('Short title for the message'),
  task_id: z.string().optional().describe('Reply to existing task ID'),
  message: z.string().describe('Message to send'),
  execute: z.boolean().optional().describe('Set true on a NEW task to run it as a background Claude task. The user is prompted unless global A2A execute auto-approve / YOLO is enabled. Not supported with task_id. Default: false.'),
  silent: z.boolean().optional().describe('Skip the PTY paste delivery on the receiver. The task is still persisted and the receiver can poll via a2a_task_query — use this to avoid injecting content into a running TUI agent\'s prompt stream. If omitted, live TUI agents receive a one-line nudge instead of a full paste.'),
  data: z.record(z.string(), z.unknown()).optional().describe('Optional structured data (JSON)'),
  data_mime_type: z.string().optional().describe('MIME type for data (default: application/json)'),
};

server.tool(
  'send_message',
  'Send a message to another workspace. Use when asked to talk to, greet, or send anything to workspace 1/2/3 etc. Accepts number ("1", "3번"), name ("Workspace 2"), or ID.',
  sendMessageParams,
  sendMessageHandler,
);

// Keep a2a_task_send as alias for backward compatibility
server.tool('a2a_task_send', 'Alias for send_message.', sendMessageParams, sendMessageHandler);

// 4. a2a_task_query — Query tasks by status/role
server.tool(
  'a2a_task_query',
  'Query tasks assigned to you or sent by you. Filter by status and role.',
  {
    status: z.enum(['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled']).optional().describe('Filter by task status'),
    role: z.enum(['user', 'agent']).optional().describe('Filter: "user" = tasks you sent, "agent" = tasks assigned to you'),
  },
  async ({ status, role }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.task.query', { workspaceId: wsId, status, role });
  },
);

// 5. a2a_task_update — Update task status
server.tool(
  'a2a_task_update',
  'Update a task\'s status. Only the receiver can change to working/completed/failed/input-required. Optionally attach artifacts on completion.',
  {
    task_id: z.string().describe('Task ID to update'),
    status: z.enum(['working', 'completed', 'failed', 'input-required']).describe('New status'),
    message: z.string().optional().describe('Optional status message'),
    artifact_name: z.string().optional().describe('Artifact name (for completed tasks)'),
    artifact_data: z.record(z.string(), z.unknown()).optional().describe('Artifact data payload'),
  },
  async ({ task_id, status, message, artifact_name, artifact_data }) => {
    const wsId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId: wsId, taskId: task_id, status };
    // S-C2: include our OWN ptyId so the renderer can compute per-pane role +
    // pane-granular status authz for this update. Verified PID-map hit preferred;
    // falls back to the weak WMUX_PTY_ID env hint (WI-002). Safe downgrade: an
    // ABSENT senderPtyId already falls back to ws-level role + ws authz, so a
    // weak (or forged) value resolves no stronger boundary than that existing
    // fallback — it cannot grant a pane role the caller's own workspace lacks.
    const senderPtyId = getTaskSenderPtyId();
    if (senderPtyId) params.senderPtyId = senderPtyId;
    if (message) params.message = message;
    if (artifact_name) {
      params.artifact = {
        name: artifact_name,
        parts: artifact_data ? [{ kind: 'data', data: artifact_data, metadata: { mimeType: 'application/json' } }] : [],
      };
    }
    return callRpc('a2a.task.update', params);
  },
);

// 6. a2a_task_cancel — Cancel a task you sent
server.tool(
  'a2a_task_cancel',
  'Cancel a task you previously sent. Only the original sender can cancel.',
  {
    task_id: z.string().describe('Task ID to cancel'),
    reason: z.string().optional().describe('Cancellation reason'),
  },
  async ({ task_id, reason }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.task.cancel', { workspaceId: wsId, taskId: task_id, reason });
  },
);

// 7. a2a_broadcast — Broadcast notification to all workspaces
server.tool(
  'a2a_broadcast',
  'Send a message to ALL other workspaces at once (e.g. announcements, greetings). For targeted messages, use a2a_task_send instead.',
  {
    message: z.string().describe('Broadcast message'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority level'),
  },
  async ({ message, priority }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.broadcast', { message, priority: priority || 'normal', workspaceId: wsId });
  },
);

// 8. a2a_set_skills — Register agent capabilities
server.tool(
  'a2a_set_skills',
  'Register your agent capabilities/skills so other agents can discover you via a2a_discover.',
  {
    skills: z.array(z.string()).describe('List of skill tags (e.g., ["frontend", "testing", "devops"])'),
    description: z.string().optional().describe('Short description of what this agent does'),
  },
  async ({ skills, description }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('meta.setSkills', { workspaceId: wsId, skills, description });
  },
);

// === Company A2A tools ===
// These expose the company-mode member-level A2A (inbox/ack pattern) on the
// main MCP server so agents don't need a second MCP connection. The legacy
// wmux-company standalone server still exists for lightweight launches but
// ships the same `company_a2a_*` tool names, so both surfaces are
// interchangeable. Only useful when a wmux "company" has been provisioned
// on the active workspace — otherwise the underlying RPCs return an empty
// / unavailable response.

server.tool(
  'company_a2a_whoami',
  'Company mode: identify who you are in the company hierarchy (name, role, department, status). Requires an active company on the workspace — use a2a_whoami for plain workspace identity instead.',
  {},
  async () => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.whoami', { workspaceId: wsId });
  },
);

server.tool(
  'company_a2a_send',
  'Company mode: send a structured message to another agent by name (resolves by department → lead, member name, or "CEO"). Prefer this over send_message when the target is a company member rather than a raw workspace.',
  {
    to: z.string().describe('Target agent name, department name, or "CEO"'),
    message: z.string().describe('Message content'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Message priority (default: normal)'),
  },
  async ({ to, message, priority }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.send', {
      to,
      message,
      priority: priority || 'normal',
      workspaceId: wsId,
    });
  },
);

server.tool(
  'company_a2a_broadcast',
  'Company mode: broadcast a message to ALL agents in the company. Use sparingly. For workspace-wide broadcast (not company members), use a2a_broadcast.',
  {
    message: z.string().describe('Broadcast message content'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Message priority'),
  },
  async ({ message, priority }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.broadcast', {
      message,
      priority: priority || 'normal',
      workspaceId: wsId,
    });
  },
);

server.tool(
  'company_a2a_inbox',
  'Company mode: pull your inbox of structured messages from other agents. Returns messages with IDs — call company_a2a_ack to mark them as read. Canonical delivery channel (inbox/ack) rather than PTY paste.',
  {
    unread_only: z.boolean().optional().describe('Only return unread messages (default: true)'),
  },
  async ({ unread_only }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.inbox', { workspaceId: wsId, unreadOnly: unread_only !== false });
  },
);

server.tool(
  'company_a2a_ack',
  'Company mode: acknowledge (mark as read) inbox messages by their IDs.',
  {
    message_ids: z.array(z.string()).describe('Array of message IDs to acknowledge'),
  },
  async ({ message_ids }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.ack', { workspaceId: wsId, messageIds: message_ids });
  },
);

server.tool(
  'company_a2a_status',
  'Company mode: get the full company status — all departments, members, roles, and online status. Use this to discover who you can communicate with.',
  {},
  async () => callRpc('company.a2a.status'),
);

// === A2A channel tools ===
// Six standard MCP tools that expose the a2a.channel.* pipe RPC surface.
// `channel.history` is intentionally deferred per plan Scope Boundaries.
// Workspace identity uses the same resolveWorkspaceId as the other
// workspace-routed tools (verified PID-map hit first, env-hint fallback).
// D5: also expose the server's verified senderPtyId (MY_PTY_ID, the PID-map
// walk result) so the main-side a2a.channel handler resolves + stamps the
// workspace identity server-side, ignoring any client-supplied value.
//
// WI-002 PROVENANCE: this MUST stay MY_PTY_ID (walk-hit only) — do NOT switch it
// to getTaskSenderPtyId(). a2a.channel.rpc.ts gates mutating channel calls
// (create/post/archive/join/leave) on a RESOLVABLE senderPtyId and fails closed
// without one. Feeding the weak WMUX_PTY_ID env hint here would downgrade that
// authz from a main-resolved PID-map hit to a spoofable env var. The server-side
// walk (PROPER fix) restores a ptyId on a client-walk miss — but it is
// main-correlated from a caller-asserted pid, so within the #113 same-user
// ceiling this gate is a reliability mechanism (a same-user caller could assert
// a foreign pid), not a same-user security boundary. Still fail-closed when no
// hit at all.
registerChannelTools(server, {
  resolveWorkspaceId: requireWorkspaceId,
  getSenderPtyId: () => MY_PTY_ID,
});

// === Pane + surface lifecycle tools (issue #285) ===
// Five MCP tools (pane_split / pane_close / pane_focus, surface_new /
// surface_close) that mirror the workspace-scoped pane/surface lifecycle RPCs
// (#236/#238/#256/#257), so an external supervisor agent can spawn + reap its
// own panes through MCP instead of a hand-written daemon client. The CREATE
// family (split/new) resolves the caller's OWN workspace when workspaceId is
// omitted — resolveScopedReadWorkspaceId, the same fail-soft read resolver
// pane_list / surface_list use, so an omitted id never lands on the on-screen
// workspace by surprise. The ADDRESS family (close/focus) takes a
// globally-unique id resolved across all workspaces. callRpc is injected so
// paneLifecycle.test.ts can assert each handler's RPC mapping against a mock.
registerPaneLifecycleTools(server, {
  callRpc,
  resolveCallerWorkspaceId: resolveScopedReadWorkspaceId,
});

// === Start server ===

// Hook the MCP initialize handshake so wmux substrate learns the declared
// plugin identity (clientInfo.name + version). Fire `mcp.identify` once so
// the trust DB picks up first-contact metadata — record-only, no
// enforcement. See docs/api/mcp-plugin-spec.md.
function wireClientIdentityHook(): void {
  const underlying = (server as unknown as { server?: {
    oninitialized?: () => void;
    getClientVersion?: () => { name?: string; version?: string } | undefined;
  } }).server;
  if (!underlying) return;
  underlying.oninitialized = () => {
    try {
      const info = underlying.getClientVersion?.();
      const name = info?.name?.trim() || undefined;
      const version = info?.version?.trim() || undefined;
      if (!name) return;
      setClientIdentity(name, version);
      // Fire-and-forget — the trust DB write is best-effort; failures must
      // never block the MCP handshake from completing.
      sendRpc('mcp.identify', { name, version }).catch(() => {
        /* substrate may be unavailable mid-restart; legacy path takes over */
      });
    } catch {
      /* swallow — identity is non-essential to MCP operation */
    }
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  wireClientIdentityHook();
  await server.connect(transport);

  // Clean up Playwright connection when transport closes. Also drop the
  // declared plugin identity so any trailing RPC traffic falls back to
  // the substrate's legacy audit path instead of stamping a stale name —
  // a reconnect must re-run the MCP initialize handshake to re-establish
  // identity (see wireClientIdentityHook above).
  transport.onclose = async () => {
    console.log('[wmux-mcp] Transport closed, disconnecting Playwright');
    clearClientIdentity();
    await PlaywrightEngine.getInstance().disconnect();
  };

  // Graceful shutdown
  const shutdown = async () => {
    await PlaywrightEngine.getInstance().disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('wmux MCP server failed to start:', err);
  process.exit(1);
});
