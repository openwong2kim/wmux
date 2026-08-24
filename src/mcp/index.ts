#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendRpc, setClientIdentity, setCommanderRole } from './wmux-client';
import { COMMANDER_TOOL_SURFACE } from '../shared/commanderSurface';
import type { RpcMethod } from '../shared/rpc';
import {
  claimPinnedRoute,
  clearPinnedRoute,
  getPinnedRoute,
  type PinnedRoute,
} from './paneResolver';
import { resolveTerminalRoute, resolveCommanderRoute, type PidMapLookup } from './terminalRouting';
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
import { registerFanOutTools } from './fanout';
import { registerPaneLifecycleTools } from './paneLifecycle';
import { getWmuxMcpServerInstructions, resolveMcpServerVersion } from './serverMetadata';
import type { RegisterWmuxToolsOptions } from './toolCatalog';

/**
 * Everything a server instance needs that used to come from process globals.
 *
 * Single-child mode (src/mcp/entry.ts) fills this straight from its own
 * process env/argv/pid — behavior identical to the pre-factory module. The
 * broker (src/mcp/broker.ts) fills it from the shim's connect handshake, so
 * each hosted connection resolves identity as if it WERE the shim process:
 * the PID walk starts at the shim's pid (the shim sits in the agent's own
 * process tree, exactly where the old child sat).
 */
export interface WmuxServerCtx {
  /** WMUX_WORKSPACE_ID hint from the pane env (stale-able, weak). */
  envWorkspaceHint: string;
  /** WMUX_PTY_ID hint from the pane env (immutable but spoofable, weak). */
  envPtyHint: string;
  /** WMUX_COMMANDER_TOKEN (BYOB P4) — undefined for ordinary panes. */
  commanderToken: string | undefined;
  /** --commander surface filter flag (from argv / shim handshake). */
  commanderMode: boolean;
  /** The pid identity walks start from (self pid, or the shim's pid). */
  callerPid: number;
  /** That pid's parent when already known (process.ppid); null → resolve lazily. */
  callerPpid: number | null;
}

// The bounded default for terminal_read when the caller names no explicit cap.
// SSOT is the renderer's DEFAULT_READ_TAIL_LINES (src/renderer/utils/terminalTail.ts);
// mirrored here (the MCP bundle must not import renderer/xterm code) purely so
// the tool description states the real number. Keep the two in lockstep.
// Hoisted to module scope so the shapes below (and every server instance that
// shares them) can reference it.
const DEFAULT_READ_TAIL_LINES = 300;

// ── Module-scope tool parameter shapes ──────────────────────────────────────
// Hoisted out of the per-registration path (createWmuxServer) so that N broker
// server instances share ONE set of zod schema objects instead of re-allocating
// every leaf schema per connection. The shapes carry NO per-call state — every
// handler (which closes over ctx / the resolvers) stays inside the factory. The
// `<TOOLNAME>_SHAPE` naming mirrors the tool name 1:1. Tools whose param object
// is empty (`{}`) are left inline: an empty object holds no zod schema to share.
const BROWSER_OPEN_SHAPE = {
  url: z.string().optional().describe('Initial URL to load (defaults to google.com)'),
};

const BROWSER_CLOSE_SHAPE = {
  surfaceId: z.string().optional().describe('Target a specific surface by ID (searched across all workspaces). Omit to close the browser surface in the calling workspace.'),
};

const BROWSER_SESSION_START_SHAPE = {
  profile: z.string().optional().describe('Profile name to use (defaults to "default")'),
};

const TERMINAL_READ_SHAPE = {
  ptyId: z.string().optional().describe('Target a specific terminal by PTY ID. Omit to use the active terminal. Get PTY IDs from surface_list().'),
  tail_lines: z.number().int().positive().optional().describe(`Return only the last N lines. Omit for the default (${DEFAULT_READ_TAIL_LINES}). Read cost is O(N), so a small N is both cheaper and fewer tokens.`),
  full_scrollback: z.boolean().optional().describe('Return the ENTIRE terminal backlog (up to the scrollback limit, ~10k lines) instead of a bounded tail. Expensive — walks the whole buffer. Use only when the recent tail is genuinely insufficient.'),
};

const TERMINAL_READ_EVENTS_SHAPE = {
  ptyId: z.string().optional().describe('Target a specific terminal by PTY ID. Omit to use the active terminal.'),
  limit: z.number().int().positive().optional().describe('Return the N most recent events (default 32). Ignored when sinceOffset or lastCommandOnly is set.'),
  sinceOffset: z.number().int().nonnegative().optional().describe('Return only events whose byteOffset is strictly greater than this value — for diff-style polling.'),
  lastCommandOnly: z.boolean().optional().describe('Skip the events list and only return lastCompletedRange (the byte-offset range + exit code of the most recently finished command).'),
};

const TERMINAL_SEND_SHAPE = {
  text: z.string().describe('Text to send to the terminal'),
  ptyId: z.string().optional().describe('Target a specific terminal by PTY ID. Omit to use the active terminal. Get PTY IDs from surface_list().'),
  submit: z.boolean().optional().describe('When true, append a carriage return (\\r) after the text so it is committed — equivalent to pressing Enter. Use this for shell commands and TUI chat prompts (e.g. Claude Code, REPLs). Default: false (text is written as-is; you must call terminal_send_key({ key: "enter" }) separately to commit).'),
};

const TERMINAL_SEND_KEY_SHAPE = {
  key: z.string().describe(
    'Key name: enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, escape, up, down, right, left',
  ),
  ptyId: z.string().optional().describe('Target a specific terminal by PTY ID. Omit to use the active terminal. Get PTY IDs from surface_list().'),
};

const DECK_COMPLETE_WORK_SHAPE = {
  summary: z
    .string()
    .min(8)
    .describe('Concise final summary of the completed human request (at least 8 characters).'),
  verification: z
    .string()
    .min(12)
    .describe('Concrete verification performed and its outcome (at least 12 characters).'),
};

