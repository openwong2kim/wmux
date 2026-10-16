// ─── Bot store — `<wmuxDir>/factory/bots.json` ─────────────────────────────
//
// Bot profiles (shared/bot.ts BotProfile) and each bot's budget usage
// (budget.ts), main-owned. `{version:1, bots, usage}`; usage is a sibling map
// keyed by bot id so the profile shape stays the shared contract. Every
// profile field is validated on create/update and again on read: one
// malformed profile on disk is dropped (logged), never half-trusted. A file of
// another version is refused.
//
// A profile's picture (`avatar`) is written only through `create` (from
// Settings' Add bot) and `setAvatar`, both checked by botAvatar.ts; `update`
// refuses it, so the pipe's bot.update never sets one. A picture that fails
// the check on read is dropped and the bot kept; so is a job that fails
// normalizeBotJob, a worker agent (`workerAgent`, optional, owner-set
// through `update`) that fails validateBotWorkerAgent, and an engine model
// that fails fan-out's model rule (shared/fanoutPreset.ts
// validateFanoutModel), which is refused on create/update.
//
// A bot's own model and effort are its engine's (`engine.model`/`effort`,
// claude-sdk); its workers' are `workerAgent`. Both are optional, so a
// profile written before the Bots profile could pick them loads unchanged.
// A new bot of a template starts on that template's models
// (shared/bot.ts TEMPLATE_MODEL_DEFAULTS) unless the caller names an engine
// or worker agent; a stored bot is never moved onto them.
//
// Any number of bots, of any template, may share a workspace. A profile
// written before templates gets its template from its role on read
// (shared/bot.ts templateOfRole), and keeps it on the next write; bots.json
// stays version 1. A stored hourly turn cap of 0 is read as no hourly cap
// (BotBudget.maxTurnsPerHour is never 0) and refused on write.
//
// A removed bot leaves a tombstone (`removed`, shared/bot.ts RemovedBot: its
// id, name, role, picture and colour slot), so the cards it wrote keep its
// name and face after a restart. A build without it drops the list on its
// next write; bots.json stays version 1.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  BOT_ID_RE,
  BOT_JOB_MAX,
  BOT_NAME_MAX,
  DEFAULT_BOT_BUDGETS,
  TEMPLATE_LEGACY_ROLE,
  TEMPLATE_MODEL_DEFAULTS,
  isBotBinding,
  isBotRole,
  isBotTemplate,
  normalizeBotJob,
  normalizeBotName,
  storedBotName,
  templateOfRole,
  type BotBudget,
  type BotEngine,
  type BotProfile,
  type BotRole,
  type BotTemplate,
  type BotTrigger,
  type RemovedBot,
  BOT_IDENTITY_SLOTS,
  identityHueIndexes,
  isIdentitySlot,
} from '../../shared/bot';
import { CLAUDE_EFFORT_LEVELS } from '../../shared/claudeModels';
import { isFactKind, type FactFilter } from '../../shared/facts';
import { normalizeRepoKey } from '../../shared/repoKey';
import { emptyUsage, pruneUsage, sanitizeUsage, type BotUsage } from './budget';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';
import { LEGACY_TRIAGE_TRIGGERS, defaultTriggers } from './roleDefaults';
import { parseBotAvatar } from './botAvatar';
import { validateBotWorkerAgent } from '../../shared/botWorkerAgent';
import { validateBotBrainModel, validateFanoutModel } from '../../shared/fanoutPreset';

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export const BOTS_FILE_VERSION = 1 as const;
export const BOTS_MAX = 64;
/** Removed bots remembered (bots.json `removed`), newest kept. */
export const REMOVED_BOTS_MAX = 64;
const NAME_MAX = BOT_NAME_MAX;
const TRIGGERS_MAX = 32;
const ACP_COMMAND_MAX = 512;
const ACP_ARGS_MAX = 32;
const ACP_ARG_MAX = 512;
const LABEL_MAX = 100;
const BATCH_WINDOW_MAX_MS = 24 * 3_600_000;
const BATCH_MAX = 100;
const EFFORTS: ReadonlySet<string> = new Set(CLAUDE_EFFORT_LEVELS);

