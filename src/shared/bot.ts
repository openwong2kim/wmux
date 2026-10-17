// ─── Bots — long-lived agent sessions bound to one workspace ───────────────
//
// A bot is one agent session bound to one workspace: a name, an optional
// picture and an optional job (free text the owner or the bot itself writes,
// part of its system prompt). Every bot holds the same powers
// (shared/botSurface.ts SHARED_SURFACE); a bot made from the Coordinator
// template may also read other workspaces' rooms and facts. Any number of
// bots, of any template, may share a workspace. It never holds a shell. Its
// identity on the pipe is a main-minted token bound to a BotBinding
// (main/deck/commanderTrust.ts `mintBotToken`), carried in the existing
// `commanderToken` envelope field; RpcRouter resolves it onto
// `RpcContext.bot`.
//
// The bundled MCP server runs a bot's tools in bot mode: `--bot=<role>` plus
// `--bot-token-file=<path>` (the token is handed over in a file main writes
// for that one spawn, not in the environment — see
// main/factory/botTokenHandoff.ts and src/mcp/botTokenHandoff.ts).

import type { FactFilter, FactKind } from './facts';

/** The legacy role tag. Kept in bots.json v1, on the token binding and on
 *  the phone wire as a label; it grants nothing. Powers come from
 *  SHARED_SURFACE (botSurface.ts) and, for the Coordinator, the template. */
export type BotRole = 'lead' | 'triage' | 'verifier' | 'maintainer' | 'moa';
// 'merge' is NOT a bot: it is the lane + executor (model-free).

export const BOT_ROLES: readonly BotRole[] = ['lead', 'triage', 'verifier', 'maintainer', 'moa'];

export function isBotRole(value: unknown): value is BotRole {
  return typeof value === 'string' && (BOT_ROLES as readonly string[]).includes(value);
}

// ── Templates and jobs ──────────────────────────────────────────────────────

/** A starting point for a new bot: it prefills the job text and picks the
 *  default triggers. `coordinator` is the one template that also grants a
 *  power — reading other workspaces' rooms and facts
 *  (botSurface.ts COORDINATOR_READ_EXTENSION). */
export type BotTemplate = 'coordinator' | 'developer' | 'reviewer' | 'issue' | 'researcher' | 'custom';

export const BOT_TEMPLATES: readonly BotTemplate[] = ['coordinator', 'developer', 'reviewer', 'issue', 'researcher', 'custom'];

export function isBotTemplate(value: unknown): value is BotTemplate {
  return typeof value === 'string' && (BOT_TEMPLATES as readonly string[]).includes(value);
}

/** The legacy role a new bot of a template is stored with (bots.json v1 keeps
 *  `role`; the default triggers and budget are still keyed by it). */
export const TEMPLATE_LEGACY_ROLE: Readonly<Record<BotTemplate, BotRole>> = {
  coordinator: 'moa',
  developer: 'lead',
  reviewer: 'verifier',
  issue: 'triage',
  researcher: 'lead',
  custom: 'lead',
};

/** The template a profile stored before templates existed takes from its role. */
export function templateOfRole(role: BotRole): BotTemplate {
  switch (role) {
    case 'moa': return 'coordinator';
    case 'lead': return 'developer';
    case 'verifier': return 'reviewer';
    case 'triage': return 'issue';
    case 'maintainer': return 'custom';
  }
}

/** A profile's template: its own, else the one its legacy role maps to. Every
 *  template check goes through this, never through `role`. */
export function botTemplate(profile: { template?: BotTemplate; role: BotRole }): BotTemplate {
  return profile.template ?? templateOfRole(profile.role);
}

/** The bot may read other workspaces' rooms and facts (the Coordinator). A
 *  missing profile is not one. Pure. */
export function isCoordinatorBot(profile: { template?: BotTemplate; role: BotRole } | null | undefined): boolean {
  return !!profile && botTemplate(profile) === 'coordinator';
}

/** The bot's new piece of work handed off from its own 1:1 or a group chat
 *  opens a request thread there (main/factory/handoffRouter.ts), which the
 *  conversation shows folded into one work card (shared/botsWork.ts): the
 *  Coordinator, or a bot with the `lead` role (the first bot a name-only
 *  create makes is one). It grants nothing; powers stay with
 *  isCoordinatorBot. Pure. */
export function delegatesFromConversation(profile: { template?: BotTemplate; role: BotRole } | null | undefined): boolean {
  return isCoordinatorBot(profile) || profile?.role === 'lead';
}