const DECK_ASK_DECISION_SHAPE = {
  question: z
    .string()
    .describe('The decision you need the human to make, in one clear sentence.'),
  options: z
    .array(z.string())
    .optional()
    .describe('Optional discrete choices, e.g. ["approach A", "approach B"]. Omit for a free-text answer.'),
  context: z
    .string()
    .optional()
    .describe('Optional short note on what is at stake or why you cannot decide yourself.'),
};

const DECK_RESOLVE_DECISION_SHAPE = {
  id: z
    .string()
    .describe('The id of the pending decision to resolve (shown in the STALE re-examine block).'),
  resolution: z
    .string()
    .describe('How the decision is settled — MUST state the binding rule / standing convention that resolves it. Not a bare "yes"/"done"; the server rejects an insubstantial answer.'),
};

const INCLUDE_STASHED_DESCRIBE =
  'Also list STASHED panes — out of the layout, still running. Rows carry `stashed`; '
  + 'stashed ones add `stashedLiveness` ("alive"|"exited").';

const SURFACE_LIST_SHAPE = {
  workspaceId: z.string().optional().describe("Target a specific workspace by ID. Omit to use your own (the caller's) workspace."),
  includeStashed: z.boolean().optional().describe(INCLUDE_STASHED_DESCRIBE),
};

const PANE_LIST_SHAPE = {
  workspaceId: z.string().optional().describe("Target a specific workspace by ID. Omit to use your own (the caller's) workspace."),
  includeStashed: z.boolean().optional().describe(INCLUDE_STASHED_DESCRIBE),
};

const PANE_SET_METADATA_SHAPE = {
  paneId: z.string().optional().describe('Target leaf pane id. Omit to use the active pane in the calling workspace.'),
  label: z.string().max(64).optional().describe('Short human label, e.g. "Backend".'),
  // P2: `role` is deprecated — pane identity is the auto name + user label now.
  // Removed from the input schema; any legacy role is read-only (dead-read).
  status: z.string().max(128).optional().describe('Current status, e.g. "running-tests".'),
  custom: z.record(z.string(), z.string()).optional().describe('Additional string→string properties for tool-specific data. Deep-merged with existing custom map when mergeMode="merge". Recommended convention: namespace your keys with a tool prefix (e.g. "orchestrator.taskId", "qa.status") to avoid semantic collisions with other cooperating tools.'),
  merge: z.boolean().optional().describe('Legacy v2.8.x flag; prefer mergeMode. true → merge, false → replace. When both `merge` and `mergeMode` are provided, `mergeMode` wins.'),
  mergeMode: z.enum(['merge', 'replace', 'replaceShared']).optional().describe('Explicit merge semantics (v2.9.0+). "merge" patches and deep-merges custom (default). "replace" wipes the metadata object and writes only the provided fields. "replaceShared" overwrites label/status but preserves another tool\'s custom keys. Overrides legacy `merge` boolean when both are provided.'),
  expectedVersion: z.number().int().nonnegative().optional().describe('Optimistic concurrency guard: if the current metadata version differs the call fails with VERSION_CONFLICT and does not mutate. Read the version from pane_get_metadata or pane_list; omit for unconditional writes. 0 is the guard for a never-written pane, succeeding only if no writer has set anything yet.'),
};

const PANE_GET_METADATA_SHAPE = {
  paneId: z.string().optional().describe('Target leaf pane id. Omit to use the active pane in the calling workspace.'),
  workspaceId: z.string().optional().describe('#1018 — read another workspace\'s pane metadata (READ-ONLY; pane_set_metadata has no equivalent and stays confined to the calling workspace). Pass the workspace id from a2a_discover / workspace_list along with paneId (from that same workspace\'s panes[]/a2a_discover panes[]). Omit to read the calling workspace, unchanged from before.'),
};

const WMUX_SEARCH_PANES_SHAPE = {
  query: z.string().min(1).describe('The text to search for. Required, non-empty. Treated as a literal substring unless regex=true.'),
  regex: z.boolean().optional().describe('If true, treat query as a JavaScript regex pattern (e.g. "ERROR|WARN", "\\\\bTODO\\\\b"). Default flags only — case-sensitive, no inline `(?i)`. Invalid pattern returns an error. Default false.'),
  searchTailLines: z.number().int().min(1).optional().describe('How many of the NEWEST scrollback lines to scan per pane. Default 5000; raise (capped at 20000) to search deeper history. A pane holding more lines than the window reports truncated=true.'),
};

/**
 * Slack added to a blocking poll's client-side RPC deadline.
 *
 * The client's clock starts when the call is made; main's `blockMs` budget does
 * not start until AFTER it has resolved the caller's scope and entitlements —
 * and scope resolution can cost a renderer round-trip. So this margin covers
 * two things, not one: that pre-park work, plus the wake → collect → serialize →
 * write that follows. Sized against a renderer that is slow rather than idle:
 * this repo has a MEASURED 120 s renderer freeze on the permission-gate path, so
 * anything under that turns a poll which answered correctly into a transport
 * error the agent reads as "wmux is broken" — the exact failure the margin
 * exists to prevent. Sized above the measurement rather than near it.
 *
 * Erring large is cheap here: this only applies to a call that is already
 * long-running by request, and the deadline is a backstop for a response that
 * IS coming, not a liveness check.
 */
const EVENTS_POLL_BLOCK_MARGIN_MS = 150_000;

