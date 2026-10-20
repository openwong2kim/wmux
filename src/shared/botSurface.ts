// ─── The bot surface — the whole power of every bot ────────────────────────
//
// A bot is defined by what it can call, never by what its prompt forbids.
// Every bot holds one shared set of wmux MCP tools (what the bundled server
// registers in bot mode, src/mcp/index.ts) and the pipe RPC methods those
// tools invoke (what RpcRouter lets a bot token reach). RpcRouter refuses any
// other method for a bot token before permission enforcement runs, in every
// enforcement mode; PermissionEnforcer allows exactly this set for a bot.
// The role tag on the token is a label and grants nothing.
//
// The surface: read the repository and its PRs, issues and CI; start workers
// (every bot preset — a bot's "computer" is its workers); post and read its
// room; hand work to or message any bot in any workspace; ask the owner (with
// choices); keep its own routines and job; stop its own work; record a review
// verdict (evidence, not a merge right); ask the owner for approval of an
// irreversible or public act; ask for a secret or a login by name. Main
// scopes every call on the caller's binding: a bot reads its own workspace,
// and only a Coordinator-template bot may name another workspace on the
// reads listed in COORDINATOR_READ_EXTENSION.
//
// No bot holds a shell, terminal input, pane/surface/workspace teardown, the
// browser or computer use: code is written only by fan-out workers in their
// own worktrees. No bot parks another bot (`bot_park` is on no surface). The
// fleet-wide pane and event reads (pane_list, fleet_triage, wmux_events_poll,
// a2a_task_query) are on no surface either: every read a bot holds is scoped
// to its binding, and a bot sees its workers through their ledger rows and
// terminal_read.

import type { RpcMethod } from './rpc';
import type { BotBinding, BotRole } from './bot';
import { BOT_RPC, isBotRole } from './bot';
import { FACT_RPC } from './facts';
import { ASK_PERSON_RPC, HANDOFF_RPC } from './handoff';
import { ROOM_RPC } from './room';
import { COMMANDER_TEARDOWN_DENY } from './commanderSurface';
import { BOT_APPROVAL_RPC } from './botApproval';
import { BOT_SECRET_RPC } from './botSecret';
import { ROUTINE_RPC } from './botRoutine';
import { WORKFLOW_RPC } from './botWorkflow';
import { BOT_SKILL_RPC } from './botSkill';

/** Read-side factory RPCs behind the role tools (handlers: main/factory/roles). */
export const FACTORY_READ_RPC = {
  prRead: 'pr.read',
  issueRead: 'issue.read',
  ciRead: 'ci.read',
  verdictRead: 'verdict.read',
  trustMetricsRead: 'trustMetrics.read',
} as const;

/** A plan card (handler: main/factory/roles). Items in other workspaces: Coordinator only. */
export const PLAN_RPC = { propose: 'plan.propose' } as const;

/** Every RPC method the factory adds. Each one is registered in main by
 *  `registerFactoryRpc` (main/factory/factoryHost.ts) with a fail-closed
 *  `not_implemented` handler until the work package that owns it registers
 *  the real one. */
