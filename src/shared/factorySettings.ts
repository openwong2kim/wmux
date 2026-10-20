// ─── Factory settings — the shape of `<wmuxDir>/factory/settings.json` ─────
//
// Shared so the renderer (the Factory settings tab) reads the same type main
// writes. Main sanitises every field on read and on update
// (main/factory/factorySettings.ts); this file holds the shape and defaults
// only.

import { DEFAULT_BOT_ENGINE, type BotEngine } from './bot';
import { WAKE_LIMITS } from './wake';

export const FACTORY_SETTINGS_VERSION = 1 as const;

/** The version of the "Bots run on your Claude account" consent. Turning bots
 *  on needs the owner's consent at this version (main refuses otherwise);
 *  raise it when what the owner agrees to changes, and everyone is asked
 *  again. */
export const BOTS_PLAN_CONSENT_VERSION = 1;

/** The owner agreed, at `at` (ISO time), that bots run on their own Claude
 *  plan: the brain on the Claude Code sign-in here, the workers on their own
 *  Claude Code. */
export interface BotsPlanConsent {
  version: number;
  at: string;
}

/** True when `s` holds the owner's consent at the current version. Pure. */
export function hasBotsPlanConsent(s: { planConsent?: BotsPlanConsent | null } | null | undefined): boolean {
  return s?.planConsent?.version === BOTS_PLAN_CONSENT_VERSION;
}

/** How a Claude (SDK) bot's brain signs in: the owner's Claude
 *  subscription (the Claude Code sign-in here) or a Claude API key the
 *  owner saved in Settings › Bots (main/factory/claudeApiKey.ts). Bots only:
 *  the workspace brain always runs on the subscription. */
export type ClaudeAuthMode = 'subscription' | 'apiKey';

/** The mode `s` asks for (absent: the subscription). Pure. */
export function botClaudeAuthMode(s: { claudeAuth?: ClaudeAuthMode } | null | undefined): ClaudeAuthMode {
  return s?.claudeAuth === 'apiKey' ? 'apiKey' : 'subscription';
}

export interface FactorySettings {
  version: typeof FACTORY_SETTINGS_VERSION;
  enabled: boolean;
  /** Moa's HQ workspace from older builds. Kept readable for compatibility;
   *  nothing uses it (no workspace is special, owner decision 2026-10-14). */
  hqWorkspaceId: string | null;
  /** GitHub logins whose PRs wake the Verifier (the owner's login included). */
  trustedAuthors: string[];
  /** Local hour (0-23) and weekdays (0 = Sunday … 6) of the morning wake. */
  morning: { hour: number; weekdays: number[] };
  verifierOnOwnerPrs: boolean;
  defaultEngine: BotEngine;
  /** Bots running a turn at the same time, factory-wide (1-5). */
  globalConcurrentBots: number;
  /** Agents running at once, bots and workers together (2-16): a bot turn,
   *  an open fan-out task's worker, a resumed worker. A bot's new worker past
   *  it waits for a slot (main/factory/agentSlots.ts); the owner's own work
   *  never waits. */
  maxConcurrentAgents: number;
  /** The merge lane merges a bot PR by itself once every predicate passes.
   *  Off: the lane posts a ready-to-merge card and the owner merges. */
  laneAutoMerge: boolean;
  /** Most lane merges per local day (0-50). */
  laneDailyCap: number;
  /** A bot's command that passed the floor but is not on its list is judged
   *  by the command reviewer (a small model, main/factory/
   *  botCommandReviewer.ts) and runs when it allows it. Off: such a command
   *  is refused. On by default. */
  botCommandReviewer: boolean;
  /** Isolated-instance smoke only: every bot runs on the scripted ACP stub. */
  acpStub?: boolean;
  /** The bot the phone talks to (`/api/moa/messages`), pinned in Settings ›
   *  Bots. Absent: the oldest enabled Coordinator-template bot, else the
   *  oldest enabled bot (main/factory/phoneBot.ts). */
  phoneBotId?: string;
  /** The owner's consent that bots run on their own Claude plan. Absent on
   *  a file from before the consent existed (bots that were on stay on; the
   *  Bots page asks once). */
  planConsent?: BotsPlanConsent;
  /** Bots run on a Claude API key instead of the subscription. Absent: the
   *  subscription (every file from before this setting). */
  claudeAuth?: ClaudeAuthMode;
}

export const FACTORY_CONCURRENT_BOTS_MIN = 1;
export const FACTORY_CONCURRENT_BOTS_MAX = 5;
export const FACTORY_LANE_DAILY_CAP_MAX = 50;
export const FACTORY_MAX_AGENTS_MIN = 2;
export const FACTORY_MAX_AGENTS_MAX = 16;
/** Three bots in a turn and three live workers: the default bot and worker
 *  caps side by side (about 2.3 GiB of agent and MCP memory measured on
 *  macOS arm64, bench/bot-memory.md). */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 6;

export const DEFAULT_FACTORY_SETTINGS: Readonly<FactorySettings> = Object.freeze({
  version: FACTORY_SETTINGS_VERSION,
  enabled: false,
  hqWorkspaceId: null,
  trustedAuthors: [],
  morning: { hour: 9, weekdays: [1, 2, 3, 4, 5] },
  verifierOnOwnerPrs: true,
  defaultEngine: DEFAULT_BOT_ENGINE,
  globalConcurrentBots: WAKE_LIMITS.GLOBAL_CONCURRENT_BOTS,
  maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
  laneAutoMerge: false,
  laneDailyCap: 5,
  botCommandReviewer: true,
});