/** Longest job text, in UTF-16 units after trimming. */
export const BOT_JOB_MAX = 2000;

/** A job the bot store accepts: trimmed, 1..BOT_JOB_MAX long, no control
 *  characters other than newline and tab. Undefined otherwise. An empty job
 *  is expressed by leaving the field out, never by ''. */
export function normalizeBotJob(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const job = raw.replace(/\r\n?/g, '\n').trim();
  if (job.length === 0 || job.length > BOT_JOB_MAX) return undefined;
  return /[\p{Cc}\u2028\u2029]/u.test(job.replace(/[\n\t]/g, ' ')) ? undefined : job;
}

/** The agent behind a bot. v1 default is `claude-sdk`; `claude-pty` stays as a
 *  billing hedge; `acp` runs any ACP command and is opt-in. */
export type BotEngine =
  | { kind: 'claude-sdk'; model?: string; effort?: string }
  | { kind: 'claude-pty'; model?: string }
  | { kind: 'acp'; command: string; args: string[] };

export const DEFAULT_BOT_ENGINE: BotEngine = { kind: 'claude-sdk' };

/** The models a NEW bot of a template starts on (main/factory/botStore.ts
 *  `create`, when the caller names no engine or worker agent): `brain` is
 *  the bot's own `claude-sdk` model (BotEngine.model), `worker` its fan-out
 *  workers' (BotProfile.workerAgent). The ids are aliases from the model
 *  catalog (shared/claudeModels.ts CLAUDE_MODEL_OPTIONS), so they follow the
 *  installed claude CLI's newest model of that tier. A stored bot is never
 *  moved onto these; a template absent here starts on the defaults. */
export const TEMPLATE_MODEL_DEFAULTS: Readonly<Partial<Record<BotTemplate, { brain?: { model: string }; worker?: BotWorkerAgent }>>> = {
  coordinator: { brain: { model: 'haiku' } },
  issue: { brain: { model: 'haiku' } },
  researcher: { brain: { model: 'haiku' } },
  developer: { worker: { agent: 'claude', model: 'opus' } },
  reviewer: { worker: { agent: 'claude', model: 'opus' } },
};

/** The agent CLI a bot's fan-out workers run on (shared/botWorkerAgent.ts):
 *  a slug from fan-out's closed agent table that has a bot-worker guard, plus
 *  an optional model and effort. Set only by the owner; absent = the bot
 *  presets' own engine (Claude Code). */
export interface BotWorkerAgent {
  agent: string;
  model?: string;
  effort?: string;
}

export interface BotBudget {
  /** Turns per rolling hour. Absent = no hourly cap (never 0: a stored 0 is
   *  read as absent and refused on write). */
  maxTurnsPerHour?: number;
  maxTurnsPerDay: number;
  maxConcurrentWorkers: number;
  maxWorkerHoursPerDay: number;
  turnTimeoutMs: number;
}

/** Default budget per legacy role (a new bot's role follows its template,
 *  TEMPLATE_LEGACY_ROLE). No hourly cap: a group conversation takes many
 *  turns in an hour; the day cap (generous: a busy group room runs a bot
 *  some sixty turns in three hours) bounds the spend. Every bot may start
 *  workers (the Coordinator included). */
export const DEFAULT_BOT_BUDGETS: Readonly<Record<BotRole, BotBudget>> = {
  lead:       { maxTurnsPerDay: 200, maxConcurrentWorkers: 3, maxWorkerHoursPerDay: 6, turnTimeoutMs: 600_000 },
  triage:     { maxTurnsPerDay: 200, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 4, turnTimeoutMs: 600_000 },
  verifier:   { maxTurnsPerDay: 200, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 6, turnTimeoutMs: 600_000 },
  maintainer: { maxTurnsPerDay: 4,   maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 600_000 },
  moa:        { maxTurnsPerDay: 200, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 4, turnTimeoutMs: 600_000 },
};

export interface BotTrigger {
  kind: FactKind;
  filter?: FactFilter;
  /** Coalesce up to `max` matching facts within `windowMs` into one wake. */
  batch?: { windowMs: number; max: number };
}

