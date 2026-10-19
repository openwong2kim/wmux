// ─── Adding a bot (Bots page, Settings › Factory) ───────────────────────────
//
// The renderer asks main (IPC.FACTORY_BOT_CREATE) for one bot: a workspace
// and a name, and optionally a picture, a job and a template that prefilled
// the job. Any number of bots, of any template, may share a workspace. The
// repository is optional: a workspace works on one repository, so once one
// of its bots has a repo a new bot there takes that repo; otherwise the
// folder the owner picked (or main's suggestion of the workspace's own
// folder, IPC.FACTORY_BOT_SUGGEST_REPO) is resolved to its git root and
// keyed by its `origin` remote, and a folder naming another repository than
// the workspace's is refused. A bot without a repository still talks; its
// fan-outs are refused until it has one. The picture is a preview main made
// with IPC.FACTORY_BOT_PICK_AVATAR (main checks it again). Everything else
// (engine, triggers, budget) takes the store's defaults, as `bot.create`
// does. A bot added here wakes once on its own (wake reason `intro`) to greet
// the owner and ask what to do.
//
// A bot's picture is changed later with IPC.FACTORY_BOT_SET_AVATAR. Both
// avatar channels answer the main window only; the pipe's bot.* methods
// never take or return a picture.

import type { BotProfile, BotRole, BotTemplate } from './bot';

export interface FactoryBotCreateRequest {
  workspaceId: string;
  /** The owner's name for the bot (shared/bot.ts normalizeBotName). */
  name?: string;
  /** The template the owner picked (it prefilled `job`); absent = custom. */
  template?: BotTemplate;
  /** The job text (shared/bot.ts normalizeBotJob); absent = none yet. */
  job?: string;
  /** @deprecated legacy tag; derived from the template when absent. */
  role?: BotRole;
  /** The folder the owner picked (or main's suggestion); ignored when a bot
   *  of the workspace already has a repo (then it is that one). Absent and
   *  nothing to inherit: the bot has no repository yet. */
  repoFolder?: string;
  /** A picture from FACTORY_BOT_PICK_AVATAR (BotProfile.avatar's shape). */
  avatar?: string;
}

export type FactoryBotCreateCode =
  | 'operator_only'
  | 'not_started'
  | 'invalid_argument'
  | 'duplicate_role'
  | 'too_many_bots'
  | 'not_found'
  | 'not_a_repo'
  | 'repo_untrusted'
  | 'no_remote'
  | 'repo_mismatch';

export type FactoryBotCreateResult =
  | { ok: true; bot: BotProfile }
  | { ok: false; code: FactoryBotCreateCode; message: string };

/** The bots "Add team" makes, in the order they are made: the coordinator
 *  first (it is then the room's oldest coordinator, its lead). */
export const TEAM_TEMPLATES: readonly BotTemplate[] = ['coordinator', 'researcher', 'developer', 'issue', 'reviewer'];

/** IPC.FACTORY_BOT_CREATE_TEAM: the five bots of a team in one workspace,
 *  on one repository (as "Add bot" resolves it), named by the renderer (in
 *  the owner's language). Refused, before any bot is made, when a name is
 *  not one the store keeps or is taken (twice in the team, or by a bot of
 *  the workspace), or when the workspace already has an enabled
 *  coordinator. All five are made or none. Only the coordinator greets the
 *  owner. */
export interface FactoryBotCreateTeamRequest {
  workspaceId: string;
  /** One name per team template. */
  names: Record<string, string>;
  /** As FactoryBotCreateRequest.repoFolder. */
  repoFolder?: string;
}

export type FactoryBotCreateTeamResult =
  | { ok: true; bots: BotProfile[] }
  | { ok: false; code: FactoryBotCreateCode | 'has_lead' | 'name_taken'; message: string };

/** @deprecated legacy Add-bot rule (the HQ Moa took no repository); the
 *  repository is optional for every bot. */
export function roleWorksOnRepo(role: BotRole): boolean {
  return role !== 'moa';
}

/** FACTORY_BOT_SUGGEST_REPO: the repository "Add bot" offers for a
 *  workspace. `inherited`: a bot of the workspace already works on it, so a
 *  new repo bot there takes it. Otherwise it is the workspace's current
 *  folder as main tracks it, resolved like a picked folder. `displayRoot` is
 *  `root` with the home folder shortened to `~`. */
export type FactoryBotRepoSuggestion =
  | { ok: true; repoKey: string; root: string; displayRoot: string; inherited: boolean }
  | { ok: false; code: 'operator_only' | 'invalid_argument' | 'no_folder' | 'not_a_repo' | 'repo_untrusted' | 'no_remote' };

/** FACTORY_BOT_PICK_AVATAR: the picked image as a stored-avatar preview (not
 *  saved yet), or why there is none. */
export type FactoryBotAvatarPickResult =
  | { ok: true; avatar: string }
  | { ok: false; code: 'cancelled' | 'unreadable' | 'too_large' | 'operator_only' };

export type FactoryBotAvatarSetCode = 'operator_only' | 'not_started' | 'invalid_argument' | 'not_found';

/** FACTORY_BOT_SET_AVATAR: the bot as saved, or the refusal. */
export type FactoryBotAvatarSetResult =
  | { ok: true; bot: BotProfile }
  | { ok: false; code: FactoryBotAvatarSetCode; message: string };