export const FACTORY_RPC_METHODS: readonly RpcMethod[] = [
  FACT_RPC.poll, FACT_RPC.emit,
  BOT_RPC.list, BOT_RPC.create, BOT_RPC.update, BOT_RPC.remove, BOT_RPC.status,
  BOT_RPC.wake, BOT_RPC.park, BOT_RPC.resume, BOT_RPC.interrupt,
  ROOM_RPC.post, ROOM_RPC.read, ROOM_RPC.search, ROOM_RPC.threads, ROOM_RPC.resolve,
  HANDOFF_RPC.send, HANDOFF_RPC.answer, HANDOFF_RPC.list,
  ASK_PERSON_RPC,
  FACTORY_READ_RPC.prRead, FACTORY_READ_RPC.issueRead, FACTORY_READ_RPC.ciRead,
  FACTORY_READ_RPC.verdictRead, FACTORY_READ_RPC.trustMetricsRead,
  PLAN_RPC.propose,
  // The shared bot tools: a bot's own job and stop, its routines, owner
  // approvals, and secrets / logins.
  BOT_RPC.setJob, BOT_RPC.stopMyWork, BOT_RPC.resumeWorker,
  // A bot steers its own live worker and closes its own questions.
  BOT_RPC.workerMessage, BOT_RPC.questionClose,
  ROUTINE_RPC.set, ROUTINE_RPC.list, ROUTINE_RPC.pause,
  WORKFLOW_RPC.create, WORKFLOW_RPC.read, WORKFLOW_RPC.advance,
  BOT_APPROVAL_RPC.request, BOT_APPROVAL_RPC.list,
  BOT_SECRET_RPC.request, BOT_SECRET_RPC.list, BOT_SECRET_RPC.loginRequest,
  // A bot's own skills (shared/botSkill.ts).
  BOT_SKILL_RPC.propose, BOT_SKILL_RPC.read,
];

/** Every tool a bot surface may list, with the RPC methods it invokes (the
 *  first one is its primary). The existing names are the tools of the same
 *  name the bundled server already registers; the rest are registered by tool
 *  modules (src/mcp/toolModules.ts). A surface tool no module registers is
 *  served by a placeholder that forwards its arguments to the primary method,
 *  which main answers `not_implemented` until the real handler exists. */
export const BOT_TOOL_RPC = {
  workspace_list: ['workspace.list'],
  pane_list: ['pane.list'],
  terminal_read: ['input.readScreen', 'deck.resolvePaneRoute'],
  fleet_triage: ['fleet.triage'],
  ledger_update: ['ledger.update'],
  fanout_start: ['task.fanout.start'],
  wmux_events_poll: ['events.poll'],
  a2a_task_query: ['a2a.task.query'],
  fact_poll: [FACT_RPC.poll],
  room_post: [ROOM_RPC.post],
  room_read: [ROOM_RPC.read],
  room_search: [ROOM_RPC.search],
  handoff_send: [HANDOFF_RPC.send],
  ask_person: [ASK_PERSON_RPC],
  pr_read: [FACTORY_READ_RPC.prRead],
  issue_read: [FACTORY_READ_RPC.issueRead],
  ci_read: [FACTORY_READ_RPC.ciRead],
  verdict_read: [FACTORY_READ_RPC.verdictRead],
  pr_verdict: ['verify.recordVerdict'],
  trust_metrics_read: [FACTORY_READ_RPC.trustMetricsRead],
  plan_propose: [PLAN_RPC.propose],
  bot_list: [BOT_RPC.list],
  /** On no surface: the tool module that registers it is gated out. */
  bot_park: [BOT_RPC.park],
  job_set: [BOT_RPC.setJob],
  stop_my_work: [BOT_RPC.stopMyWork],
  worker_resume: [BOT_RPC.resumeWorker],
  worker_message: [BOT_RPC.workerMessage],
  question_close: [BOT_RPC.questionClose],
  routine_set: [ROUTINE_RPC.set],
  routine_list: [ROUTINE_RPC.list],
  routine_pause: [ROUTINE_RPC.pause],
  workflow_create: [WORKFLOW_RPC.create],
  workflow_read: [WORKFLOW_RPC.read],
  workflow_advance: [WORKFLOW_RPC.advance],
  approval_request: [BOT_APPROVAL_RPC.request],
  approval_list: [BOT_APPROVAL_RPC.list],
  secret_request: [BOT_SECRET_RPC.request],
  secret_list: [BOT_SECRET_RPC.list],
  login_request: [BOT_SECRET_RPC.loginRequest],
  skill_propose: [BOT_SKILL_RPC.propose],
  skill_read: [BOT_SKILL_RPC.read],
} as const satisfies Readonly<Record<string, readonly [RpcMethod, ...RpcMethod[]]>>;

export type BotToolName = keyof typeof BOT_TOOL_RPC;