const WMUX_EVENTS_POLL_SHAPE = {
  cursor: z.number().int().nonnegative().optional().describe('Last seen seq; 0 (default) replays the ring.'),
  types: z
    .array(z.enum([
      'pane.created',
      'pane.closed',
      'pane.focused',
      'pane.stashed',
      'pane.unstashed',
      'pane.metadata.changed',
      'workspace.metadata.changed',
      'process.started',
      'process.exited',
      'agent.lifecycle',
      'notification.received',
      'a2a.task',
    ]))
    .optional()
    .describe('Event-type filter; omit for all. `notification.received` — a terminal emitted OSC 9/777/99; carries ptyId, source, title, body. `agent.lifecycle` — carries ptyId, kind (agent.stop|agent.subagent_stop|agent.awaiting_input), source (hook|detector|osc133), agent, decision, and exitCode (osc133 only); fires when an inner agent ends a turn, surfaces a y/N prompt mid-turn, or an OSC 133 command completes. `a2a.task` — carries taskId, from, to, kind, state, messagePreview, plus verifiedItemCount on completed/failed (0 = unverified). A POINTER, not the payload: fetch the body with a2a_task_query. DUAL-PARTY — visible to both the sending and receiving workspace, unlike every other type (caller-scoped); an unscoped poll receives zero a2a.task events.'),
  max: z.number().int().positive().max(1024).optional().describe('Max events per poll (default 256).'),
  blockMs: z.number().int().nonnegative().max(600_000).optional().describe('Wait this long (ms) for a match instead of returning an empty page; 0 (default) = immediate. With ptyId+kinds it replaces a terminal_read loop waiting for a pane to block. Add process.exited to types so the wait ends if the pane dies (pane.closed is paneId-keyed, so ptyId drops it). parkedCapReached=true means it did NOT wait; back off. Use one cursor chain per filter combination — nextCursor passes events your filter skipped.'),
  ptyId: z.string().optional().describe('Only events about this pane. Events without a ptyId are excluded, which is every pane.* event (paneId-keyed); use process.exited to see the pane go away.'),
  kinds: z.array(z.string()).optional().describe('Narrow agent.lifecycle by kind; other types pass through. agent.subagent_stop is a nested subagent returning, not the pane\'s own turn ending.'),
};

const A2A_TASK_QUERY_SHAPE = {
  status: z.enum(['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled']).optional().describe('Filter by task status'),
  role: z.enum(['user', 'agent']).optional().describe('Filter: "user" = tasks you sent, "agent" = tasks assigned to you'),
  updated_since: z.string().optional().describe('ISO-8601 timestamp; return only tasks whose metadata.updatedAt is strictly later (incremental cursor for polling).'),
};

const A2A_TASK_UPDATE_SHAPE = {
  task_id: z.string().describe('Task ID to update'),
  status: z
    .enum(['working', 'completed', 'failed', 'input-required'])
    .describe('New status. Allowed transitions: submitted->working; working->completed|failed|input-required; input-required->working. A fresh (submitted) task must go to working before it can complete.'),
  message: z.string().optional().describe('Optional status message'),
  artifact_name: z.string().optional().describe('Artifact name (for completed tasks)'),
  artifact_data: z.record(z.string(), z.unknown()).optional().describe('Artifact data payload'),
  evidence: z
    .object({
      summary: z.string().describe('Required, non-empty. For completed: the completion summary. For failed: the failure reason.'),
      // kind별 discriminated union — normalize 계약과 1:1 (command는 command 필수 +
      // passed|failed, inspection/artifact는 verified|unverified). zod가 통과시킨
      // 아이템이 normalize에서 malformed로 죽는 조합을 스키마 단계에서 제거한다.
      items: z
        .array(
          z.discriminatedUnion('kind', [
            z.object({
              kind: z.literal('command'),
              status: z.enum(['passed', 'failed']),
              summary: z.string(),
              command: z.string().describe('What was run.'),
              output: z.string().optional(),
            }),
            z.object({
              kind: z.literal('inspection'),
              status: z.enum(['verified', 'unverified']),
              summary: z.string(),
              location: z.string().optional(),
              output: z.string().optional(),
            }),
            z.object({
              kind: z.literal('artifact'),
              status: z.enum(['verified', 'unverified']),
              summary: z.string(),
              location: z.string().optional(),
              output: z.string().optional(),
            }),
          ]),
        )
        .optional()
        .describe('completed requires >=1 well-formed item; failed may omit (summary alone is a valid failure report).'),
      files: z.array(z.string()).optional().describe('Repository-relative paths only.'),
    })
    .optional()
    .describe('Completion evidence. Required for completed (summary + >=1 item: command|inspection|artifact) and for failed (summary = the failure reason). Grading and reason codes: see the tool description.'),
};

const A2A_TASK_CANCEL_SHAPE = {
  task_id: z.string().describe('Task ID to cancel'),
  reason: z.string().optional().describe('Cancellation reason'),
};

const A2A_BROADCAST_SHAPE = {
  message: z.string().describe('Broadcast message'),
  priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority level'),
};

const A2A_SET_SKILLS_SHAPE = {
  skills: z.array(z.string()).describe('List of skill tags (e.g., ["frontend", "testing", "devops"])'),
  description: z.string().optional().describe('Short description of what this agent does'),
};

const COMPANY_A2A_SEND_SHAPE = {
  to: z.string().describe('Target agent name, department name, or "CEO"'),
  message: z.string().describe('Message content'),
  priority: z.enum(['low', 'normal', 'high']).optional().describe('Message priority (default: normal)'),
};

const COMPANY_A2A_BROADCAST_SHAPE = {
  message: z.string().describe('Broadcast message content'),
  priority: z.enum(['low', 'normal', 'high']).optional().describe('Message priority'),
};

const COMPANY_A2A_INBOX_SHAPE = {
  unread_only: z.boolean().optional().describe('Only return unread messages (default: true)'),
};

const COMPANY_A2A_ACK_SHAPE = {
  message_ids: z.array(z.string()).describe('Array of message IDs to acknowledge'),
};

