// Single declarative source of truth: which capability gates each RPC method,
// and (when applicable) how to extract path strings from request params for
// the path-glob check.
//
// Phase 2.2 design (plan D1/D2): the central gate at RpcRouter.dispatch
// resolves both the capability check AND the path check from this table.
// `Record<RpcMethod, RequiredCapability>` makes a new RPC method without an
// entry a TypeScript compile-time error — "I added a method but forgot to
// gate it" surfaces in `tsc --noEmit`, not in code review.
//
// Capability layer vs method layer (spec §3.5):
//   - capability names come from KNOWN_CAPABILITIES in permissionGrammar.ts
//     (`events.subscribe`, `terminal.read`, ...)
//   - RPC methods are the wire names (`events.poll`, `input.readScreen`, ...)
// One capability can gate several methods (e.g. `terminal.read` gates both
// `input.readScreen` and `terminal.readEvents`).
//
// Identity bootstrap (`mcp.identify`, `mcp.declarePermissions`) appears in
// the table with `capability: null` rather than being a hard-coded enforcer
// special case (architect-reviewer + backend-architect both flagged this in
// the plan-review pass — the table stays single-source-of-truth even for
// "no gate" methods).
//
// Internal-only surfaces (daemon control, company subsystem, surface
// arrangement) map to the reserved `wmux.internal` capability. The
// permissionGrammar reserves the `wmux.` prefix, so no plugin can ever
// declare it; legacy callers (no `clientName` envelope) fall through the
// grandfather path in RpcRouter and stay allowed during the v3.0 transition.

import type { RpcMethod } from '../../shared/rpc';

/**
 * Capability declared by a plugin (matched against KNOWN_CAPABILITIES in
 * permissionGrammar.ts at parse time) or one of two sentinels:
 *   - `null`             — method is bootstrap-exempt; no capability needed
 *   - `'wmux.internal'`  — substrate-internal method; reserved prefix, no
 *                          plugin can ever satisfy this. Legacy (no envelope)
 *                          callers grandfather through RpcRouter's existing
 *                          legacy path.
 */
export type RequiredCapabilityName = string | null;
export type CapabilityResolver = (params: Record<string, unknown>) => RequiredCapabilityName;

/**
 * Extracts the path strings being touched by a request, for the path-glob
 * check. Return types:
 *   - `undefined`           — method has no path to check (capability-only gate)
 *   - `string`              — single path (single-path methods like pane.setMetadata)
 *   - `string[]`            — multiple paths (e.g. events.poll with `types: [...]`)
 *
 * The `'handler-resolves'` sentinel reserves an escape hatch for methods
 * whose path can only be known after handler-side resolution (e.g. when a
 * `paneId` must be looked up to determine its workspace before the path is
 * knowable). Such handlers MUST call `PermissionEnforcer.checkPath` themselves;
 * the central gate only verifies the capability for them.
 */
export type PathExtractor =
  | ((params: Record<string, unknown>) => string | string[] | undefined)
  | 'handler-resolves';

/**
 * Risk class — drives the approval-dialog wording table (plan D5). The
 * enforcer itself doesn't read this; ApprovalQueue uses it when rendering.
 */
export type RiskClass =
  | 'terminal-content' // reads what's on the user's screen
  | 'terminal-input'   // types into the user's panes
  | 'browser'          // controls a Playwright browser
  | 'metadata'         // labels / status / custom map writes
  | 'events'           // event subscription
  | 'pane-lifecycle'   // create/focus/list panes
  | 'workspace'        // workspace claim/read
  | 'a2a'              // agent-to-agent messaging
  | 'ui'               // plugin host UI contribution points (B-1)
  | 'notifications'    // terminal desktop-notification text (OSC 9/777/99)
  | 'internal';        // wmux.internal — never surfaced

/**
 * When `pathFromParams` yields multiple paths and some match the declaration
 * while others don't, the dispatcher needs to know whether the method can
 * proceed on the allowed subset:
 *
 *   - `'partial'`        — pass allowed paths through to handler (e.g. events.poll
 *                          filtering to allowed topics)
 *   - `'all-or-nothing'` — wholesale reject (e.g. pane.clearMetadata: cannot
 *                          partially-clear)
 *
 * Default is `'all-or-nothing'`; only opt into partial when the handler's
 * semantics support it.
 */