/** What a store answers to the trigger engine (§14). */
export interface BotDirectoryApi {
  listEnabled(): BotProfile[];
  get(botId: string): BotProfile | null;
}

// ── validation ──────────────────────────────────────────────────────────────

function boundedString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

/** A well-formed engine (a fresh object), or null. A model must pass
 *  fan-out's model rule (validateFanoutModel); on a read (`read: true`) a
 *  stored model that does not is dropped and the engine kept, so the bot
 *  runs on the default model rather than disappearing. */
export function sanitizeBotEngine(raw: unknown, opts: { read?: boolean } = {}): BotEngine | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const checked = r.model === undefined ? undefined : r.kind === 'claude-sdk' ? validateBotBrainModel(r.model) : validateFanoutModel(r.model);
  if (checked && !checked.ok && opts.read !== true) return null;
  const model = checked?.ok ? checked.model : undefined;
  switch (r.kind) {
    case 'claude-sdk': {
      if (r.effort !== undefined && (typeof r.effort !== 'string' || !EFFORTS.has(r.effort))) return null;
      return {
        kind: 'claude-sdk',
        ...(model ? { model } : {}),
        ...(typeof r.effort === 'string' ? { effort: r.effort } : {}),
      };
    }
    case 'claude-pty':
      return { kind: 'claude-pty', ...(model ? { model } : {}) };
    case 'acp': {
      const command = boundedString(r.command, ACP_COMMAND_MAX);
      if (!command || !Array.isArray(r.args) || r.args.length > ACP_ARGS_MAX) return null;
      if (!r.args.every((a) => typeof a === 'string' && a.length <= ACP_ARG_MAX)) return null;
      return { kind: 'acp', command, args: [...(r.args as string[])] };
    }
    default:
      return null;
  }
}

function sanitizeFilter(raw: unknown): FactFilter | null {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: FactFilter = {};
  if (r.labelsAny !== undefined) {
    if (!Array.isArray(r.labelsAny) || !r.labelsAny.every((l) => boundedString(l, LABEL_MAX) !== undefined)) return null;
    out.labelsAny = (r.labelsAny as string[]).map((l) => l.trim()).slice(0, 20);
  }
  if (r.authorTrusted !== undefined) {
    if (typeof r.authorTrusted !== 'boolean') return null;
    out.authorTrusted = r.authorTrusted;
  }
  if (r.repoKey !== undefined) {
    const repoKey = normalizeRepoKey(r.repoKey);
    if (!repoKey) return null;
    out.repoKey = repoKey;
  }
  if (r.botIdNot !== undefined) {
    if (typeof r.botIdNot !== 'string' || !BOT_ID_RE.test(r.botIdNot)) return null;
    out.botIdNot = r.botIdNot;
  }
  return out;
}

/** Well-formed triggers (fresh objects), or null when any one is malformed. */
export function sanitizeTriggers(raw: unknown): BotTrigger[] | null {
  if (!Array.isArray(raw) || raw.length > TRIGGERS_MAX) return null;
  const out: BotTrigger[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    const r = t as Record<string, unknown>;
    if (!isFactKind(r.kind)) return null;
    const filter = sanitizeFilter(r.filter);
    if (!filter) return null;
    const trigger: BotTrigger = { kind: r.kind };
    if (Object.keys(filter).length > 0) trigger.filter = filter;
    if (r.batch !== undefined) {
      const b = r.batch as Record<string, unknown> | null;
      if (
        !b || typeof b !== 'object'
        || !Number.isInteger(b.windowMs) || (b.windowMs as number) < 0 || (b.windowMs as number) > BATCH_WINDOW_MAX_MS
        || !Number.isInteger(b.max) || (b.max as number) < 1 || (b.max as number) > BATCH_MAX
      ) {
        return null;
      }
      trigger.batch = { windowMs: b.windowMs as number, max: b.max as number };
    }
    out.push(trigger);
  }
  return out;
}

const BUDGET_CAPS: Readonly<Record<keyof BotBudget, number>> = {
  maxTurnsPerHour: 120,
  maxTurnsPerDay: 1_000,
  maxConcurrentWorkers: 8,
  maxWorkerHoursPerDay: 48,
  turnTimeoutMs: 3_600_000,
};