export interface BotProfile {
  version: 1;
  /** 'bot-' + 8 hex, stable across restarts. */
  id: string;
  workspaceId: string;
  /** Legacy tag (see BotRole); identity, never updated. */
  role: BotRole;
  /** The template the bot was made from. Absent only on a profile written
   *  before templates; the store fills it from `role` on read (botTemplate). */
  template?: BotTemplate;
  /** Display name, e.g. "Wmux Dev". */
  name: string;
  /** What the bot does, in the owner's words (normalizeBotJob). Part of its
   *  system prompt. Written by the owner (profile, bot.update) or by the bot
   *  itself (job_set → bot.setJob, during a wake on the owner's words). */
  job?: string;
  engine: BotEngine;
  /** What its fan-out workers run on (absent: the presets' own engine). */
  workerAgent?: BotWorkerAgent;
  triggers: BotTrigger[];
  budget: BotBudget;
  /** The repo the bot acts on (fan-out needs it: a bot has no pane cwd).
   *  `originPin`: origin's address as the repository config held it when
   *  the folder was picked (shared/originPin.ts); a task with no pin of its
   *  own is held to it. */
  repo?: { repoKey: string; repoPath: string; originPin?: string };
  /** The owner's picture for the bot: a `data:image/png;base64,` URL of a
   *  square PNG at most BOT_AVATAR_PX wide, written only by main. Absent =
   *  the UI draws the name's initials. */
  avatar?: string;
  /** Its identity colour slot, 0..BOT_IDENTITY_SLOTS-1 (its character):
   *  given by main at create, the first slot free among its workspace's
   *  bots in IDENTITY_SPREAD order, and kept for its life, so a relaunch or
   *  another bot's removal never moves it. Absent only on a profile written
   *  before slots were stored (the store fills it on load). */
  hue?: number;
  enabled: boolean;
  /** `until`: an error park at the provider's usage limit, lifted by
   *  itself then (an older build reads it as a plain error park). */
  parked?: { reason: 'budget' | 'error' | 'human'; at: number; until?: number };
  createdAt: number;
  updatedAt: number;
}

export const BOT_ID_RE = /^bot-[0-9a-f]{8}$/;

/** How many identity colour slots a bot's face takes from (the renderer's
 *  BOT_IDENTITY_HUES). */
export const BOT_IDENTITY_SLOTS = 8;

/** The order a room's bots take the identity colours in: each next colour
 *  far from those before it (teal, violet, magenta, blue, slate, …), never
 *  the palette's neighbour, so a room's first five bots read apart. */
export const IDENTITY_SPREAD = [5, 2, 4, 0, 7, 3, 6, 1] as const;

export type IdentityBot = Pick<BotProfile, 'id' | 'createdAt' | 'workspaceId'>;

/** Each bot's colour slot among `bots`, per room (workspace): oldest first
 *  (then by id), a bot takes the first slot of IDENTITY_SPREAD that the
 *  fewest bots of its room hold (`taken`: slots its room's bots already
 *  hold) — two bots of a room never share one while the palette lasts. Pure. */
export function identityHueIndexes(bots: readonly IdentityBot[], taken: readonly { workspaceId: string; index: number }[] = []): Map<string, number> {
  const n = BOT_IDENTITY_SLOTS;
  const order = [...bots].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Map<string, number[]>();
  const usedIn = (ws: string) => {
    let u = used.get(ws);
    if (!u) { u = new Array<number>(n).fill(0); used.set(ws, u); }
    return u;
  };
  for (const t of taken) usedIn(t.workspaceId)[t.index] += 1;
  const out = new Map<string, number>();
  for (const b of order) {
    if (out.has(b.id)) continue;
    const u = usedIn(b.workspaceId);
    const least = Math.min(...u);
    const pick = IDENTITY_SPREAD.find((i) => u[i] === least) ?? IDENTITY_SPREAD[0];
    u[pick] += 1;
    out.set(b.id, pick);
  }
  return out;
}

/** Whether a value is an identity colour slot. */
export function isIdentitySlot(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < BOT_IDENTITY_SLOTS;
}

/** What is kept of a removed bot (bots.json `removed`): enough for the cards
 *  it wrote to keep its name and face, marked as removed. */
export interface RemovedBot {
  id: string;
  workspaceId: string;
  role: BotRole;
  template?: BotTemplate;
  name: string;
  /** Its picture, when it had one (BotProfile.avatar). */
  avatar?: string;
  /** Its identity colour slot, 0..BOT_IDENTITY_SLOTS-1, when the remover
   *  knew it (the Bots page does). */
  hue?: number;
  removedAt: number;
}

/** Edge of the stored avatar PNG, in pixels. */
export const BOT_AVATAR_PX = 128;

/** Longest bot name, in UTF-16 units after trimming. */
export const BOT_NAME_MAX = 64;

/** A stored bot name read back: trimmed, 1..BOT_NAME_MAX long, no control
 *  or line-separator characters. Looser than normalizeBotName, so a name
 *  stored before its path-separator rule still loads. Undefined otherwise. */
