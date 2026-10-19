// ─── What a bot's fan-out workers run on ────────────────────────────────────
//
// A bot thinks on its own engine (BotProfile.engine); its fan-out workers run
// on the bot presets' engine, Claude Code, unless the owner picked another in
// the bot's profile (BotProfile.workerAgent). The pick is a slug from fan-out's
// closed agent table (shared/fanoutPreset.ts FANOUT_AGENTS) with an optional
// model and effort, validated the same way a caller's `agents[k]` is — and only
// for an agent that has a bot-worker guard (claude: the worker settings;
// codex: main/agents/codexWorkerGuard.ts). Main applies it server-side to
// every task of a bot's fan-out; the bot never names an engine.

import type { BotWorkerAgent } from './bot';
import { fanoutAgentSpec, fanoutEffortIgnored, validateFanoutAgentChoice, type FanoutAgentChoice } from './fanoutPreset';

/** The agents a bot's worker may run on: the ones with a bot-worker guard. */
export const BOT_WORKER_AGENTS: readonly string[] = ['claude', 'codex'];

/** The default engine of a bot's workers (the bot presets' row). */
export const DEFAULT_BOT_WORKER_AGENT = 'claude';

/** A worker agent the bot store accepts, or an English reason it does not.
 *  With `platform`, an agent whose worker guard does not run there is refused
 *  too (a save; a read keeps a pick another host made). Pure. */
export function validateBotWorkerAgent(raw: unknown, platform?: string): { ok: true; value: BotWorkerAgent } | { ok: false; error: string } {
  const v = validateFanoutAgentChoice(raw, { allowEffort: true });
  if (!v.ok) return { ok: false, error: `workerAgent: ${v.error}` };
  if (!BOT_WORKER_AGENTS.includes(v.choice.agent)) {
    return { ok: false, error: `workerAgent: ${v.choice.agent} has no bot-worker guard yet — use one of ${BOT_WORKER_AGENTS.join(', ')}` };
  }
  if (platform !== undefined && !botWorkerAgentSupported(v.choice.agent, platform)) {
    return { ok: false, error: `workerAgent: ${botWorkerAgentLabel(v.choice.agent)} workers are not available on ${platform === 'win32' ? 'Windows' : platform} yet — their guard runs on macOS and Linux only` };
  }
  const ignored = fanoutEffortIgnored(v.choice);
  if (ignored) return { ok: false, error: `workerAgent: ${ignored}` };
  return {
    ok: true,
    value: { agent: v.choice.agent, ...(v.choice.model ? { model: v.choice.model } : {}), ...(v.choice.effort ? { effort: v.choice.effort } : {}) },
  };
}

/** The display name of a worker agent (Settings' table), or the slug. Pure. */
export function botWorkerAgentLabel(agent: string): string {
  return fanoutAgentSpec(agent)?.label ?? agent;
}

/** A bot fan-out's per-task rows with the owner's pick applied: every row on
 *  the picked agent (the preset's rows otherwise). The pick's model and
 *  effort are defaults: a row already on that agent keeps the model and
 *  effort it pins itself. Pure. */
export function withBotWorkerAgent(rows: readonly FanoutAgentChoice[], workerAgent: BotWorkerAgent | undefined): FanoutAgentChoice[] {
  if (!workerAgent) return [...rows];
  return rows.map((row) => {
    const own: Partial<FanoutAgentChoice> = row.agent === workerAgent.agent ? row : {};
    const model = own.model ?? workerAgent.model;
    const effort = own.effort ?? workerAgent.effort;
    return { agent: workerAgent.agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  });
}

/** One engine a bot's workers may run on, as the profile offers it. */
export interface BotWorkerAgentOption {
  agent: string;
  label: string;
  /** Its CLI is found on the login shell's PATH here. */
  installed: boolean;
  /** Its worker guard runs on this platform (codex's is POSIX only). */
  supported: boolean;
}

/** Agents whose worker guard runs on POSIX hosts only (codex's: measured on
 *  macOS, refused on Windows by main/agents/codexWorkerGuard.ts). */
const POSIX_ONLY_WORKER_AGENTS: ReadonlySet<string> = new Set(['codex']);

/** Does this agent's worker guard run on `platform`? Pure. */
export function botWorkerAgentSupported(agent: string, platform: string): boolean {
  return BOT_WORKER_AGENTS.includes(agent) && !(platform === 'win32' && POSIX_ONLY_WORKER_AGENTS.has(agent));
}