// send_message / a2a_task_send share this shape (identical param contract).
const SEND_MESSAGE_SHAPE = {
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

export function createWmuxServer(ctx: WmuxServerCtx): McpServer {
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
const ENV_WORKSPACE_HINT = ctx.envWorkspaceHint;
// Our OWN pane anchor from the spawn env (WMUX_PTY_ID). UNLIKE the workspace
// hint, the ptyId is immutable for the pane's lifetime — it is never re-minted
// by a daemon respawn / session restore — so it is a safe WEAK fallback for
// senderPtyId when the verified PID-map walk misses (the common Windows case,
// where the per-hop PowerShell process-tree walk is slow/flaky). It rides the
// same spoofable env channel as WMUX_WORKSPACE_ID, though, so a same-user
// process could forge it; see getTaskSenderPtyId for where this weak value is
// (and is NOT) trusted. Empty when the agent launcher didn't propagate the env
// to this MCP child — the case the diagnostic logging below exists to surface.
const ENV_PTY_HINT = ctx.envPtyHint;
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
  version: resolveMcpServerVersion(),
}, {
  instructions: getWmuxMcpServerInstructions(ctx.commanderMode),
});

// ── BYOB P4 Layer 1: commander tool-surface filter ──────────────────────────
// `--commander` on the command line (NOT an env var — the brain adapter
// declares it in the MCP server config args, so an env-stripping brain host
// cannot silently widen the surface; arg and token fail independently)
// switches this process to the commander surface: only the tools in
// COMMANDER_TOOL_SURFACE register, so a brain's tools/list simply does not
// contain pane_close / surface_close / browser_* / company_* — unregistered
// tools cannot be called by ANY brain runtime (SDK, ACP, gateway). Ordinary
// pane agents (no arg) keep the full surface, unchanged.
const COMMANDER_MODE = ctx.commanderMode;
const MCP_CATALOG_OPTIONS: RegisterWmuxToolsOptions = Object.freeze({
  profile: COMMANDER_MODE ? 'commander' : 'full',
  context: Object.freeze({
    // clientInfo is self-declared telemetry. Catalog invocation remains
    // explicitly powerless until an authenticated transport principal exists.
    principal: Object.freeze({ kind: 'unattributed' as const }),
  }),
});
if (COMMANDER_MODE) {
  // Layer 2 pairing: every outbound RPC from a commander-mode child carries
  // the per-spawn token as a role CLAIM — the router validates it and fails
  // the request closed when it is missing/stale, so a commander child whose
  // token env was lost degrades to "no fleet hands at all", never to an
  // ordinary external caller with the wider surface.
  setCommanderRole(ctx.commanderToken ?? '');
  const surface = new Set(COMMANDER_TOOL_SURFACE);
  const registerTool = server.tool.bind(server);
  // Transitional gate for legacy server.tool() registration sites. Domains
  // migrated to WmuxToolSpec use their immutable profile instead; invariant
  // tests keep those profile entries equal to COMMANDER_TOOL_SURFACE until the
  // catalog owns all tools and this monkey-patch can be removed.
  (server as { tool: typeof server.tool }).tool = ((name: string, ...rest: unknown[]) => {
    if (!surface.has(name)) {
      // Skipped registration — return a inert handle-shaped object for the
      // few call sites that keep the return value.
      return undefined as unknown as ReturnType<typeof registerTool>;
    }
    return (registerTool as (...a: unknown[]) => ReturnType<typeof registerTool>)(name, ...rest);
  }) as typeof server.tool;
}

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
  timeoutMs?: number,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const pinnedRouteAtDispatch = getPinnedRoute();
  try {
    const result = timeoutMs === undefined
      ? await sendRpc(method, params)
      : await sendRpc(method, params, timeoutMs);
    if (isStaleIdentityResult(result)) invalidateStaleRoute(pinnedRouteAtDispatch);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (isStaleIdentityResult(err instanceof Error ? err.message : String(err))) {
      invalidateStaleRoute(pinnedRouteAtDispatch);
    }
    throw err;
  }
}

/**
 * Drop every cached coordinate that can keep an RPC on a re-minted route.
 *
 * First-party callers use the verified workspace cache. External callers use
 * paneResolver's process/connection-local claim instead, so clearing only the
 * former leaves them pinned to a deleted PTY until the MCP server restarts.
 */
function invalidateStaleRoute(pinnedRouteAtDispatch: PinnedRoute | null): void {
  invalidateWorkspaceId();
  clearPinnedRoute(pinnedRouteAtDispatch);
}

/**
 * Append an advisory line to a tool result.
 *
 * Used where a bare success would be read as a stronger guarantee than the RPC
 * actually makes — delivery vs. effect. The note rides as its own content block
 * so the primary JSON payload stays machine-parseable.
 */