export type MultiPathMode = 'partial' | 'all-or-nothing';

export interface RequiredCapability {
  capability: RequiredCapabilityName | CapabilityResolver;
  pathFromParams?: PathExtractor;
  riskClass?: RiskClass;
  multiPathMode?: MultiPathMode;
}

export function resolveRequiredCapability(
  entry: RequiredCapability,
  params: Record<string, unknown>,
): RequiredCapabilityName {
  return typeof entry.capability === 'function' ? entry.capability(params) : entry.capability;
}

// === Path extractors ===
//
// Pulled out as named functions so a stack trace in shadow-mode rejection
// telemetry points at the right extractor, and so each can be unit-tested
// in isolation.

/** pane.setMetadata: each top-level field present in params contributes one path. */
function pathsFromSetMetadata(params: Record<string, unknown>): string[] | undefined {
  const paths: string[] = [];
  if (typeof params.label === 'string') paths.push('label');
  // P2: `role` is no longer a settable field (deprecated) — not advertised here.
  if (typeof params.status === 'string') paths.push('status');
  if (params.custom && typeof params.custom === 'object' && !Array.isArray(params.custom)) {
    for (const key of Object.keys(params.custom as Record<string, unknown>)) {
      paths.push(`custom.${key}`);
    }
  }
  return paths.length > 0 ? paths : undefined;
}

/**
 * pane.clearMetadata wipes the whole record. We enumerate shared paths
 * explicitly so a plugin restricted to `meta.write:custom.foo.*` fails the
 * gate (it must not nuke shared label/role/status owned by other plugins
 * or the user). Custom subtrees can't be enumerated without reading the
 * store, so the gate accepts the shared-paths check as a proxy for "broad
 * meta.write" — a plugin with only `meta.write:custom.foo.*` will fail on
 * 'label' and the all-or-nothing mode rejects wholesale.
 */
function pathsFromClearMetadata(): string[] {
  return ['label', 'role', 'status'];
}

/**
 * events.poll requests an event subscription filtered by `types`. Undefined
 * means "all types" — represented as the literal path string `'**'` so a
 * declaration like `events.subscribe:pane.*` (with its `^pane\.[^.]*$`
 * regex) won't match (correctly requiring unrestricted `events.subscribe`).
 */
function pathsFromEventsPoll(params: Record<string, unknown>): string | string[] {
  const types = params.types;
  if (Array.isArray(types)) {
    const filtered = types.filter((t): t is string => typeof t === 'string');
    return filtered.length > 0 ? filtered : '**';
  }
  return '**';
}

function capabilityFromA2aTaskSend(params: Record<string, unknown>): RequiredCapabilityName {
  return params.execute === true ? 'a2a.execute' : 'a2a.send';
}

// === The map ===