/** `base` with the well-formed fields of `raw` applied, or null when a given
 *  field is malformed. On a write (`read: false`) an hourly cap of 0 is
 *  malformed and `maxTurnsPerHour: null` removes the cap; on a read a stored
 *  0 is taken as no hourly cap. */
export function sanitizeBudget(raw: unknown, base: BotBudget, opts: { read?: boolean } = {}): BotBudget | null {
  if (raw === undefined) return { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: BotBudget = { ...base };
  for (const key of Object.keys(BUDGET_CAPS) as (keyof BotBudget)[]) {
    if (r[key] === undefined) continue;
    const v = r[key];
    if (key === 'maxTurnsPerHour' && (v === null || (opts.read === true && v === 0))) {
      if (v === null && opts.read === true) return null;
      delete out.maxTurnsPerHour;
      continue;
    }
    const min = key === 'turnTimeoutMs' ? 10_000 : key === 'maxTurnsPerHour' ? 1 : 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > BUDGET_CAPS[key]) return null;
    if (key !== 'maxWorkerHoursPerDay' && !Number.isInteger(v)) return null;
    out[key] = v;
  }
  return out;
}

function sanitizeRepo(raw: unknown): BotProfile['repo'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // `owner/repo` or `host/owner/repo`, stored in the one canonical form.
  const repoKey = normalizeRepoKey(r.repoKey);
  if (!repoKey) return null;
  if (typeof r.repoPath !== 'string' || r.repoPath.length > 4096 || !path.isAbsolute(r.repoPath)) return null;
  return { repoKey, repoPath: path.normalize(r.repoPath) };
}

function sanitizeParked(raw: unknown): BotProfile['parked'] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.reason !== 'budget' && r.reason !== 'error' && r.reason !== 'human') return null;
  if (!Number.isSafeInteger(r.at)) return null;
  const until = r.reason === 'error' && Number.isSafeInteger(r.until) ? (r.until as number) : undefined;
  return { reason: r.reason, at: r.at as number, ...(until !== undefined ? { until } : {}) };
}

/** A profile read from disk, fully validated (a fresh object), or null. */
/** A removed bot's tombstone, validated (null: dropped). */
export function parseRemovedBot(raw: unknown): RemovedBot | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !BOT_ID_RE.test(raw.id)) return null;
  if (typeof raw.workspaceId !== 'string' || raw.workspaceId.length === 0 || raw.workspaceId.length > 200) return null;
  if (!isBotRole(raw.role)) return null;
  const name = storedBotName(raw.name);
  if (!name || !Number.isSafeInteger(raw.removedAt)) return null;
  const avatar = raw.avatar === undefined ? null : parseBotAvatar(raw.avatar);
  const hue = Number.isInteger(raw.hue) && (raw.hue as number) >= 0 && (raw.hue as number) < BOT_IDENTITY_SLOTS ? (raw.hue as number) : undefined;
  return {
    id: raw.id,
    workspaceId: raw.workspaceId,
    role: raw.role,
    ...(isBotTemplate(raw.template) ? { template: raw.template } : {}),
    name,
    ...(avatar ? { avatar } : {}),
    ...(hue !== undefined ? { hue } : {}),
    removedAt: raw.removedAt as number,
  };
}