function withNote(
  result: { content: { type: 'text'; text: string }[] },
  note: string,
): { content: { type: 'text'; text: string }[] } {
  return { content: [...result.content, { type: 'text', text: `NOTE: ${note}` }] };
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
    const result = await sendRpc('a2a.resolve.identity' as RpcMethod, { callerPid: ctx.callerPid });
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

  // Walk process tree upward: MCP server (or its shim) → Claude Code →
  // shell(PTY). The walk queries the OS process table by pid, so it works
  // identically whether we run inside the agent's tree (single child) or in
  // the broker (which starts from the shim's pid asserted at connect).
  let currentPid = ctx.callerPpid ?? (await getParentPid(ctx.callerPid)) ?? -1;
  let depth = 0;
  for (; depth < 10 && currentPid > 1; depth++) {
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
/**
 * Commander-brain self-identity: token → the home workspace main bound it to.
 * Returns '' for a non-commander caller (no token) or a stale/rejected token,
 * so the caller falls through to the ordinary resolution paths. See the call
 * site in resolveWorkspaceId for the full rationale.
 */
async function resolveCommanderWorkspaceId(): Promise<string> {
  const token = ctx.commanderToken;
  if (!token) return '';
  try {
    const result = await sendRpc('deck.resolveCommanderWorkspace' as RpcMethod, { token });
    const wsId =
      result && typeof result === 'object' && 'workspaceId' in result
        ? (result as Record<string, unknown>)['workspaceId']
        : undefined;
    return typeof wsId === 'string' && wsId.length > 0 ? wsId : '';
  } catch {
    return '';
  }
}

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

  // Commander brain: the subprocess main spawns for a workspace's orchestrator
  // has no pane ancestry (the PID-map walk above always misses) and no
  // WMUX_WORKSPACE_ID env hint — main injects a per-spawn WMUX_COMMANDER_TOKEN
  // instead. Ask main for the home workspace the token is bound to, so the
  // brain has an A2A sender identity (send_message / a2a_task_send / broadcast)
  // rather than throwing "Workspace identity unknown" on every A2A call. The
  // token is main-minted and only ever in main's in-memory trust registry, so
  // it cannot be spoofed; a missing/stale token yields '' and we fall through
  // to the ordinary paths, leaving non-commander callers unaffected. Cached
  // like a walk hit — a brain's home workspace is fixed for its process life.
  // (MY_PTY_ID stays empty: the brain has no PTY. A2A sender-pane attribution
  // for the commander is a separate follow-up.)
  const commanderWs = await resolveCommanderWorkspaceId();
  if (commanderWs) {
    MY_WORKSPACE_ID = commanderWs;
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
async function resolveTerminalRouteBound(explicitPtyId?: string) {
  // Commander brain (P3b): a live WMUX_COMMANDER_TOKEN grants fleet-wide
  // explicit-ptyId targeting via main's deck.resolvePaneRoute — the brain's
  // subprocess has no pane ancestry, so the ordinary rules below would
  // confine it to its claimed workspace. Falls through on any failure.
  const commanderRoute = await resolveCommanderRoute({
    token: ctx.commanderToken,
    explicitPtyId,
    sendRpc: (method, params) => sendRpc(method as RpcMethod, params),
  });
  if (commanderRoute) return commanderRoute;

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
  BROWSER_OPEN_SHAPE,
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
  BROWSER_CLOSE_SHAPE,
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
const browserToolDeps = { resolveWorkspaceId: requireWorkspaceId };
registerNavigationTools(server, browserToolDeps);
registerInteractionTools(server, browserToolDeps);
registerInspectionTools(server, browserToolDeps);
registerStateTools(server, browserToolDeps);
registerWaitTools(server, browserToolDeps, MCP_CATALOG_OPTIONS);
registerFileTools(server, browserToolDeps);
registerUtilityTools(server, browserToolDeps);
registerExtractionTools(server, browserToolDeps);

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
  BROWSER_SESSION_START_SHAPE,
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
  `Read the recent text from a terminal. By default returns the last ${DEFAULT_READ_TAIL_LINES} lines of output — the recent screen plus a little history, which is what you want for observing an agent's latest turn. Omit ptyId to read the active terminal. Reading is intentionally bounded and cheap; escalate on purpose when the default is not enough to judge what happened: pass a larger tail_lines (e.g. 800) to widen the window, or full_scrollback:true as a last resort to pull the ENTIRE backlog (far more expensive — avoid by reflex). Read cost scales with the number of lines returned. For structured command boundaries / exit codes, use terminal_read_events instead.`,
  TERMINAL_READ_SHAPE,
  async ({ ptyId, tail_lines, full_scrollback }) => {
    const route = await resolveTerminalRouteBound(ptyId);
    const params: Record<string, unknown> = { workspaceId: route.workspaceId };
    if (route.ptyId) params.ptyId = route.ptyId;
    if (tail_lines !== undefined) params.tail_lines = tail_lines;
    if (full_scrollback) params.full_scrollback = true;
    return callRpc('input.readScreen', params);
  },
);

server.tool(
  'terminal_read_events',
  'Return structured OSC 133 prompt/command events (prompt_start, prompt_end, command_start, command_end with exit code) from a terminal. Requires shell integration — wmux auto-injects for pwsh and bash; cmd.exe is unsupported. Use this instead of terminal_read when you need command boundaries, exit codes, or byte offsets for diff-style reads.',
  TERMINAL_READ_EVENTS_SHAPE,
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
  TERMINAL_SEND_SHAPE,
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
  'Send a named key to a terminal. Omit ptyId to target the active terminal. Use surface_list() to discover available PTY IDs. NOT A SUBMIT MECHANISM: `key:"enter"` presses Enter on whatever the terminal actually holds, which is usually NOTHING — a question or suggestion an agent PRINTED is rendered text, not text sitting in its input box, so Enter submits nothing and the pane stays blocked on the same prompt. This call returns ok as long as the key was delivered; ok does NOT mean anything was submitted or that the agent started working. To answer an agent that is waiting on you, send the answer explicitly with terminal_send({ text, submit: true }) and confirm the pane moved (agentStatus, or a fresh terminal_read) before reporting progress. Reserve this tool for real key presses: ctrl+c, escape, arrow keys, and y/N approval prompts the agent genuinely rendered.',
  TERMINAL_SEND_KEY_SHAPE,
  async ({ key, ptyId }) => {
    const route = await resolveTerminalRouteBound(ptyId);
    const params: Record<string, unknown> = { key, workspaceId: route.workspaceId };
    if (route.ptyId) params.ptyId = route.ptyId;
    // See terminal_send: forward our ptyId (verified hit, else weak WMUX_PTY_ID
    // env hint — WI-002) so main can reject an omitted-ptyId key send from an
    // agent (self-loop / sibling misroute).
    const senderPtyId = getTaskSenderPtyId();
    if (senderPtyId) params.senderPtyId = senderPtyId;
    const result = await callRpc('input.sendKey', params);
    // Say plainly what `ok` covers. The RPC confirms DELIVERY of a keystroke and
    // nothing more, but callers read a bare `{ok:true}` from an Enter press as
    // "submitted, the agent is running now" — orchestrators have reported panes
    // as working while they sat blocked on an unanswered question. There is no
    // reliable signal here to promote delivery into submission, so the honest
    // answer is to name the gap rather than imply a guarantee.
    if (key.toLowerCase() === 'enter') {
      return withNote(
        result,
        'Enter was delivered. This does NOT confirm anything was submitted: if the pane was '
        + 'showing a question the agent printed (rather than text typed into its input box), '
        + 'nothing happened and it is still waiting. Verify with terminal_read or pane_list '
        + 'before reporting progress; to answer an agent, use terminal_send({text, submit:true}).',
      );
    }
    return result;
  },
);

// === Orchestrator (Command Deck) tools ===

server.tool(
  'deck_complete_work',
  'Finalize the current human-request work only after every delegated pane and A2A task has completed and you have verified the result. The server rejects this call while a worker is still running or awaiting input, when a tracked A2A task is not canonically completed, or when the summary/verification is insubstantial. Call this immediately before your final answer to the human; a successful call closes the durable active-work lease and stops follow-up wakes.',
  DECK_COMPLETE_WORK_SHAPE,
  async ({ summary, verification }) => callRpc('deck.completeWork', {
    token: ctx.commanderToken,
    summary,
    verification,
  }),
);

server.tool(
  'deck_ask_decision',
  'Pause your working loop and ask the human operator to make a decision you should NOT make yourself — an ambiguous requirement, a risky or irreversible action, or a genuine choice between approaches. Before calling this, check the binding policy rules / standing conventions / your memory — if one settles the question, act on it instead of asking; a question whose answer you can already cite is NOT a decision for the human. Your loop STOPS and will not auto-advance until the human answers; the pending decision survives an app restart or reboot, so the human can answer later and you will resume from here. After calling this, END YOUR TURN and do not act further. Use only for real forks — never for routine progress updates or questions you can resolve yourself.',
  DECK_ASK_DECISION_SHAPE,
  async ({ question, options, context }) => {
    // Only the commander brain has WMUX_COMMANDER_TOKEN; a non-commander caller
    // sends an undefined token and the RPC fail-closes ("not a live commander").
    const params: Record<string, unknown> = {
      token: ctx.commanderToken,
      question,
    };
    if (options && options.length > 0) params.options = options;
    if (context) params.context = context;
    return callRpc('deck.requestDecision', params);
  },
);

server.tool(
  'deck_resolve_decision',
  'Resolve YOUR OWN stale pending decision — the one you raised with deck_ask_decision that has now blocked your loop past its TTL with no human answer. ONLY call this when the STALE re-examine prompt has told you a decision went unanswered AND a BINDING policy rule or standing convention actually settles the question: pass the decision id and a resolution that STATES that rule/basis, then act on it. This is NOT a way to unblock yourself by inventing an answer — the server enforces every condition and refuses the call unless your workspace is in AUTO mode, the decision is genuinely stale (not one you just raised), and the resolution is substantive. If nothing settles it, do not call this: re-raise a sharper question with deck_ask_decision or keep waiting.',
  DECK_RESOLVE_DECISION_SHAPE,
  async ({ id, resolution }) => {
    // Only the commander brain has WMUX_COMMANDER_TOKEN; a non-commander caller
    // sends an undefined token and the RPC fail-closes ("not a live commander").
    return callRpc('deck.resolveDecision', {
      token: ctx.commanderToken,
      id,
      resolution,
    });
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
  SURFACE_LIST_SHAPE,
  async ({ workspaceId, includeStashed }) => {
    // Scope to the CALLER's own workspace when omitted, not the GUI-focused one
    // (the a2a_whoami-vs-surface_list divergence). resolveScopedReadWorkspaceId
    // is fail-soft (returns '' on identity miss, never throws — unlike a write
    // tool, a read must not hard-fail), revalidates a stale cached id, and
    // prefers an external caller's pin (#243); an empty resolution falls back to
    // the renderer's active-ws default, preserving the old behavior.
    const resolved = workspaceId || (await resolveScopedReadWorkspaceId());
    return callRpc('surface.list', {
      ...(resolved ? { workspaceId: resolved } : {}),
      ...(includeStashed !== undefined ? { includeStashed } : {}),
    });
  },
);

server.tool(
  'pane_list',
  'List all panes in a workspace with CWD, git branch, and metadata. Omit workspaceId to list your own workspace.',
  PANE_LIST_SHAPE,
  async ({ workspaceId, includeStashed }) => {
    // Caller-scoped when omitted (see surface_list) — fail-soft via
    // resolveScopedReadWorkspaceId so a read never throws on identity miss.
    const resolved = workspaceId || (await resolveScopedReadWorkspaceId());
    return callRpc('pane.list', {
      ...(resolved ? { workspaceId: resolved } : {}),
      ...(includeStashed !== undefined ? { includeStashed } : {}),
    });
  },
);

server.tool(
  'pane_set_metadata',
  'Attach descriptive metadata (label/status + custom k/v) to a leaf pane in the calling workspace. The custom map is deep-merged when mergeMode="merge" (the default), so cooperating tools can each write their own keys without clobbering. Use mergeMode="replace" to overwrite the entire metadata object, or "replaceShared" (v2.9.0+) to overwrite label/status while preserving another tool\'s custom keys verbatim. Pass expectedVersion (v2.9.0+) for optimistic concurrency — the call fails with VERSION_CONFLICT if the pane has been updated since you last read it. Omit paneId to target the active pane in the calling workspace.',
  PANE_SET_METADATA_SHAPE,
  async ({ paneId, label, status, custom, merge, mergeMode, expectedVersion }) => {
    const workspaceId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId };
    if (paneId !== undefined) params['paneId'] = paneId;
    if (label !== undefined) params['label'] = label;
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
  'Read the metadata attached to a leaf pane. Defaults to the calling workspace; pass workspaceId (#1018) to READ another workspace\'s pane metadata instead — this tool is read-only, so that cross-workspace reach never extends to pane_set_metadata. Returns { paneId, metadata, version }. A version of 0 means no metadata has ever been written for this pane (the "never written" sentinel — pair with expectedVersion: 0 on pane_set_metadata to claim a fresh pane atomically).',
  PANE_GET_METADATA_SHAPE,
  async ({ paneId, workspaceId: targetWorkspaceId }) => {
    // #1018 — an explicit workspaceId reads that workspace's pane instead of
    // the caller's own. requireWorkspaceId() still runs first: pane.rpc's
    // resolveTarget accepts any workspaceId already (it only checks that
    // paneId belongs to it), so the ONLY thing gating cross-workspace reads
    // before this change was this tool always forcing its own id here. Read
    // path only — pane_set_metadata takes no such override.
    const workspaceId = targetWorkspaceId || (await requireWorkspaceId());
    const params: Record<string, unknown> = { workspaceId };
    if (paneId !== undefined) params['paneId'] = paneId;
    return callRpc('pane.getMetadata', params);
  },
);

server.tool(
  'wmux_search_panes',
  'Search across all live terminal panes in the caller\'s workspace. Returns up to 200 matches with paneId + matched line + 2-line context (truncated=true means more were found). Use to find which pane has the JWT error, failing test, or build warning instead of polling each pane individually. Live panes only (v1); regex uses JS RegExp with default flags (case-sensitive, no inline `(?i)` — use `[Ee]rror` for case-insensitive).',
  WMUX_SEARCH_PANES_SHAPE,
  async ({ query, regex, searchTailLines }) => {
    const workspaceId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId, query };
    if (regex !== undefined) params.regex = regex;
    if (searchTailLines !== undefined) params.searchTailLines = searchTailLines;
    return callRpc('pane.search', params);
  },
);

server.tool(
  'wmux_events_poll',
  'Poll the wmux EventBus for pane, process, agent, notification, and A2A task lifecycle events. Cursor-based: pass `cursor` = the last `seq` you saw (start with 0 to replay from oldest in the ring). Returns { events, nextCursor, resync? }. `resync: true` means your cursor drifted past the in-memory ring (1024 events) and you should reconcile via pane_list. Events are auto-scoped to the calling workspace — EXCEPT `a2a.task`, which is dual-party (visible to both the sending and receiving workspace; see the `types` field for details).',
  WMUX_EVENTS_POLL_SHAPE,
  async ({ cursor, types, max, blockMs, ptyId, kinds }) => {
    const workspaceId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId };
    // Forward our OWN PID-walked senderPtyId so the main-side events.poll handler
    // can server-resolve this agent's workspace and scope the PRIVATE event types
    // (a2a.task, channel.*) to it — the caller-supplied `workspaceId` above is
    // self-asserted and no longer gates those over the wire (audit B3). Same
    // anchor a2a_whoami / a2a.task.send thread; whenever requireWorkspaceId()
    // resolves at all, getTaskSenderPtyId() is non-empty too (a PID-map-walk hit
    // sets MY_PTY_ID, and the env-hint fallback rides the same WMUX_* channel as
    // WMUX_WORKSPACE_ID), so a legitimately-placed agent never loses its own
    // private events. Absent ⇒ private types fail closed; lifecycle events still
    // flow (they honor the workspaceId scope).
    const senderPtyId = getTaskSenderPtyId();
    if (senderPtyId) params.senderPtyId = senderPtyId;
    if (cursor !== undefined) params['cursor'] = cursor;
    if (types !== undefined) params['types'] = types;
    if (max !== undefined) params['max'] = max;
    if (ptyId !== undefined) params['ptyId'] = ptyId;
    if (kinds !== undefined) params['kinds'] = kinds;
    // A blocking poll parks in main for up to `blockMs`, which is longer than
    // the default per-call RPC deadline — so raise the deadline for THIS call
    // only (sendRpc takes it per call; every other tool keeps the default).
    // The margin covers main's own wake + collect + write; without it the
    // client would time out just as the answer was being produced, and the
    // caller would see a transport error instead of an empty page.
    if (blockMs !== undefined && blockMs > 0) {
      params['blockMs'] = blockMs;
      return callRpc('events.poll', params, blockMs + EVENTS_POLL_BLOCK_MARGIN_MS);
    }
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
  'List all available workspaces/agents and their names. ALWAYS call this first when the user references a workspace by number or name (e.g. "3번", "Workspace 1") so you know valid targets. Each entry in agents[].panes carries paneTitle (the pane\'s own title, e.g. a task name — null when untitled) alongside the generic agentName, so a workspace running several same-vendor sessions (e.g. multiple "Claude Code" panes) can still be told apart before addressing one with send_message/a2a_task_send.',
  {},
  async () => {
    // elapsedMs: measured at the MCP tool entry, i.e. the caller-visible round
    // trip through pipe + main + renderer. A dogfood report blamed a ~2865s
    // stall on this call; the server side is bounded by a 5s bridge timeout
    // (_bridge.ts) and the handler is a pure in-memory map, so any large number
    // a client observes accrues OUTSIDE this span (its own queueing/harness).
    // Stamping the span here lets the next report tell those apart.
    const t0 = Date.now();
    const res = await callRpc('a2a.discover');
    const elapsedMs = Date.now() - t0;
    // callRpc returns the MCP content envelope; the RPC payload is JSON text
    // inside it. Re-stringify with elapsedMs appended; a non-JSON payload
    // (error string) passes through untouched.
    const text = res.content[0]?.text;
    if (typeof text === 'string') {
      try {
        const parsed: unknown = JSON.parse(text);
        // Leave error payloads untouched — appending elapsedMs would mutate the
        // error object shape callers match on.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('error' in parsed)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ ...(parsed as Record<string, unknown>), elapsedMs }, null, 2),
            }],
          };
        }
      } catch { /* non-JSON payload — return unmodified */ }
    }
    return res;
  },
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