/** What every bot MCP child calls to come up: the handshake identify, the
 *  capability probe, its own workspace from its token, the process-tree
 *  identity probe, and `#name` pane references. */
export const BOT_BASE_RPC: readonly RpcMethod[] = [
  'mcp.identify',
  'system.identify',
  'system.capabilities',
  'a2a.resolve.identity',
  'deck.resolveCommanderWorkspace',
  'pane.resolveName',
];

/** What a bot may call in a wake not known clean of a guest's words
 *  (main/factory/wakeTaint.ts): RpcRouter refuses every other method on the
 *  bot surface there, whatever the method's own checks say. Only what the
 *  guest conversation needs: talk in the room (each write is stamped
 *  guest-sourced), reads filtered by provenance (room.read, fact.poll,
 *  approval.list), and bot.list, scoped there to the bots of the wake's own
 *  conversation. Everything else (repository, CI, verdict, trust, terminal
 *  and pane reads, the bot's routines, workflows and skills) is left out. */
export const GUEST_SAFE_RPC: ReadonlySet<string> = new Set<string>([
  ...BOT_BASE_RPC,
  ROOM_RPC.post,
  ROOM_RPC.read,
  HANDOFF_RPC.send,
  ASK_PERSON_RPC,
  BOT_RPC.questionClose,
  BOT_RPC.list,
  FACT_RPC.poll,
  BOT_APPROVAL_RPC.list,
]);

/** The engine's built-in tools a bot may use in a wake not known clean
 *  (ClaudeSdkAdapter's per-call gate): none. A guest's reply needs only the
 *  wmux tools (room.post). */
export const GUEST_SAFE_BUILTIN_TOOLS: ReadonlySet<string> = new Set<string>();

/** What RpcRouter answers a bot call refused by GUEST_SAFE_RPC. */
export const GUEST_TURN_SURFACE_REFUSAL = 'this turn comes from an external guest\'s message (or wmux cannot tell where it came from); in such a turn a bot talks in its room and reads what the turn may see, and nothing else; tell the owner what you would do';

export interface BotSurface {
  tools: ReadonlySet<string>;
  rpc: ReadonlySet<string>;
  /** The bot fan-out presets (worktask/botFanoutPresets.ts) a bot may start;
   *  each runs Claude workers only. */
  fanoutPresets: readonly string[];
}

/** @deprecated name kept for imports; every bot has the same surface. */
export type RoleSurface = BotSurface;

/** Every bot's tools, in the order the system prompt lists them. */
export const SHARED_SURFACE_TOOLS: readonly BotToolName[] = [
  // talk
  'room_post', 'room_read', 'room_search', 'handoff_send', 'ask_person', 'question_close', 'bot_list',
  // own profile and work
  'job_set', 'routine_set', 'routine_list', 'routine_pause', 'stop_my_work',
  'workflow_create', 'workflow_read', 'workflow_advance',
  // own skills (proposals wait for the owner's approval)
  'skill_propose', 'skill_read',
  // workers (terminal_read reaches only the bot's own task panes, main-scoped)
  'fanout_start', 'ledger_update', 'terminal_read', 'workspace_list', 'worker_resume', 'worker_message',
  // repository reads
  'pr_read', 'issue_read', 'ci_read', 'verdict_read', 'trust_metrics_read',
  // outputs main records
  'pr_verdict', 'plan_propose',
  // owner-held acts
  'approval_request', 'approval_list', 'secret_request', 'secret_list', 'login_request',
  // feed
  'fact_poll',
];

/** Every bot fan-out preset (all Claude). */
export const SHARED_FANOUT_PRESETS: readonly string[] = ['default', 'repro', 'verify', 'maintain', 'research'];

function buildSurface(tools: readonly BotToolName[]): BotSurface {
  const rpc = new Set<string>(BOT_BASE_RPC);
  for (const tool of tools) for (const method of BOT_TOOL_RPC[tool]) rpc.add(method);
  return { tools: new Set<string>(tools), rpc, fanoutPresets: SHARED_FANOUT_PRESETS };
}