export function storedBotName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim();
  if (name.length === 0 || name.length > BOT_NAME_MAX) return undefined;
  return /[\p{Cc}\u2028\u2029]/u.test(name) ? undefined : name;
}

/** A name the bot store accepts on create / update: a storedBotName with no
 *  path separator (`/`, `\`), so a pasted command or path is not taken for
 *  a name. Letters of any script, spaces and other punctuation are fine.
 *  Undefined otherwise. */
export function normalizeBotName(raw: unknown): string | undefined {
  const name = storedBotName(raw);
  return name && !/[/\\]/.test(name) ? name : undefined;
}

/** What a bot token resolves to. */
export interface BotBinding { workspaceId: string; botId: string; role: BotRole; }

const BINDING_WORKSPACE_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** A well-formed binding (non-empty workspace, bot id shape, known role). */
export function isBotBinding(value: unknown): value is BotBinding {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return typeof b.workspaceId === 'string'
    && BINDING_WORKSPACE_RE.test(b.workspaceId)
    && typeof b.botId === 'string'
    && BOT_ID_RE.test(b.botId)
    && isBotRole(b.role);
}

export type BotPresence = 'running' | 'idle' | 'parked' | 'stopped' | 'unknown';
// 'unknown' = the profile exists but the runtime has not restored or pinged
// the session yet. unknown ≠ offline: the queue keeps accepting wakes.

export interface BotStatus {
  botId: string;
  presence: BotPresence;
  sessionId?: string;
  /** `threadId`: the room thread the running turn answers in (absent: none,
   *  or `general`), so a busy line shows in that conversation only. */
  currentTurn?: { wakeId: string; startedAt: number; threadId?: string };
  queueDepth: number;
  /** turnsHour is null when the bot has no hourly cap. */
  budgetLeft: { turnsHour: number | null; turnsDay: number; workerHoursDay: number };
  /** What the profile's Today block shows beside budgetLeft (absent from an
   *  older build). */
  usage?: BotStatusUsage;
  lastError?: { message: string; at: number };
}

/** A bot's use of its limits now (main/factory/budget.ts). */
export interface BotStatusUsage {
  /** Turns started in the last hour; null when the bot has no hourly cap. */
  turnsHour: number | null;
  turnsDay: number;
  /** Worker time in the last day, in hours (may pass the cap: a running
   *  worker counts up to now). */
  workerHoursDay: number;
  /** When out of turns: when a turn is allowed again (absent: never, a cap
   *  of 0). */
  nextTurnAt?: number;
  /** When out of worker time and no worker of its runs: when its worker
   *  time drops below the cap. */
  workerTimeAt?: number;
  /** Its workers running now, as the fan-out's cap counts them. */
  workersRunning?: number;
  /** Its new workers waiting for an agent slot (they count against its cap). */
  workersWaiting?: number;
  /** Bot workers running factory-wide (cap WAKE_LIMITS.GLOBAL_CONCURRENT_WORKERS). */
  factoryWorkers?: number;
  /** The factory's agent slots (Settings › Bots). */
  slots?: { inUse: number; cap: number };
}

export const BOT_RPC = {
  list: 'bot.list', create: 'bot.create', update: 'bot.update', remove: 'bot.remove',
  status: 'bot.status', wake: 'bot.wake', park: 'bot.park', resume: 'bot.resume', interrupt: 'bot.interrupt',
  /** `job_set`: the bot's own job (BotSetJobParams). Also the operator's. */
  setJob: 'bot.setJob',
  /** `stop_my_work`: stop the calling bot's own workers and pause its
   *  routines (factoryStop.ts primitives for that bot); the stop lands after
   *  the current turn. A bot only ever stops itself. */
  stopMyWork: 'bot.stopMyWork',
  /** `worker_resume`: relaunch the stopped worker of an ended task the
   *  calling bot started, with the same conversation in the same folder
   *  (main/factory/workerReclaim.ts), optionally with a message for it. */
  resumeWorker: 'bot.resumeWorker',
  /** `worker_message`: deliver text to the live worker of an open task the
   *  calling bot started (BotWorkerMessageParams), through the gated pane
   *  delivery the report nudge uses (it waits while someone types there).
   *  Refused when the worker's agent is not running; rate-limited per task. */
  workerMessage: 'bot.workerMessage',
  /** `question_close`: close one of the calling bot's own open question
   *  cards (BotQuestionCloseParams) once it no longer needs an answer. */
  questionClose: 'bot.questionClose',
} as const;