server.tool(
  'send_message',
  'Send a message to another workspace. Use when asked to talk to, greet, or send anything to workspace 1/2/3 etc. Accepts number ("1", "3번"), name ("Workspace 2"), or ID. This is the delivery that STARTS an idle agent\'s turn — the receiver gets a one-line nudge pasted into its prompt (unless silent:true). Use it, not channel_post, when you are handing out work: a channel post only raises an unread badge and waits to be polled.',
  SEND_MESSAGE_SHAPE,
  sendMessageHandler,
);

// Keep a2a_task_send as alias for backward compatibility
server.tool(
  'a2a_task_send',
  'Alias for send_message. This is how you hand work to another agent: the task is pasted into the receiver\'s prompt and starts its turn. A channel post does not — it is a notification an idle agent will only see when it polls.',
  SEND_MESSAGE_SHAPE,
  sendMessageHandler,
);

// 4. a2a_task_query — Query tasks by status/role
server.tool(
  'a2a_task_query',
  'Query tasks assigned to you or sent by you. Filter by status and role. For incremental polling, pass updated_since (an ISO-8601 timestamp, e.g. a previous result\'s metadata.updatedAt) to get only tasks changed after that instant — cheaper than re-pulling the whole list each poll.',
  A2A_TASK_QUERY_SHAPE,
  async ({ status, role, updated_since }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.task.query', { workspaceId: wsId, status, role, updatedSince: updated_since });
  },
);