/** The one surface every bot holds, whatever its template or role tag. */
export const SHARED_SURFACE: BotSurface = buildSurface(SHARED_SURFACE_TOOLS);

/** The surface of a bot: SHARED_SURFACE, whoever it is. */
export function botSurfaceOf(): BotSurface {
  return SHARED_SURFACE;
}

/** The reads on which a Coordinator-template bot (bot.ts isCoordinatorBot)
 *  may name another workspace (`workspaceId` param) — the RPC methods, and
 *  for each what the extension covers. Every other bot is scoped to its own
 *  workspace on these; nothing else takes another workspace for a read.
 *  Messaging another workspace's bots (handoff_send, room_post.mentions) is
 *  every bot's, not part of this. Main checks the template on each call from
 *  the live profile (never from the token), so changing a bot's template
 *  takes effect on its next call. */
export const COORDINATOR_READ_EXTENSION: Readonly<Partial<Record<RpcMethod, string>>> = {
  [ROOM_RPC.read]: 'another workspace\'s room',
  [FACT_RPC.poll]: 'every workspace\'s facts',
  [FACTORY_READ_RPC.prRead]: 'another workspace\'s repository',
  [FACTORY_READ_RPC.issueRead]: 'another workspace\'s repository',
  [FACTORY_READ_RPC.ciRead]: 'another workspace\'s repository',
  [FACTORY_READ_RPC.verdictRead]: 'another workspace\'s repository',
  [FACTORY_READ_RPC.trustMetricsRead]: 'another workspace\'s repository',
  [PLAN_RPC.propose]: 'plan items in other workspaces',
};

/** @deprecated every role maps to SHARED_SURFACE; use botSurfaceOf. */
export const ROLE_SURFACES: Readonly<Record<BotRole, BotSurface>> = {
  lead: SHARED_SURFACE,
  triage: SHARED_SURFACE,
  verifier: SHARED_SURFACE,
  maintainer: SHARED_SURFACE,
  moa: SHARED_SURFACE,
};

/** Teardown-effect methods; on no surface, and refused for every bot token
 *  even if a future surface edit listed one. */
export const BOT_TEARDOWN_DENY: ReadonlySet<string> = COMMANDER_TEARDOWN_DENY;

/** Why RpcRouter refused a bot call, or null when the method is on the bot
 *  surface. The role tag does not change the answer. Pure. */
export function botSurfaceRefusal(role: BotRole, method: string): 'teardown' | 'surface' | null {
  if (BOT_TEARDOWN_DENY.has(method)) return 'teardown';
  // A binding whose tag is no role is malformed: nothing passes.
  if (!isBotRole(role) || !SHARED_SURFACE.rpc.has(method)) return 'surface';
  return null;
}

/** One refused bot call, as RpcRouter reports it to `onBotRefused` listeners
 *  (the fact log turns it into a `bot.refused` fact). */
export interface BotRefusal {
  at: number;
  bot: BotBinding;
  method: string;
  /** `guest`: the method is not in GUEST_SAFE_RPC and the bot's wake is not
   *  known clean. */
  reason: 'teardown' | 'surface' | 'guest';
}

// ── Typed refusals of factory RPC handlers ──────────────────────────────────

/** Every factory handler answers a refusal as a result, not a thrown error,
 *  in the same `{ok:false, code, message}` shape stage 2's verify.recordVerdict
 *  uses. */
export interface FactoryRefusal<C extends string = string> {
  ok: false;
  code: C;
  message: string;
}

export const FACTORY_NOT_IMPLEMENTED = 'not_implemented' as const;

export type FactoryNotImplemented = FactoryRefusal<typeof FACTORY_NOT_IMPLEMENTED> & { method: string };

export function factoryNotImplemented(method: string): FactoryNotImplemented {
  return {
    ok: false,
    code: FACTORY_NOT_IMPLEMENTED,
    method,
    message: `${method} is not available in this build`,
  };
}