export const METHOD_CAPABILITY: Record<RpcMethod, RequiredCapability> = {
  // --- Identity bootstrap (spec §4.1, §4.2) ---
  // MUST stay unconditionally callable so a fresh plugin can declare itself.
  // Mirrors IDENTITY_OWN_METHODS in RpcRouter.ts.
  'mcp.identify': { capability: null },
  'mcp.declarePermissions': { capability: null },

  // mcp.claimWorkspace lets a plugin attribute its RPCs to a specific
  // workspace pane. External MCP plugins use this on connect to scope
  // subsequent calls. `workspace.claim` is in KNOWN_CAPABILITIES.
  'mcp.claimWorkspace': { capability: 'workspace.claim', riskClass: 'workspace' },

  // --- Workspace / surface (spec leaves these internal for v3.0) ---
  'workspace.list':    { capability: 'workspace.read', riskClass: 'workspace' },
  'workspace.current': { capability: 'workspace.read', riskClass: 'workspace' },
  'workspace.new':     { capability: 'wmux.internal' },
  'workspace.focus':   { capability: 'wmux.internal' },
  'workspace.close':   { capability: 'wmux.internal' },
  'surface.list':      { capability: 'wmux.internal' },
  'surface.new':       { capability: 'wmux.internal' },
  'surface.focus':     { capability: 'wmux.internal' },
  'surface.close':     { capability: 'wmux.internal' },

  // --- Pane lifecycle ---
  'pane.list':   { capability: 'pane.read', riskClass: 'pane-lifecycle' },
  'pane.focus':  { capability: 'pane.read', riskClass: 'pane-lifecycle' },
  'pane.split':  { capability: 'pane.create', riskClass: 'pane-lifecycle' },
  'pane.close':  { capability: 'pane.create', riskClass: 'pane-lifecycle' },
  'pane.search': { capability: 'pane.search', riskClass: 'terminal-content' },

  // --- Metadata (spec §3.4) ---
  'pane.setMetadata': {
    capability: 'meta.write',
    pathFromParams: pathsFromSetMetadata,
    riskClass: 'metadata',
    multiPathMode: 'all-or-nothing',
  },
  // getMetadata returns the whole blob; per-field filtering is a v3.1
  // feature (would require handler-side projection). For v3.0 the gate
  // checks capability only — declaring `meta.read:custom.foo.*` still
  // returns the full record, scoped reads come later.
  'pane.getMetadata': { capability: 'meta.read', riskClass: 'metadata' },
  'pane.clearMetadata': {
    capability: 'meta.write',
    pathFromParams: pathsFromClearMetadata,
    riskClass: 'metadata',
    multiPathMode: 'all-or-nothing',
  },

  // --- Workspace-level meta (status/progress text). The §3.4 path
  //     namespace is pane-scoped; workspace-level keys aren't yet enumerated
  //     in the spec, so for v3.0 these gate on `meta.write` capability with
  //     no per-field path check. Tighter scoping is a v3.1 follow-up.
  'meta.setStatus':   { capability: 'meta.write', riskClass: 'metadata' },
  'meta.setProgress': { capability: 'meta.write', riskClass: 'metadata' },
  'meta.setSkills':   { capability: 'meta.write', riskClass: 'metadata' },

  // --- Plugin host UI (B-1). Pane decorations are data pushed through the
  //     bridge and rendered by the host — never plugin DOM inside a pane.
  'ui.decoratePane':  { capability: 'ui.pane-decoration', riskClass: 'ui' },

  // --- Events (spec §3.5). Capability is `events.subscribe`; method is
  //     `events.poll`. `params.types` controls the topic filter; undefined
  //     means "everything" which only an unrestricted declaration satisfies.
  'events.poll': {
    capability: 'events.subscribe',
    pathFromParams: pathsFromEventsPoll,
    riskClass: 'events',
    multiPathMode: 'partial',
  },

  // --- Terminal IO (spec §3.6) ---
  'input.send':          { capability: 'terminal.send', riskClass: 'terminal-input' },
  'input.sendKey':       { capability: 'terminal.send', riskClass: 'terminal-input' },
  'input.readScreen':    { capability: 'terminal.read', riskClass: 'terminal-content' },
  'terminal.readEvents': { capability: 'terminal.read', riskClass: 'terminal-content' },

  // --- Notifications (substrate-side; bundled UI only) ---
  'notify': { capability: 'wmux.internal' },

  // --- System introspection. Identity-style bootstrap: any caller can ask
  //     what version of wmux they're talking to or what capabilities are
  //     exposed. No data leak; less than what a probe-by-error would yield.
  'system.identify':     { capability: null },
  'system.capabilities': { capability: null },

  // --- Browser (Playwright). Plugins declaring these get the browser
  //     risk-class prompt; all are gated against KNOWN_CAPABILITIES entries.
  'browser.open':              { capability: 'browser.navigate', riskClass: 'browser' },
  'browser.navigate':          { capability: 'browser.navigate', riskClass: 'browser' },
  'browser.goBack':            { capability: 'browser.navigate', riskClass: 'browser' },
  'browser.close':             { capability: 'browser.navigate', riskClass: 'browser' },
  'browser.session.start':     { capability: 'browser.navigate', riskClass: 'browser' },
  'browser.session.stop':      { capability: 'browser.navigate', riskClass: 'browser' },
  'browser.session.status':    { capability: 'browser.read',     riskClass: 'browser' },
  'browser.session.list':      { capability: 'browser.read',     riskClass: 'browser' },
  'browser.type.humanlike':    { capability: 'browser.type',     riskClass: 'browser' },
  'browser.cdp.target':        { capability: 'browser.read',     riskClass: 'browser' },
  'browser.cdp.info':          { capability: 'browser.read',     riskClass: 'browser' },
  'browser.screenshot':        { capability: 'browser.screenshot', riskClass: 'browser' },
  'browser.evaluate':          { capability: 'browser.evaluate',   riskClass: 'browser' },
  'browser.console.get':       { capability: 'browser.read',       riskClass: 'browser' },
  'browser.network.get':       { capability: 'browser.read',       riskClass: 'browser' },
  'browser.responseBody.get':  { capability: 'browser.read',       riskClass: 'browser' },
  'browser.type.cdp':          { capability: 'browser.type',  riskClass: 'browser' },
  'browser.click.cdp':         { capability: 'browser.click', riskClass: 'browser' },
  'browser.press.cdp':         { capability: 'browser.type',  riskClass: 'browser' },
  // State tools (#111 packaged RPC fallback). resize stays under
  // `browser.evaluate`: a caller that can already run arbitrary JS can resize the
  // viewport through the page, so it grants nothing beyond what browser.evaluate
  // does. browser.cookies and browser.emulate are the exceptions and each gets its
  // own capability. cookies: the CDP Network domain reads/writes HttpOnly cookies
  // and the whole jar that document.cookie can never reach. emulate: it toggles
  // offline mode, injects extra request headers, overrides timezone/locale/device
  // metrics, and calls Browser.grantPermissions/resetPermissions — browser-state
  // mutations page JavaScript cannot perform. Gating either on browser.evaluate
  // would silently widen a page-JS grant into raw cookie access or browser-state
  // mutation. (The sensitive-domain redaction lives in the MCP tool, not the raw
  // RPC, so the cookies handler itself hands back everything.)
  'browser.cookies':           { capability: 'browser.cookies',  riskClass: 'browser' },
  'browser.resize':            { capability: 'browser.evaluate', riskClass: 'browser' },
  'browser.emulate':           { capability: 'browser.emulate',  riskClass: 'browser' },

  // --- Daemon control. Internal-only; reserved capability.
  'daemon.createSession':    { capability: 'wmux.internal' },
  'daemon.destroySession':   { capability: 'wmux.internal' },
  'daemon.attachSession':    { capability: 'wmux.internal' },
  'daemon.detachSession':    { capability: 'wmux.internal' },
  'daemon.resizeSession':    { capability: 'wmux.internal' },
  'daemon.listSessions':     { capability: 'wmux.internal' },
  'daemon.readPromptEvents': { capability: 'wmux.internal' },
  'daemon.ping':             { capability: 'wmux.internal' },
  'daemon.shutdown':         { capability: 'wmux.internal' },
  'daemon.compact':          { capability: 'wmux.internal' },
  // X8 supervision control is renderer-only (main IPC → daemon). External
  // clients must never re-arm a tripped runaway guard or stop supervision —
  // same posture as project-trust ops.
  'daemon.superviseRearm':   { capability: 'wmux.internal' },
  'daemon.superviseStop':    { capability: 'wmux.internal' },
  // X6 ③: resume-binding persistence is forwarded ONLY by main (the hooks.signal
  // handler) after env-first ptyId resolution. External clients must never set a
  // pane's resume binding — same internal-only posture as supervision control.
  'daemon.setResumeBinding': { capability: 'wmux.internal' },
  // LanLink PR-2 — cursor-pull of the durable remote inbox. main↔daemon only
  // (DaemonClient → daemon control pipe); never an external MCP surface.
  'daemon.inbox.poll':       { capability: 'wmux.internal' },
  // LanLink PR-3 — control-plane read/write (enable toggle + NIC selection).
  // main↔daemon only (DaemonClient → daemon control pipe); never an external MCP
  // surface — wmux.internal keeps a remote/MCP caller from enumerating the host's
  // NICs or flipping the LAN listener on.
  'lanlink.status':          { capability: 'wmux.internal' },
  'lanlink.configure':       { capability: 'wmux.internal' },
  // LanLink PR-5 — pairing/peer control plane. SAME posture as PR-3 above: these
  // ride the machine-local control pipe ONLY (DaemonClient → daemon control pipe),
  // never RpcRouter and never the LAN net.Server. wmux.internal hard-blocks any
  // plugin/MCP caller from enumerating peers or driving pairing — a structural
  // marker, since RpcRouter has no `lanlink.*` registration to even reach these.
  'lanlink.pair.begin':      { capability: 'wmux.internal' },
  'lanlink.pair.status':     { capability: 'wmux.internal' },
  'lanlink.pair.cancel':     { capability: 'wmux.internal' },
  'lanlink.pair.join':       { capability: 'wmux.internal' },
  'lanlink.send':            { capability: 'wmux.internal' },
  'lanlink.peers.list':      { capability: 'wmux.internal' },
  'lanlink.peers.remove':    { capability: 'wmux.internal' },

  // --- A2A (agent-to-agent) ---
  'a2a.resolve.identity': { capability: 'a2a.read',    riskClass: 'a2a' },
  'a2a.whoami':           { capability: 'a2a.read',    riskClass: 'a2a' },
  'a2a.discover':         { capability: 'a2a.read',    riskClass: 'a2a' },
  'a2a.task.send':        { capability: capabilityFromA2aTaskSend, riskClass: 'a2a' },
  'a2a.task.query':       { capability: 'a2a.read',    riskClass: 'a2a' },
  'a2a.task.update':      { capability: 'a2a.send',    riskClass: 'a2a' },
  'a2a.task.cancel':      { capability: 'a2a.send',    riskClass: 'a2a' },
  'a2a.broadcast':        { capability: 'a2a.send',    riskClass: 'a2a' },

  // --- A2A channels (a2a-channels) ---
  // Two-capability split. `read` covers the four read methods; `send`
  // covers every mutation including post (the post path is the fan-out:
  // one call hits N member workspaces via the channel.message bus
  // event). Capability is the only gate — channels have no per-payload
  // path glob today (the workspaceId is the bus-scoping anchor, not a
  // permission boundary).
  'a2a.channel.list':        { capability: 'a2a.channel.read', riskClass: 'a2a' },
  'a2a.channel.get':         { capability: 'a2a.channel.read', riskClass: 'a2a' },
  'a2a.channel.getMessages': { capability: 'a2a.channel.read', riskClass: 'a2a' },
  'a2a.channel.getMembers':  { capability: 'a2a.channel.read', riskClass: 'a2a' },
  'a2a.channel.create':      { capability: 'a2a.channel.send', riskClass: 'a2a' },
  'a2a.channel.join':        { capability: 'a2a.channel.send', riskClass: 'a2a' },
  'a2a.channel.leave':       { capability: 'a2a.channel.send', riskClass: 'a2a' },
  'a2a.channel.post':        { capability: 'a2a.channel.send', riskClass: 'a2a' },
  'a2a.channel.invite':      { capability: 'a2a.channel.send', riskClass: 'a2a' },
  // archive + kick are humans-only and NOT routed on the pipe (a2a.channel.rpc.ts),
  // so an agent can never reach them — these entries exist only for RpcMethod
  // completeness.
  'a2a.channel.archive':     { capability: 'a2a.channel.send', riskClass: 'a2a' },
  'a2a.channel.kick':        { capability: 'a2a.channel.send', riskClass: 'a2a' },
  'a2a.channel.ack':         { capability: 'a2a.channel.read', riskClass: 'a2a' },

  // --- Company subsystem (substrate-internal team/orchestration). All
  //     internal for v3.0; can be re-classified once spec covers a2a teams.
  'company.create':         { capability: 'wmux.internal' },
  'company.destroy':        { capability: 'wmux.internal' },
  'company.status':         { capability: 'wmux.internal' },
  'company.addDept':        { capability: 'wmux.internal' },
  'company.removeDept':     { capability: 'wmux.internal' },
  'company.addMember':      { capability: 'wmux.internal' },
  'company.removeMember':   { capability: 'wmux.internal' },
  'company.broadcast':      { capability: 'wmux.internal' },
  'company.sendDept':       { capability: 'wmux.internal' },
  'company.sendMember':     { capability: 'wmux.internal' },
  'company.message':        { capability: 'wmux.internal' },
  'company.save':           { capability: 'wmux.internal' },
  'company.restore':        { capability: 'wmux.internal' },
  'company.templates':      { capability: 'wmux.internal' },
  'company.worktreeSetup':  { capability: 'wmux.internal' },
  'company.mergeDept':      { capability: 'wmux.internal' },
  'company.a2a.whoami':     { capability: 'wmux.internal' },
  'company.a2a.send':       { capability: 'wmux.internal' },
  'company.a2a.broadcast':  { capability: 'wmux.internal' },
  'company.a2a.inbox':      { capability: 'wmux.internal' },
  'company.a2a.ack':        { capability: 'wmux.internal' },
  'company.a2a.status':     { capability: 'wmux.internal' },
  'company.provision':      { capability: 'wmux.internal' },
  'company.provisionAll':   { capability: 'wmux.internal' },
  'company.provisionCeo':   { capability: 'wmux.internal' },

  // --- Hooks (Phase 1 hook plugin) ---
  // Internal channel from the wmux-bundled hook plugin. No external plugin
  // should fire these — `wmux.internal` keeps the gate closed.
  'hooks.signal': { capability: 'wmux.internal' },
};