// 5. a2a_task_update — Update task status
server.tool(
  'a2a_task_update',
  'Update a task\'s status. Only the receiver workspace can change it. Transitions follow a state machine — you cannot jump straight from submitted to completed: take submitted -> working FIRST, then working -> completed/failed/input-required. Terminal states (completed/failed/canceled) are final and reject any further update (no resurrection). A rejected transition returns an error listing the allowed next states. Optionally attach artifacts on completion. status:"completed" requires evidence (enforced by a completion-evidence gate): summary + >=1 item (command|inspection|artifact). status:"failed" requires evidence.summary (the failure reason). A verified item is command+passed or inspection/artifact+verified; when zero, the completion is still accepted but reported at an unverified grade (verifiedItemCount=0). Rejections come back as completion_evidence_* reason codes (failed without a reason: failure_reason_missing).',
  A2A_TASK_UPDATE_SHAPE,
  async ({ task_id, status, message, artifact_name, artifact_data, evidence }) => {
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
    // 완료증거는 artifact_name/artifact_data(A2A-spec 산출물 채널)와 병존하는 별도
    // wmux 완료계약 채널 — 권위 정규화·검증은 렌더러/데몬이 수행(여긴 통과만).
    if (evidence) params.evidence = evidence;
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
  A2A_TASK_CANCEL_SHAPE,
  async ({ task_id, reason }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.task.cancel', { workspaceId: wsId, taskId: task_id, reason });
  },
);

// 7. a2a_broadcast — Broadcast notification to all workspaces
server.tool(
  'a2a_broadcast',
  'Send a message to ALL other workspaces at once (e.g. announcements, greetings). For targeted messages, use a2a_task_send instead.',
  A2A_BROADCAST_SHAPE,
  async ({ message, priority }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.broadcast', { message, priority: priority || 'normal', workspaceId: wsId });
  },
);

// 8. a2a_set_skills — Register agent capabilities
server.tool(
  'a2a_set_skills',
  'Register your agent capabilities/skills so other agents can discover you via a2a_discover.',
  A2A_SET_SKILLS_SHAPE,
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
  COMPANY_A2A_SEND_SHAPE,
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
  COMPANY_A2A_BROADCAST_SHAPE,
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
  COMPANY_A2A_INBOX_SHAPE,
  async ({ unread_only }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.inbox', { workspaceId: wsId, unreadOnly: unread_only !== false });
  },
);

server.tool(
  'company_a2a_ack',
  'Company mode: acknowledge (mark as read) inbox messages by their IDs.',
  COMPANY_A2A_ACK_SHAPE,
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
// Ten channel tools plus three WorkTask mission tools expose the
// a2a.channel.* / task.mission.* pipe surfaces. `channel_history` stays absent:
// bounded history is already exposed by channel_read.
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
registerChannelTools(
  server,
  {
    resolveWorkspaceId: requireWorkspaceId,
    getSenderPtyId: () => MY_PTY_ID,
  },
  MCP_CATALOG_OPTIONS,
);

// === Fan-out tool (J1 on the wire) ===
// Same provenance rule as the channel tools above, and for the same reason:
// task.fanout.start derives the caller's workspace AND repository from this
// ptyId, so it MUST stay MY_PTY_ID (walk-hit only). Feeding the weak
// WMUX_PTY_ID env hint here would let a spoofable env var choose which
// workspace's repository gets N new worktrees. No hit → fan-out fails closed.
// `resolveWorkspaceId` is passed for the same reason the channel tools get it:
// the walked ptyId is a SIDE EFFECT of that lookup, so a tool that only reads
// MY_PTY_ID sees '' until something has asked who the caller is. Every channel
// tool asks; fan-out did not, which made it fail as the first tool called on a
// fresh server. The resolved id is used only to warm the walk — the handler
// derives the owning workspace from the ptyId and rejects a stated one.
registerFanOutTools(server, {
  getSenderPtyId: () => MY_PTY_ID,
  resolveWorkspaceId: requireWorkspaceId,
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
registerPaneLifecycleTools(
  server,
  {
    callRpc,
    resolveCallerWorkspaceId: resolveScopedReadWorkspaceId,
  },
  MCP_CATALOG_OPTIONS,
);

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

wireClientIdentityHook();

return server;
}

// The stdio entry (single child per agent) lives in src/mcp/entry.ts — this
// module deliberately has NO import-time side effects so the broker can
// import createWmuxServer without booting a stdio transport.