/** `bot.workerMessage` params. */
export interface BotWorkerMessageParams {
  /** An open task (`wtask-…`) the calling bot started. */
  taskId: string;
  /** What the worker should read, 1..BOT_WORKER_MESSAGE_LIMITS.TEXT_MAX. */
  text: string;
}

/** `bot.workerMessage` result: `delivered` once the text reached the
 *  worker's prompt; `held` when the gated delivery gave up (someone kept
 *  typing, the pane stayed busy) and nothing was typed. */
export type BotWorkerMessageResult =
  | { ok: true; status: 'delivered'; taskId: string }
  | { ok: false; code: 'held' | 'not_found' | 'not_running' | 'rate_limited' | 'invalid_argument' | 'factory_off' | 'not_now' | 'not_started' | 'not_authorized'; message: string };

export const BOT_WORKER_MESSAGE_LIMITS = {
  TEXT_MAX: 4000,
  /** Shortest gap between two messages to one task's worker. */
  MIN_GAP_MS: 30_000,
  /** Messages one task's worker may get in a rolling hour. */
  PER_HOUR: 10,
} as const;

/** `bot.questionClose` params: one of the caller's own open `question`
 *  cards, in its own workspace's room. */
export interface BotQuestionCloseParams {
  cardId: string;
}

/** `bot.setJob` — set or clear a job. A bot may set only its own (botId
 *  omitted or its own), and only while it runs a wake whose reason is the
 *  owner's words (`human`); main posts a `job_changed` card (room.ts
 *  RoomCard.jobChange) the owner can undo. The operator may set any bot's. */
export interface BotSetJobParams {
  botId?: string;
  /** The new job (normalizeBotJob), or null to clear it. */
  job: string | null;
}

/** main → renderer push on BOT_EVENT. The renderer re-reads what changed;
 *  the payload carries no secret value and no picture.
 *  - `bot.status`: one bot's runtime status;
 *  - `bots-changed`: profiles (or their tasks) changed;
 *  - `approvals-changed`: the pending approval requests or the
 *    remembered rules changed (shared/botApproval.ts);
 *  - `routines-changed`: a bot's routines changed (shared/botRoutine.ts);
 *  - `secrets-changed`: the stored secret names or their use changed
 *    (shared/botSecret.ts);
 *  - `connectors-changed`: the connection library changed
 *    (shared/botConnector.ts);
 *  - `groups-changed`: the owner's group chats changed (shared/botGroup.ts);
 *  - `skills-changed`: a bot's skills changed (shared/botSkill.ts). */
export type BotEventPayload =
  | { type: 'bot.status'; status: BotStatus }
  | { type: 'bots-changed' }
  | { type: 'approvals-changed'; workspaceId?: string }
  | { type: 'routines-changed'; botId?: string }
  | { type: 'secrets-changed' }
  | { type: 'connectors-changed' }
  | { type: 'groups-changed' }
  | { type: 'skills-changed'; botId?: string };

export const BOT_EVENT = 'bot.event';

// ── MCP bot mode (argv) ─────────────────────────────────────────────────────

/** `--bot=<role>`: the bundled MCP server runs in bot mode — it registers the
 *  shared bot surface and claims the bot role on every RPC. An argv flag,
 *  never an env var. */
export const BOT_MODE_ARG_PREFIX = '--bot=';
/** `--bot-token-file=<path>`: where the bot token is read from (once). */
export const BOT_TOKEN_FILE_ARG_PREFIX = '--bot-token-file=';

function lastArg(argv: readonly string[], prefix: string): string | undefined {
  const hit = [...argv].reverse().find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

/** The raw `--bot=` value (last one wins), or undefined. Unvalidated, so the
 *  server can report an unknown role itself. */
export function botArgValue(argv: readonly string[]): string | undefined {
  return lastArg(argv, BOT_MODE_ARG_PREFIX);
}

/** The `--bot-token-file=` path (last one wins), or undefined. */
export function botTokenFileArgValue(argv: readonly string[]): string | undefined {
  return lastArg(argv, BOT_TOKEN_FILE_ARG_PREFIX);
}

/** The MCP server args (after the bundle path) for one bot spawn. The role
 *  is the legacy tag; every bot server lists the same shared surface. */
export function botMcpArgs(role: BotRole, tokenFile: string): string[] {
  return [`${BOT_MODE_ARG_PREFIX}${role}`, `${BOT_TOKEN_FILE_ARG_PREFIX}${tokenFile}`];
}
