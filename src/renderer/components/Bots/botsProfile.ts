// ─── What a bot can do (pure) ─────────────────────────────────────────────
//
// Every bot holds the same powers, the shared surface (shared/botSurface.ts
// SHARED_SURFACE); a Coordinator-template bot may also read other
// workspaces' rooms and facts. The profile shows them, it never edits them.
// Each owner phrase stands for the surface tools behind it and is shown only
// when the surface holds one of them, so the list can never claim a power
// the surface lacks. Tools that only read the factory's own event feeds have
// no phrase.

import { isCoordinatorBot, type BotEngine, type BotProfile, type BotRole, type BotTemplate, type BotWorkerAgent } from '../../../shared/bot';
import { SHARED_SURFACE, type BotToolName } from '../../../shared/botSurface';
import { CLAUDE_EFFORT_LEVELS, claudeModelLabel } from '../../../shared/claudeModels';
import { validateBotBrainModel, validateFanoutModel } from '../../../shared/fanoutPreset';
import { DEFAULT_BOT_WORKER_AGENT, botWorkerAgentLabel, validateBotWorkerAgent } from '../../../shared/botWorkerAgent';

/** Owner phrases in display order: the i18n key and the tools it stands for. */
export const CAN_DO_PHRASES: ReadonlyArray<{ key: string; tools: readonly BotToolName[] }> = [
  { key: 'botsPage.canDo.talk', tools: ['room_post', 'room_read', 'handoff_send', 'bot_list'] },
  { key: 'botsPage.canDo.ask', tools: ['ask_person', 'question_close'] },
  { key: 'botsPage.canDo.fanout', tools: ['fanout_start', 'worker_resume', 'worker_message'] },
  { key: 'botsPage.canDo.workspaces', tools: ['workspace_list'] },
  { key: 'botsPage.canDo.terminals', tools: ['terminal_read'] },
  { key: 'botsPage.canDo.tasks', tools: ['ledger_update'] },
  { key: 'botsPage.canDo.read', tools: ['pr_read', 'issue_read', 'ci_read', 'verdict_read', 'trust_metrics_read'] },
  { key: 'botsPage.canDo.verdict', tools: ['pr_verdict'] },
  { key: 'botsPage.canDo.plan', tools: ['plan_propose'] },
  { key: 'botsPage.canDo.job', tools: ['job_set'] },
  { key: 'botsPage.canDo.routines', tools: ['routine_set', 'routine_list', 'routine_pause'] },
  { key: 'botsPage.canDo.skills', tools: ['skill_propose', 'skill_read'] },
  { key: 'botsPage.canDo.stop', tools: ['stop_my_work'] },
  { key: 'botsPage.canDo.approval', tools: ['approval_request', 'approval_list'] },
  { key: 'botsPage.canDo.secrets', tools: ['secret_request', 'secret_list', 'login_request'] },
];

/** The Coordinator template's one extra power (reads in every workspace). */
export const CAN_DO_COORDINATOR = 'botsPage.canDo.coordinator';

/** Surface tools with no owner phrase: event feeds the bot reads to follow
 *  the factory, not powers the owner grants. */
export const CAN_DO_UNLISTED: ReadonlySet<BotToolName> = new Set<BotToolName>(['fact_poll']);

/** The i18n keys of what a bot can do, in display order. Pure. */
export function botCanDo(bot: { role: BotRole; template?: BotTemplate }): string[] {
  const keys = CAN_DO_PHRASES.filter((p) => p.tools.some((tool) => SHARED_SURFACE.tools.has(tool))).map((p) => p.key);
  return isCoordinatorBot(bot) ? [...keys, CAN_DO_COORDINATOR] : keys;
}

// ── Models: what the bot thinks on and what its workers run on ──────────────
//
// The bot's own model and effort are its claude-sdk engine's (BotEngine);
// its workers' are `workerAgent`. Main checks both again on save
// (main/factory/botStore.ts); the profile refuses a bad model id first, with
// the same rules (shared/fanoutPreset.ts validateBotBrainModel for the bot's
// own, validateFanoutModel for its workers'). A stored model of the bot's own
// that fails its rule is kept on disk but not used; the profile warns of it.

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A model id as the profile shows it, trimmed (a stored id is kept as
 *  written): the catalog's name for a Claude model, else the id. Pure. */
export function botModelName(agent: string, model: string): string {
  const id = model.trim();
  return agent === DEFAULT_BOT_WORKER_AGENT ? claudeModelLabel(id) : id;
}

/** The bot list's and roster's one-line note of its models: its own and
 *  its workers', only what the owner (or its template) set. '' when both
 *  are on the defaults. Pure. */
export function botModelSummary(bot: Pick<BotProfile, 'engine' | 'workerAgent'>, t: T): string {
  const parts: string[] = [];
  if (bot.engine.kind === 'claude-sdk' && bot.engine.model && !unusableBrainModel(bot.engine)) parts.push(botModelName(DEFAULT_BOT_WORKER_AGENT, bot.engine.model));
  const w = bot.workerAgent;
  if (w?.model) parts.push(t('botsPage.models.workersOn', { model: botModelName(w.agent, w.model) }));
  else if (w && w.agent !== DEFAULT_BOT_WORKER_AGENT) parts.push(t('botsPage.models.workersOn', { model: botWorkerAgentLabel(w.agent) }));
  return parts.join(' · ');
}

/** The bot's stored model when it fails the brain model rule, so the bot
 *  runs on the default model instead (main/factory/botEngines.ts), else
 *  null. Pure. */
export function unusableBrainModel(engine: BotEngine): string | null {
  if (engine.kind !== 'claude-sdk' || !engine.model) return null;
  return validateBotBrainModel(engine.model).ok ? null : engine.model;
}

/** The engine the brain picker saves: claude-sdk with the model and effort
 *  ('' = the default), or the reason the model is refused. Pure. */
export function brainEngine(model: string, effort: string): { ok: true; engine: BotEngine } | { ok: false; model: string } {
  const typed = model.trim();
  const checked = typed ? validateBotBrainModel(typed) : null;
  if (checked && !checked.ok) return { ok: false, model: typed };
  const level = (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effort) ? effort : '';
  return { ok: true, engine: { kind: 'claude-sdk', ...(checked?.ok ? { model: checked.model } : {}), ...(level ? { effort: level } : {}) } };
}

/** The `workerAgent` the workers picker saves: null when it is the default
 *  agent with no model or effort, else the pick as main's validator reads
 *  it; refused with the validator's reason otherwise (a bad model id is
 *  `model`, for the profile's own words). Pure. */
export function workerAgentPick(agent: string, model: string, effort: string): { ok: true; workerAgent: BotWorkerAgent | null } | { ok: false; model?: string; error: string } {
  const slug = agent || DEFAULT_BOT_WORKER_AGENT;
  const typed = model.trim();
  if (slug === DEFAULT_BOT_WORKER_AGENT && !typed && !effort) return { ok: true, workerAgent: null };
  if (typed && !validateFanoutModel(typed).ok) return { ok: false, model: typed, error: `model "${typed}" is not a model id` };
  const v = validateBotWorkerAgent({ agent: slug, ...(typed ? { model: typed } : {}), ...(effort ? { effort } : {}) });
  return v.ok ? { ok: true, workerAgent: v.value } : { ok: false, error: v.error };
}