/**
 * Capability → RiskClass lookup. The methodCapabilityMap above is keyed by
 * RPC method; the approval dialog needs to classify each *capability* a
 * plugin declared, regardless of which methods that capability gates. This
 * table is the second axis.
 *
 * Keep in sync with KNOWN_CAPABILITIES in permissionGrammar.ts — every
 * grantable capability MUST appear here so the approval dialog can render
 * appropriate copy. A future test pins this invariant.
 *
 * `wmux.internal` is intentionally absent: it's a reserved prefix that
 * never appears in a plugin's declaration, so the dialog never renders it.
 */
export const CAPABILITY_RISK_CLASS: Record<string, RiskClass> = {
  // Pane lifecycle and content
  'pane.read':       'pane-lifecycle',
  'pane.write':      'pane-lifecycle',
  'pane.create':     'pane-lifecycle',
  'pane.delete':     'pane-lifecycle',
  'pane.search':     'terminal-content',
  // Metadata
  'meta.read':       'metadata',
  'meta.write':      'metadata',
  // Events
  'events.subscribe':'events',
  // Workspaces
  'workspace.read':  'workspace',
  'workspace.claim': 'workspace',
  // Terminal IO
  'terminal.send':   'terminal-input',
  'terminal.read':   'terminal-content',
  // Browser
  'browser.navigate':  'browser',
  'browser.click':     'browser',
  'browser.type':      'browser',
  'browser.screenshot':'browser',
  'browser.evaluate':  'browser',
  'browser.read':      'browser',
  'browser.cookies':   'browser',
  'browser.emulate':   'browser',
  // A2A
  'a2a.send':    'a2a',
  'a2a.execute': 'a2a',
  'a2a.read':    'a2a',
  // A2A channels (a2a-channels). Same risk class as a2a.send/read —
  // the approval dialog renders the same wording; the split is a
  // capability-level fence, not a UX differentiation.
  'a2a.channel.read': 'a2a',
  'a2a.channel.send': 'a2a',
  // Plugin host UI contribution points (B-1) — enforced at mount time by
  // the renderer host, not per-RPC; classed here so the approval dialog
  // renders real copy instead of fallback text.
  'ui.sidebar':         'ui',
  'ui.statusbar':       'ui',
  'ui.pane-decoration': 'ui',
  'ui.commands':        'ui',
  // notification.received opt-in (events.poll gate)
  'notifications.read': 'notifications',
};