export function parseBotProfile(raw: unknown): BotProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  if (typeof r.id !== 'string' || !BOT_ID_RE.test(r.id)) return null;
  if (!isBotRole(r.role)) return null;
  if (!isBotBinding({ workspaceId: r.workspaceId, botId: r.id, role: r.role })) return null;
  const name = boundedString(r.name, NAME_MAX);
  const engine = sanitizeBotEngine(r.engine, { read: true });
  const triggers = sanitizeTriggers(r.triggers);
  const budget = sanitizeBudget(r.budget, DEFAULT_BOT_BUDGETS[r.role], { read: true });
  if (!name || !engine || !triggers || !budget || typeof r.enabled !== 'boolean') return null;
  const repo = r.repo === undefined ? undefined : sanitizeRepo(r.repo);
  const parked = r.parked === undefined ? undefined : sanitizeParked(r.parked);
  if (repo === null || parked === null) return null;
  if (!Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.updatedAt)) return null;
  const avatar = r.avatar === undefined ? null : parseBotAvatar(r.avatar);
  // Absent (a profile from before templates): the role's template. Present
  // but not a template: Custom, which grants nothing beyond the shared set.
  const template: BotTemplate = r.template === undefined ? templateOfRole(r.role) : isBotTemplate(r.template) ? r.template : 'custom';
  const job = normalizeBotJob(r.job);
  // What the workers run on: kept when it still validates, dropped (the bot
  // kept, on the presets' engine) otherwise.
  const workerAgent = r.workerAgent === undefined ? undefined : validateBotWorkerAgent(r.workerAgent);
  return {
    version: 1,
    id: r.id,
    workspaceId: r.workspaceId as string,
    role: r.role,
    template,
    name,
    ...(job ? { job } : {}),
    engine,
    ...(workerAgent?.ok ? { workerAgent: workerAgent.value } : {}),
    triggers,
    budget,
    ...(repo ? { repo } : {}),
    ...(avatar ? { avatar } : {}),
    ...(isIdentitySlot(r.hue) ? { hue: r.hue } : {}),
    enabled: r.enabled,
    ...(parked ? { parked } : {}),
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
  };
}

/** The default engine with the template's own model (TEMPLATE_MODEL_DEFAULTS
 *  `brain`) when it is claude-sdk and names no model itself. Pure. */
function withTemplateBrain(engine: BotEngine | null, template: BotTemplate): BotEngine | null {
  const brain = TEMPLATE_MODEL_DEFAULTS[template]?.brain;
  if (!engine || !brain || engine.kind !== 'claude-sdk' || engine.model) return engine;
  return { ...engine, model: brain.model };
}

function copyProfile(p: BotProfile): BotProfile {
  return parseBotProfile(JSON.parse(JSON.stringify(p))) as BotProfile;
}

/** The default name of a bot created with a legacy role and no name. */
const DEFAULT_NAMES: Readonly<Record<BotRole, string>> = {
  lead: 'Lead',
  triage: 'Triage',
  verifier: 'Verifier',
  maintainer: 'Maintainer',
  moa: 'Moa',
};

/** The default name of a bot created from a template and no name. */
const TEMPLATE_NAMES: Readonly<Record<BotTemplate, string>> = {
  coordinator: 'Coordinator',
  developer: 'Developer',
  reviewer: 'Reviewer',
  issue: 'Issue',
  researcher: 'Researcher',
  custom: 'Bot',
};

/** The hourly turn caps every role was created with before bots lost the
 *  hourly cap. A profile from before templates still on exactly its role's
 *  value never had it changed by the owner, so the store drops it on its
 *  first load (written back with its template); any other cap is kept. */
export const LEGACY_DEFAULT_HOURLY_CAPS: Readonly<Record<BotRole, number>> = {
  lead: 6,
  triage: 6,
  verifier: 12,
  maintainer: 2,
  moa: 12,
};

// ── store ───────────────────────────────────────────────────────────────────

export type BotStoreRefusal =
  | 'invalid_argument'
  | 'too_many_bots'
  | 'not_found';

export type BotStoreResult = { ok: true; bot: BotProfile } | { ok: false; code: BotStoreRefusal; message: string };

export interface BotCreateInput {
  workspaceId: unknown;
  /** The template (shared/bot.ts BotTemplate); absent = from `role`, else custom. */
  template?: unknown;
  /** Legacy tag; absent = the template's (TEMPLATE_LEGACY_ROLE). */
  role?: unknown;
  name?: unknown;
  /** The job text (normalizeBotJob); absent = none. */
  job?: unknown;
  engine?: unknown;
  /** What its workers run on (validateBotWorkerAgent); absent = the
   *  template's default (TEMPLATE_MODEL_DEFAULTS), else the presets' engine. */
  workerAgent?: unknown;
  triggers?: unknown;
  budget?: unknown;
  repo?: unknown;
  enabled?: unknown;
  /** Settings' Add bot only (botCreate.ts); bot.create never passes it. */
  avatar?: unknown;
}

/** The fields `update` may change (identity — id, workspace, role — never).
 *  `job: null` clears the job, `workerAgent: null` puts the workers back on
 *  the presets' engine; `template` changes what the bot is shown as
 *  and, for the Coordinator, its reads in other workspaces. */
