// Live-Chrome write scope — the agent-window policy shared by both lanes.
//
// On the `live` backend an agent READS the whole browser (the workspace's live
// binding is that consent) but WRITES only to tabs it opened itself, plus tabs
// the user explicitly lent it. Two independent lanes have to agree on that:
// the main-process RPCs in browser.rpc.ts, and the MCP Playwright lane which
// drives many writes over CDP without passing through main at all. This module
// is the vocabulary both import so the refusal text, the setting values and the
// owner labels cannot drift apart.
//
// Mechanism credit: confining an agent's writes to the window it opened, with an
// explicit human hand-over for any other tab, was observed in Tencent's
// BrowserSkill (MIT) and referenced as prior art. No code copied.

/** Who may write to a live Chrome tab, from one workspace's point of view. */
export type LiveTabOwner =
  /** wmux opened it for this workspace. */
  | 'agent'
  /** The user lent this workspace an existing tab. */
  | 'borrowed'
  /** Somebody else's tab — the user's own, or another workspace's. */
  | 'user';

export const LIVE_WRITE_SCOPES = ['agent', 'all'] as const;

/**
 * The persisted setting.
 *
 * `agent` (default) confines writes to the agent's own window plus lent tabs.
 * `all` restores the pre-policy behaviour — every live tab is writable — and is
 * the strictly LARGER grant: it hands an agent every logged-in session in the
 * browser, not one window's worth.
 */
export type LiveWriteScope = (typeof LIVE_WRITE_SCOPES)[number];

export const DEFAULT_LIVE_WRITE_SCOPE: LiveWriteScope = 'agent';

export function isLiveWriteScope(value: unknown): value is LiveWriteScope {
  return typeof value === 'string' && (LIVE_WRITE_SCOPES as readonly string[]).includes(value);
}

/** Stable prefix every refusal starts with, in both lanes. */
export const AGENT_WINDOW_SCOPE_CODE = 'agent_window_scope';

/** The one remedy: ask the human to lend the tab. Quoted verbatim in the error
 *  so an agent can copy the call out of the message. */
export function borrowHint(surfaceId: string): string {
  return `borrow it first: browser_tabs action:"borrow" surfaceId:"${surfaceId}"`;
}

/**
 * The refusal text. Starts with AGENT_WINDOW_SCOPE_CODE so a caller can branch
 * on it without parsing, and names the surface it is about — an agent driving
 * several tabs cannot otherwise tell which one it was refused.
 */
export function agentWindowScopeMessage(method: string, surfaceId: string): string {
  return (
    `${AGENT_WINDOW_SCOPE_CODE}: ${method} writes to a live Chrome tab this workspace does not own. ` +
    'On Live Chrome an agent reads the whole browser but writes only to the tabs it opened, ' +
    `plus tabs the user lends it. ${borrowHint(surfaceId)}`
  );
}

/**
 * Typed refusal so the MCP lane's page-resolution fallbacks can re-raise it
 * instead of swallowing it. Falling back would send the same write down the
 * main RPC lane — where it is refused again, but only after the agent has been
 * told "no page resolved", which is not what happened.
 */
export class AgentWindowScopeError extends Error {
  readonly code = AGENT_WINDOW_SCOPE_CODE;

  constructor(method: string, surfaceId: string) {
    super(agentWindowScopeMessage(method, surfaceId));
    this.name = 'AgentWindowScopeError';
  }
}

export function isAgentWindowScopeError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && error.code === AGENT_WINDOW_SCOPE_CODE
  );
}

/**
 * The main-lane RPCs that WRITE, and are therefore gated on live.
 *
 * Reads are deliberately absent: snapshot, screenshot, extract, network,
 * console, cookies-read, storage-read and tabs-list keep today's full exposure.
 * `browser.cookies` is in the set because its set/clear actions mutate; the
 * handler lets a plain read through (see the gate's action check).
 *
 * `browser.type.humanlike` is absent for a different reason, stated because it
 * looks like an omission: it generates a keystroke SCHEDULE and never touches a
 * page — it takes no surface, opens no target and resolves no workspace. The
 * keystrokes it describes are delivered through `browser.type.cdp` /
 * `browser.press.cdp` or the Playwright lane, and both of those are gated.
 */
export const LIVE_WRITE_RPC_METHODS: ReadonlySet<string> = new Set([
  'browser.navigate',
  'browser.goBack',
  'browser.click.cdp',
  'browser.type.cdp',
  'browser.press.cdp',
  'browser.hover.cdp',
  'browser.drag.cdp',
  'browser.evaluate',
  'browser.cookies',
  'browser.emulate',
  'browser.resize',
  'browser.close',
]);

/**
 * How long a borrow request stays on screen before it auto-denies.
 *
 * Shared because both ends of the call need it: main runs the deadline, and the
 * MCP client has to give the `browser.tabs` RPC a longer one than this. Its
 * default is 10 s, which silently capped the human's answer at 10 s — the prompt
 * stayed up, the tool call had already failed, and a retry inside the window
 * came back `borrow_pending`.
 */
export const BORROW_APPROVAL_DEADLINE_MS = 60_000;

/**
 * Deadline for the `browser.tabs borrow` RPC itself. Strictly longer than the
 * prompt's, so the transport never gives up on a question the user is still
 * looking at; main answers on its own deadline well before this fires.
 */
export const BORROW_RPC_TIMEOUT_MS = BORROW_APPROVAL_DEADLINE_MS + 15_000;

/** Outcome of asking the human to lend a tab. `timeout` is a DENY that says so. */
export type BorrowApprovalOutcome = 'approved' | 'denied' | 'timeout';

/** What main asks the human, for one tab. */
export interface BorrowApprovalRequest {
  workspaceId: string;
  /** Live target id of the tab being asked for. */
  surfaceId: string;
  /** Tab title as Chrome reports it (may be empty). */
  title: string;
  /** Origin of the tab's URL, or '' when it has none (about:blank). */
  origin: string;
}

export type BorrowApprovalRequester = (
  request: BorrowApprovalRequest,
) => Promise<BorrowApprovalOutcome>;