/**
 * Risk-class → user-facing copy for the approval dialog (plan D5).
 *
 * Wording asymmetry is intentional. Terminal-content/input get bold-warning
 * language that names the concrete privilege ("read what's on your screen,
 * including secrets") — this is the difference between "I clicked Approve
 * because metadata sounds harmless" and "I clicked Approve knowing exactly
 * what I gave away." Metadata, events, pane-lifecycle, and workspace are
 * intentionally neutral — they don't expose user data.
 *
 * `severity` drives the dialog's accent color (warning vs caution vs none).
 * `summary` is the headline shown next to the capability name. `detail` is
 * the paragraph shown in expanded view.
 */
export interface RiskClassCopy {
  /** Severity level — drives visual treatment (color, icon, font weight). */
  severity: 'critical' | 'caution' | 'neutral';
  /** Short headline displayed inline with the capability name. */
  summary: string;
  /** Expanded paragraph explaining what the user is agreeing to. */
  detail: string;
}

export const RISK_CLASS_COPY: Record<RiskClass, RiskClassCopy> = {
  'terminal-content': {
    severity: 'critical',
    summary: 'Can read what is on your screen',
    detail:
      'Includes secrets, agent output, command history, and anything else visible in your terminal panes — even content that was on screen before the plugin connected.',
  },
  'terminal-input': {
    severity: 'critical',
    summary: 'Can type into your panes as if it were you',
    detail:
      'The plugin can send keystrokes (including Enter, Ctrl+C, and editor commands) to any pane in this workspace. Treat this with the same trust level as giving someone your keyboard.',
  },
  'browser': {
    severity: 'caution',
    summary: 'Can control a Playwright browser session',
    detail:
      'The plugin can open pages, click elements, type text, run JavaScript, and capture screenshots. Sites you log into in this browser are reachable by the plugin.',
  },
  'a2a': {
    severity: 'caution',
    summary: 'Can send and read agent-to-agent messages',
    detail:
      'The plugin can dispatch tasks to other agents in your wmux session and read their responses. `a2a.execute` additionally lets it spawn agents with bypassPermissions.',
  },
  'metadata': {
    severity: 'neutral',
    summary: 'Can label your panes',
    detail:
      'Reads and writes pane labels, statuses, and a per-plugin custom data map. Does not see terminal contents — only the substrate-managed metadata layer.',
  },
  'events': {
    severity: 'neutral',
    summary: 'Can subscribe to pane lifecycle events',
    detail:
      'Receives notifications when panes are created, closed, focused, or have their metadata changed. Payloads contain pane IDs and metadata, never terminal content.',
  },
  'pane-lifecycle': {
    severity: 'neutral',
    summary: 'Can list, create, and focus panes',
    detail:
      'The plugin can enumerate your panes and manipulate the layout. It cannot read terminal contents through these capabilities alone.',
  },
  'workspace': {
    severity: 'neutral',
    summary: 'Can read and claim workspaces',
    detail:
      'The plugin can see the list of workspaces and attribute its RPC calls to a specific one. No data leakage between workspaces.',
  },
  'ui': {
    severity: 'neutral',
    summary: 'Can add panels and widgets to the wmux UI',
    detail:
      'The plugin renders its own interface in a sandboxed frame (sidebar panel, status-bar widget, pane badges, or command-palette entries). The frame cannot read your terminal or other UI — any data access requires the capabilities listed separately.',
  },
  'notifications': {
    severity: 'caution',
    summary: 'Can read terminal notification text',
    detail:
      'Receives the title and body of desktop notifications emitted by programs in your terminals (OSC 9/777/99). Notification text is program-controlled and can include fragments of command output.',
  },
  'internal': {
    severity: 'critical',
    summary: 'wmux internal — should never be shown to user',
    detail:
      'Reserved capability that no plugin can declare. If you see this in an approval dialog, file a bug.',
  },
};