export const BOT_UPDATABLE_FIELDS = ['name', 'job', 'template', 'engine', 'workerAgent', 'triggers', 'budget', 'repo', 'enabled'] as const;

export interface BotStoreOptions {
  now?: () => number;
  newId?: () => string;
  /** Engine for a create that names none (factory settings). */
  defaultEngine?: () => BotEngine;
  /** The host a worker agent is saved for (default: this one). */
  platform?: string;
}

export function botsFilePath(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', 'bots.json');
}

export class BotStore implements BotDirectoryApi {
  private bots = new Map<string, BotProfile>();
  private usage = new Map<string, BotUsage>();
  private removed: RemovedBot[] = [];
  private readonly persister: FilePersister;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly defaultEngine: () => BotEngine;
  private readonly platform: string;
  private readonly listeners = new Set<() => void>();
  /** Triage bots moved off the old default triggers by the last load. */
  private migrated: string[] = [];

  constructor(private readonly file: string, opts: BotStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `bot-${randomBytes(4).toString('hex')}`);
    this.defaultEngine = opts.defaultEngine ?? (() => ({ kind: 'claude-sdk' }));
    this.platform = opts.platform ?? process.platform;
    this.persister = createFilePersister(file, () => this.snapshot());
  }

  /** Read the file (missing → empty). Throws on another version. A triage
   *  profile still on the old default triggers gets the current defaults
   *  (written back); triggers the owner edited are kept as they are. */
  load(): void {
    const raw = readVersionedFile(this.file, BOTS_FILE_VERSION);
    this.bots.clear();
    this.usage.clear();
    this.removed = [];
    if (!raw) return;
    if (Array.isArray(raw.removed)) {
      for (const entry of raw.removed.slice(-REMOVED_BOTS_MAX)) {
        const r = parseRemovedBot(entry);
        if (r) this.removed.push(r);
      }
    }
    const list = Array.isArray(raw.bots) ? raw.bots : [];
    let migrated = false;
    this.migrated = [];
    for (const entry of list) {
      const bot = parseBotProfile(entry);
      if (!bot || this.bots.has(bot.id)) {
        console.warn(`[factory] bots.json: dropped a malformed or duplicate bot profile`);
        continue;
      }
      if (bot.role === 'triage' && JSON.stringify(bot.triggers) === JSON.stringify(LEGACY_TRIAGE_TRIGGERS)) {
        bot.triggers = defaultTriggers('triage');
        bot.updatedAt = this.now();
        migrated = true;
        this.migrated.push(bot.id);
      }
      // A profile written before templates (no `template` on disk) is
      // written back with the one parseBotProfile derived from its role, and
      // loses its role's old default hourly cap once; a cap on a profile
      // written since is the owner's and stays.
      const legacy = !isRecord(entry) || entry.template === undefined;
      if (legacy && bot.budget.maxTurnsPerHour === LEGACY_DEFAULT_HOURLY_CAPS[bot.role]) {
        delete bot.budget.maxTurnsPerHour;
        bot.updatedAt = this.now();
      }
      if (legacy || entry.template !== bot.template) migrated = true;
      this.bots.set(bot.id, bot);
    }
    // A profile from before identity slots were stored gets the slot the
    // Bots page computed for it (oldest first, among its workspace's bots),
    // written back once, so no bot's character changes with the upgrade.
    const live = [...this.bots.values()];
    const missing = live.filter((b) => b.hue === undefined);
    if (missing.length > 0) {
      const taken = live.filter((b) => b.hue !== undefined).map((b) => ({ workspaceId: b.workspaceId, index: b.hue as number }));
      for (const [id, hue] of identityHueIndexes(missing, taken)) (this.bots.get(id) as BotProfile).hue = hue;
      migrated = true;
    }
    const usage = raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage)
      ? (raw.usage as Record<string, unknown>)
      : {};
    for (const id of this.bots.keys()) this.usage.set(id, sanitizeUsage(usage[id]));
    if (migrated) void this.persister.schedule().catch((err) => console.warn(`[factory] bots.json write failed: ${String(err)}`));
  }

  /** The triage bots the last load moved to the current default triggers. */
  migratedTriageBots(): string[] {
    return [...this.migrated];
  }

  private snapshot(): unknown {
    const usage: Record<string, BotUsage> = {};
    for (const [id, u] of this.usage) usage[id] = u;
    return { version: BOTS_FILE_VERSION, bots: [...this.bots.values()], usage, ...(this.removed.length > 0 ? { removed: this.removed } : {}) };
  }

  /** Resolves once the current state is on disk. */
  flush(): Promise<void> {
    return this.persister.schedule();
  }

  private changed(): void {
    void this.persister.schedule().catch((err) => console.warn(`[factory] bots.json write failed: ${String(err)}`));
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* a listener never breaks the store */
      }
    }
  }

  /** Profiles changed (create/update/remove/park). Returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(filter: { workspaceId?: string } = {}): BotProfile[] {
    return [...this.bots.values()]
      .filter((b) => !filter.workspaceId || b.workspaceId === filter.workspaceId)
      .map(copyProfile);
  }

  listEnabled(): BotProfile[] {
    return [...this.bots.values()].filter((b) => b.enabled).map(copyProfile);
  }

  get(botId: string): BotProfile | null {
    const b = this.bots.get(botId);
    return b ? copyProfile(b) : null;
  }

  create(input: BotCreateInput): BotStoreResult {
    if (input.template !== undefined && !isBotTemplate(input.template)) {
      return refuse('invalid_argument', 'template must be one of coordinator, developer, reviewer, issue, researcher, custom');
    }
    if (input.role !== undefined && !isBotRole(input.role)) return refuse('invalid_argument', 'role must be one of lead, triage, verifier, maintainer, moa');
    const template: BotTemplate = input.template ?? (input.role !== undefined ? templateOfRole(input.role) : 'custom');
    const role: BotRole = input.role ?? TEMPLATE_LEGACY_ROLE[template];
    if (typeof input.workspaceId !== 'string' || !isBotBinding({ workspaceId: input.workspaceId, botId: 'bot-00000000', role })) {
      return refuse('invalid_argument', 'workspaceId must be a workspace id');
    }
    const workspaceId = input.workspaceId;
    if (this.bots.size >= BOTS_MAX) return refuse('too_many_bots', `at most ${BOTS_MAX} bots`);
    const job = input.job === undefined ? undefined : normalizeBotJob(input.job);
    if (input.job !== undefined && job === undefined) return refuse('invalid_argument', `job must be 1-${BOT_JOB_MAX} characters, no control characters but newlines`);
    const fallbackName = input.template === undefined && input.role !== undefined ? DEFAULT_NAMES[role] : TEMPLATE_NAMES[template];
    const name = input.name === undefined ? fallbackName : normalizeBotName(input.name);
    if (!name) return refuse('invalid_argument', `name must be 1-${NAME_MAX} characters, no control characters or slashes`);
    const engine = input.engine === undefined ? withTemplateBrain(sanitizeBotEngine(this.defaultEngine()), template) : sanitizeBotEngine(input.engine);
    if (!engine) return refuse('invalid_argument', 'engine is malformed (a model must be one model id: letters/digits first, then . _ : -, optionally ending in a [variant])');
    let workerAgent = TEMPLATE_MODEL_DEFAULTS[template]?.worker;
    if (input.workerAgent !== undefined) {
      const v = validateBotWorkerAgent(input.workerAgent, this.platform);
      if (!v.ok) return refuse('invalid_argument', v.error);
      workerAgent = v.value;
    }
    // No triggers given: the role's defaults (roleDefaults.ts), so a new bot
    // wakes on its role's facts without the caller spelling them out.
    const triggers = input.triggers === undefined ? defaultTriggers(role) : sanitizeTriggers(input.triggers);
    if (!triggers) return refuse('invalid_argument', 'triggers are malformed');
    const budget = sanitizeBudget(input.budget, DEFAULT_BOT_BUDGETS[role]);
    if (!budget) return refuse('invalid_argument', 'budget is malformed or over its caps');
    const repo = input.repo === undefined ? undefined : sanitizeRepo(input.repo);
    if (repo === null) return refuse('invalid_argument', 'repo must be {repoKey:"owner/repo" or "host/owner/repo", repoPath:<absolute path>}');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return refuse('invalid_argument', 'enabled must be a boolean');
    const avatar = input.avatar === undefined ? undefined : parseBotAvatar(input.avatar);
    if (avatar === null) return refuse('invalid_argument', 'avatar must be a square PNG picture');
    let id = this.newId();
    for (let i = 0; this.bots.has(id) && i < 8; i++) id = this.newId();
    if (!BOT_ID_RE.test(id) || this.bots.has(id)) return refuse('invalid_argument', 'could not mint a bot id');
    const now = this.now();
    // The first slot free among the workspace's live bots, in the spread
    // order; a removed bot's slot is free again.
    const taken = [...this.bots.values()]
      .filter((b) => b.workspaceId === workspaceId && b.hue !== undefined)
      .map((b) => ({ workspaceId, index: b.hue as number }));
    const hue = identityHueIndexes([{ id, createdAt: now, workspaceId }], taken).get(id);
    const bot: BotProfile = {
      version: 1,
      id,
      workspaceId,
      role,
      template,
      name,
      ...(job ? { job } : {}),
      engine,
      ...(workerAgent ? { workerAgent: { ...workerAgent } } : {}),
      triggers,
      budget,
      ...(repo ? { repo } : {}),
      ...(avatar ? { avatar } : {}),
      ...(hue !== undefined ? { hue } : {}),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.bots.set(id, bot);
    this.usage.set(id, emptyUsage());
    this.changed();
    return { ok: true, bot: copyProfile(bot) };
  }

  /** Change the updatable fields present in `patch`; anything else in it is
   *  refused. `repo: null` clears the repo. */
  update(botId: string, patch: Record<string, unknown>): BotStoreResult {
    const cur = this.bots.get(botId);
    if (!cur) return refuse('not_found', `no bot ${botId}`);
    const extra = Object.keys(patch).filter((k) => !(BOT_UPDATABLE_FIELDS as readonly string[]).includes(k));
    if (extra.length > 0) return refuse('invalid_argument', `cannot update ${extra.join(', ')}`);
    const next: BotProfile = { ...cur };
    if (patch.name !== undefined) {
      const name = normalizeBotName(patch.name);
      if (!name) return refuse('invalid_argument', `name must be 1-${NAME_MAX} characters, no control characters or slashes`);
      next.name = name;
    }
    if (patch.job !== undefined) {
      if (patch.job === null) {
        delete next.job;
      } else {
        const job = normalizeBotJob(patch.job);
        if (!job) return refuse('invalid_argument', `job must be 1-${BOT_JOB_MAX} characters, no control characters but newlines`);
        next.job = job;
      }
    }
    if (patch.template !== undefined) {
      if (!isBotTemplate(patch.template)) return refuse('invalid_argument', 'template must be one of coordinator, developer, reviewer, issue, researcher, custom');
      next.template = patch.template;
    }
    if (patch.engine !== undefined) {
      const engine = sanitizeBotEngine(patch.engine);
      if (!engine) return refuse('invalid_argument', 'engine is malformed (a model must be one model id: letters/digits first, then . _ : -, optionally ending in a [variant])');
      next.engine = engine;
    }
    if (patch.workerAgent !== undefined) {
      if (patch.workerAgent === null) {
        delete next.workerAgent;
      } else {
        const v = validateBotWorkerAgent(patch.workerAgent, this.platform);
        if (!v.ok) return refuse('invalid_argument', v.error);
        next.workerAgent = v.value;
      }
    }
    if (patch.triggers !== undefined) {
      const triggers = sanitizeTriggers(patch.triggers);
      if (!triggers) return refuse('invalid_argument', 'triggers are malformed');
      next.triggers = triggers;
    }
    if (patch.budget !== undefined) {
      const budget = sanitizeBudget(patch.budget, cur.budget);
      if (!budget) return refuse('invalid_argument', 'budget is malformed or over its caps');
      next.budget = budget;
    }
    if (patch.repo !== undefined) {
      if (patch.repo === null) {
        delete next.repo;
      } else {
        const repo = sanitizeRepo(patch.repo);
        if (!repo) return refuse('invalid_argument', 'repo must be {repoKey:"owner/repo" or "host/owner/repo", repoPath:<absolute path>}');
        next.repo = repo;
      }
    }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') return refuse('invalid_argument', 'enabled must be a boolean');
      next.enabled = patch.enabled;
    }
    next.updatedAt = this.now();
    this.bots.set(botId, next);
    this.changed();
    return { ok: true, bot: copyProfile(next) };
  }

  /** Set (or, with null, clear) a bot's job. The previous job comes back
   *  with the bot so the caller can offer Undo. */
  setJob(botId: string, job: unknown): (BotStoreResult & { ok: true; previous: string | null }) | Extract<BotStoreResult, { ok: false }> {
    const cur = this.bots.get(botId);
    if (!cur) return refuse('not_found', `no bot ${botId}`);
    const r = this.update(botId, { job });
    return r.ok ? { ...r, previous: cur.job ?? null } : r;
  }

  /** Set (or, with null, clear) a bot's picture. Only the main window's
   *  FACTORY_BOT_SET_AVATAR calls this. */
  setAvatar(botId: string, avatar: unknown): BotStoreResult {
    const cur = this.bots.get(botId);
    if (!cur) return refuse('not_found', `no bot ${botId}`);
    const next: BotProfile = { ...cur };
    if (avatar === null) {
      delete next.avatar;
    } else {
      const parsed = parseBotAvatar(avatar);
      if (!parsed) return refuse('invalid_argument', 'avatar must be a square PNG picture');
      next.avatar = parsed;
    }
    next.updatedAt = this.now();
    this.bots.set(botId, next);
    this.changed();
    return { ok: true, bot: copyProfile(next) };
  }

  /** Delete a profile, keeping its tombstone with its colour slot (its
   *  stored one; `hue`, the remover's, only for a profile without one). */
  remove(botId: string, opts: { hue?: number } = {}): boolean {
    const cur = this.bots.get(botId);
    if (!cur || !this.bots.delete(botId)) return false;
    this.usage.delete(botId);
    const tomb = parseRemovedBot({
      id: cur.id, workspaceId: cur.workspaceId, role: cur.role, template: cur.template, name: cur.name,
      avatar: cur.avatar, hue: cur.hue ?? opts.hue, removedAt: this.now(),
    });
    this.removed = this.removed.filter((r) => r.id !== botId);
    if (tomb) this.removed = [...this.removed, tomb].slice(-REMOVED_BOTS_MAX);
    this.changed();
    return true;
  }

  /** The removed bots remembered, oldest first (copies). */
  listRemoved(): RemovedBot[] {
    return this.removed.map((r) => ({ ...r }));
  }

  /** Park (or, with null, unpark) a bot. */
  setParked(botId: string, parked: BotProfile['parked'] | null): BotProfile | null {
    const cur = this.bots.get(botId);
    if (!cur) return null;
    const next: BotProfile = { ...cur, updatedAt: this.now() };
    if (parked) next.parked = { reason: parked.reason, at: parked.at, ...(parked.reason === 'error' && parked.until !== undefined ? { until: parked.until } : {}) };
    else delete next.parked;
    this.bots.set(botId, next);
    this.changed();
    return copyProfile(next);
  }

  /** The bot's usage (a copy, pruned to the windows). */
  usageOf(botId: string): BotUsage {
    const u = this.usage.get(botId);
    if (!u) return emptyUsage();
    return pruneUsage(sanitizeUsage(JSON.parse(JSON.stringify(u))), this.now());
  }

  /** Mutate a bot's usage and persist. No-op for an unknown bot. */
  mutateUsage(botId: string, fn: (usage: BotUsage) => void): void {
    if (!this.bots.has(botId)) return;
    const u = this.usage.get(botId) ?? emptyUsage();
    fn(u);
    this.usage.set(botId, u);
    void this.persister.schedule().catch((err) => console.warn(`[factory] bots.json write failed: ${String(err)}`));
  }
}

function refuse(code: BotStoreRefusal, message: string): { ok: false; code: BotStoreRefusal; message: string } {
  return { ok: false, code, message };
}

let current: BotStore | null = null;

/** Set by the bot runtime module's start(). */
export function setBotStore(store: BotStore | null): void {
  current = store;
}

export function getBotStore(): BotStore | null {
  return current;
}

/** The bot directory for the trigger engine, or null before the factory started. */
export function getBotDirectory(): BotDirectoryApi | null {
  return current;
}
