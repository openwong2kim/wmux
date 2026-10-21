// ─── Bots the owner adds ───────────────────────────────────────────────────
//
// `createBotFromFolder` is "Add bot" (the Bots page, Settings › Factory): a
// workspace and a name, optionally a picture, a job and the template that
// prefilled it, and a folder. Any number of bots, of any template, may share
// a workspace. The repository is optional: a workspace works on one
// repository, so when one of its bots already has a repo a new bot there
// takes that repo without a folder, and a folder naming another repository
// is refused (`repo_mismatch`); otherwise a folder becomes the bot's repo as
// fan-out needs it: the git root, realpath'd (fanout.rpc.ts refuses any
// other repoPath), keyed by its `origin` remote read now (never a cached
// answer, so adding a remote and retrying works). Without either, the bot
// has no repository yet. The profile itself goes through BotStore.create,
// the same validation and defaults as `bot.create`. `suggestBotRepo` is what
// "Add bot" offers before that: the sibling's repo, else the workspace's
// current folder (the active pane's shell cwd main tracks, else the folder
// the workspace mirror records), resolved like a picked folder.
//
// A bot added here wakes once on its own (`greetNewBot`, wake reason
// `intro`): it greets the owner and asks what to do, with choices.
//
// `createTeamFromFolder` is "Add team": the bots of TEAM_TEMPLATES the
// workspace does not have yet (all five for a new team), the coordinator
// first, on one repository resolved once, names checked (and refused when
// taken) before any bot is made.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BotProfile, BotTemplate } from '../../shared/bot';
import { normalizeBotName } from '../../shared/bot';
import { TEAM_TEMPLATES, teamTemplatesPresent, type FactoryBotCreateResult, type FactoryBotCreateTeamResult, type FactoryBotRepoSuggestion } from '../../shared/botCreate';
import { BOTS_MAX } from './botStore';
import type { WakeItem } from '../../shared/wake';
import { normalizeRepoKey } from '../../shared/repoKey';
import { getWmuxHomeDir } from '../../shared/constants';
import { dmThreadId } from '../../shared/room';
import { git as runGit, type GitResult } from '../git/git';
import { dubiousOwnership, dubiousOwnershipMessage } from '../git/dubiousOwnership';
import { parseRemoteKey } from '../github/PrProvider';
import { readRawOriginUrl } from '../worktask/workerGit';
import { isOriginPin } from '../../shared/originPin';
import type { WorkspaceListEntry } from '../../shared/workspaceMirror';
import type { BotStore } from './botStore';
import type { WakeEnqueueInput } from './wakeQueue';

export interface BotRepoDeps {
  git?: (args: string[], cwd: string) => Promise<GitResult>;
  realpath?: (p: string) => string;
}

export type BotRepoResult =
  | { ok: true; repo: { repoKey: string; repoPath: string; originPin?: string } }
  | { ok: false; code: 'invalid_argument' | 'not_a_repo' | 'repo_untrusted' | 'no_remote'; message: string };

/** A repository inside WSL (`\\wsl.localhost\<distro>\…`, `\\wsl$\…`): its bot's
 *  task worktrees on Windows are checked by their own path too, so the hint
 *  names wmux's task folder root. */
/** What a linked repository needs, said with every no_remote refusal. */
const NEEDS_HOSTED_ORIGIN =
  'A bot pushes its work to origin and opens pull requests there, so origin must be an https or ssh address of an owner/repo repository, such as https://github.com/<owner>/<repo>.git. A local path or a bare repository on disk cannot be used. Set it with "git remote set-url origin <address>" (or "git remote add origin <address>") and choose the folder again.';

function taskFoldersFor(folder: string): string | undefined {
  return /^(?:\\\\|\/\/)(?:wsl\$|wsl\.localhost)[\\/]/i.test(folder) ? path.join(getWmuxHomeDir(), 'worktrees') : undefined;
}

/** The bot repo a picked folder names: its git root and origin's repo key. */
export async function resolveBotRepo(folder: unknown, deps: BotRepoDeps = {}): Promise<BotRepoResult> {
  if (typeof folder !== 'string' || folder.length === 0 || folder.length > 4096 || !path.isAbsolute(folder)) {
    return { ok: false, code: 'invalid_argument', message: 'Pick a repository folder.' };
  }
  const git = deps.git ?? runGit;
  const realpath = deps.realpath ?? ((p: string) => fs.realpathSync(p));
  const top = await git(['rev-parse', '--show-toplevel'], folder).catch(() => null);
  const root = top && top.code === 0 ? top.stdout.trim() : '';
  if (!root) {
    // A repository git will not open (another user's: every WSL one, for Git
    // for Windows) is not "not a checkout": say what to run.
    const untrusted = top ? dubiousOwnership(top.stderr, folder) : null;
    if (untrusted) return { ok: false, code: 'repo_untrusted', message: dubiousOwnershipMessage(folder, untrusted.command, taskFoldersFor(folder)) };
    return { ok: false, code: 'not_a_repo', message: `${folder} is not a git checkout.` };
  }
  let repoPath = root;
  try {
    repoPath = realpath(root);
  } catch {
    /* kept as git printed it */
  }
  const remote = await git(['remote', 'get-url', 'origin'], repoPath).catch(() => null);
  const url = remote && remote.code === 0 ? remote.stdout.trim() : '';
  const untrustedRoot = !url && remote ? dubiousOwnership(remote.stderr, repoPath) : null;
  if (untrustedRoot) return { ok: false, code: 'repo_untrusted', message: dubiousOwnershipMessage(repoPath, untrustedRoot.command, taskFoldersFor(repoPath)) };
  // The refusal says what a bot needs, not only what is missing: the folder
  // picker is the only way to link a repository, so the person has to learn
  // here that the fix is in the repository's own remote (#2296 E2E, F1).
  if (!url) return { ok: false, code: 'no_remote', message: `${repoPath} has no origin remote. ${NEEDS_HOSTED_ORIGIN}` };
  // The key and the pin come from origin's URL as the repository config holds
  // it, the address task_push compares against (an owner's `url.*.insteadOf`
  // is applied by get-url only); get-url's when that one names no repository.
  const raw = await readRawOriginUrl(git, repoPath);
  const rawKey = raw === null ? null : normalizeRepoKey(parseRemoteKey(raw));
  const repoKey = rawKey ?? normalizeRepoKey(parseRemoteKey(url));
  if (!repoKey) return { ok: false, code: 'no_remote', message: `The origin remote of ${repoPath} is not an owner/repo address on a git host. ${NEEDS_HOSTED_ORIGIN}` };
  const originPin = rawKey && isOriginPin(raw) ? raw : null;
  return { ok: true, repo: { repoKey, repoPath, ...(originPin ? { originPin } : {}) } };
}

/** The repo a workspace's bots already work on (its oldest repo bot's), or
 *  null when none has one. */
export function workspaceRepo(store: BotStore, workspaceId: unknown): { repoKey: string; repoPath: string; originPin?: string } | null {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return null;
  const withRepo = store.list({ workspaceId }).filter((b) => b.repo).sort((a, b) => a.createdAt - b.createdAt);
  return withRepo[0]?.repo ? { ...withRepo[0].repo } : null;
}

/** One bot for "Add bot". */
export async function createBotFromFolder(
  store: BotStore | null,
  req: unknown,
  deps: BotRepoDeps = {},
): Promise<FactoryBotCreateResult> {
  if (!store) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
  const r = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
  let repo: { repoKey: string; repoPath: string; originPin?: string } | undefined;
  if (r.repoFolder === undefined) {
    // No folder: the workspace's repo, when one of its bots has one.
    const inherited = workspaceRepo(store, r.workspaceId);
    if (inherited) repo = inherited;
  } else {
    const resolved = await resolveBotRepo(r.repoFolder, deps);
    if (!resolved.ok) return resolved;
    // Read after the await: a bot added meanwhile counts.
    const current = workspaceRepo(store, r.workspaceId);
    if (current && current.repoKey !== resolved.repo.repoKey) {
      return {
        ok: false,
        code: 'repo_mismatch',
        message: `This workspace's bots work on ${current.repoKey} (${current.repoPath}); ${resolved.repo.repoPath} is ${resolved.repo.repoKey}. A workspace works on one repository.`,
      };
    }
    repo = current ?? resolved.repo;
  }
  // The name, job, template, role, recipe and picture are checked by the store
  // (shared/bot.ts normalizeBotName / normalizeBotJob, botAvatar.ts), as on
  // every other write.
  const created = store.create({
    workspaceId: r.workspaceId,
    ...(r.template !== undefined ? { template: r.template } : {}),
    ...(r.role !== undefined ? { role: r.role } : {}),
    ...(repo ? { repo } : {}),
    ...(r.name !== undefined ? { name: r.name } : {}),
    ...(r.job !== undefined ? { job: r.job } : {}),
    ...(r.recipe !== undefined ? { recipe: r.recipe } : {}),
    ...(r.avatar !== undefined ? { avatar: r.avatar } : {}),
  });
  return created.ok ? { ok: true, bot: created.bot } : created;
}

/** The repo patch for an existing bot's "Change" (the Bots page profile):
 *  the folder resolved exactly as "Add bot" resolves it (git root, origin's
 *  owner/repo, never a local-path origin), refused when another bot of its
 *  workspace works on another repository (a workspace works on one). */
export async function botRepoFromFolder(
  store: BotStore,
  botId: string,
  folder: unknown,
  deps: BotRepoDeps = {},
): Promise<BotRepoResult | { ok: false; code: 'not_found' | 'repo_mismatch'; message: string }> {
  const bot = store.get(botId);
  if (!bot) return { ok: false, code: 'not_found', message: `no bot ${botId}` };
  const resolved = await resolveBotRepo(folder, deps);
  if (!resolved.ok) return resolved;
  // Read after the await: a bot changed meanwhile counts.
  const others = store.list({ workspaceId: bot.workspaceId }).filter((b) => b.id !== botId && b.repo).sort((a, b) => a.createdAt - b.createdAt);
  const current = others[0]?.repo;
  if (current && current.repoKey !== resolved.repo.repoKey) {
    return {
      ok: false,
      code: 'repo_mismatch',
      message: `This workspace's other bots work on ${current.repoKey} (${current.repoPath}); ${resolved.repo.repoPath} is ${resolved.repo.repoKey}. A workspace works on one repository.`,
    };
  }
  return resolved;
}

/** "Add team": the team bots the workspace is missing, coordinator first,
 *  one repository. A whole team already there makes nothing (ok, `bots`
 *  empty). */
export async function createTeamFromFolder(
  store: BotStore | null,
  req: unknown,
  deps: BotRepoDeps = {},
): Promise<FactoryBotCreateTeamResult> {
  if (!store) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
  const r = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
  const workspaceId = r.workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return { ok: false, code: 'invalid_argument', message: 'workspaceId must be a workspace id' };
  const raw = r.names && typeof r.names === 'object' && !Array.isArray(r.names) ? (r.names as Record<string, unknown>) : {};
  // The templates to make: those no bot of the workspace has yet. Read
  // before the repository is resolved and again after it (a bot added
  // meanwhile counts).
  const missing = (): BotTemplate[] => {
    const present = teamTemplatesPresent(store.list({ workspaceId }));
    return TEAM_TEMPLATES.filter((tpl) => !present.includes(tpl));
  };
  const named = (templates: readonly BotTemplate[]): FactoryBotCreateTeamResult | string[] => {
    const out: string[] = [];
    for (const template of templates) {
      const name = normalizeBotName(raw[template]);
      if (!name) return { ok: false, code: 'invalid_argument', message: `the ${template} needs a name` };
      out.push(name);
    }
    return out;
  };
  const refusal = (names: readonly string[]): FactoryBotCreateTeamResult | null => {
    const key = (n: string) => n.toLocaleLowerCase();
    const taken = new Set(store.list({ workspaceId }).map((b) => key(b.name)));
    const seen = new Set<string>();
    for (const name of names) {
      if (taken.has(key(name)) || seen.has(key(name))) return { ok: false, code: 'name_taken', message: `${name} is already a bot's name in this workspace` };
      seen.add(key(name));
    }
    if (store.list().length + names.length > BOTS_MAX) return { ok: false, code: 'too_many_bots', message: `at most ${BOTS_MAX} bots` };
    return null;
  };
  const firstNames = named(missing());
  if (!Array.isArray(firstNames)) return firstNames;
  const early = refusal(firstNames);
  if (early) return early;
  // One repository for all five, resolved once, as "Add bot" resolves it.
  let repo = workspaceRepo(store, workspaceId) ?? undefined;
  if (r.repoFolder !== undefined) {
    const resolved = await resolveBotRepo(r.repoFolder, deps);
    if (!resolved.ok) return resolved;
    // Read after the await: a bot added meanwhile counts.
    const current = workspaceRepo(store, workspaceId);
    if (current && current.repoKey !== resolved.repo.repoKey) {
      return { ok: false, code: 'repo_mismatch', message: `This workspace's bots work on ${current.repoKey}; ${resolved.repo.repoPath} is ${resolved.repo.repoKey}. A workspace works on one repository.` };
    }
    repo = current ?? resolved.repo;
  }
  const templates = missing();
  const names = named(templates);
  if (!Array.isArray(names)) return names;
  const late = refusal(names);
  if (late) return late;
  const skipped = TEAM_TEMPLATES.filter((tpl) => !templates.includes(tpl));
  // Made in one go, with no await between them: nothing else is added in between.
  const bots: BotProfile[] = [];
  for (const [i, template] of templates.entries()) {
    const made = store.create({ workspaceId, template, name: names[i], ...(repo ? { repo } : {}) });
    if (!made.ok) {
      // All the missing ones or none: the ones made in this call go again.
      for (const b of bots) store.remove(b.id);
      return { ok: false, code: made.code === 'too_many_bots' ? 'too_many_bots' : 'invalid_argument', message: made.message };
    }
    bots.push(made.bot);
  }
  return { ok: true, bots, ...(skipped.length > 0 ? { skipped } : {}) };
}

/** Queue a new bot's first wake (`intro`: greet the owner, ask what to do
 *  with choices), pinned to the bot's 1:1 thread: the greeting is said to
 *  the owner there, never in the room's General. Deduped by its reason key,
 *  so it runs once. Returns the item, or null when nothing was queued (no
 *  queue yet, bot disabled). */
export function greetNewBot(
  bot: Pick<BotProfile, 'id' | 'workspaceId' | 'enabled'>,
  enqueue: ((input: WakeEnqueueInput) => WakeItem | null) | null,
): WakeItem | null {
  if (!bot.enabled || !enqueue) return null;
  return enqueue({ botId: bot.id, workspaceId: bot.workspaceId, reason: { kind: 'intro' }, priority: 0, threadId: dmThreadId(bot.id) });
}

export interface BotRepoSuggestDeps extends BotRepoDeps {
  /** The workspaces as main's workspace mirror holds them (null: none pushed yet). */
  entries?: () => WorkspaceListEntry[] | null;
  /** A pane's shell cwd as main tracks it (OSC 7, the daemon, the spawn). */
  cwdOf?: (ptyId: string) => string | undefined;
  homeDir?: string;
}

/** The workspace's current folder: its active pane's shell cwd as main
 *  tracks it, else the first of its other panes that has one, else the
 *  folder the workspace mirror records for it (`metadata.cwd`, which the
 *  renderer fills from its panes and pushes with the mirror), so a
 *  workspace whose panes have reported no cwd yet still has the one it was
 *  last seen in. Never a path sent with the suggestion request itself, and
 *  always resolved and checked like a picked folder. */
export function workspaceFolder(
  workspaceId: string,
  entries: WorkspaceListEntry[] | null,
  cwdOf: (ptyId: string) => string | undefined,
): string | null {
  const entry = entries?.find((e) => e.id === workspaceId);
  if (!entry) return null;
  const ptys = [entry.activePtyId, ...(entry.ptyIds ?? [])].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const ptyId of ptys) {
    const cwd = cwdOf(ptyId);
    if (cwd && path.isAbsolute(cwd)) return cwd;
  }
  const recorded = entry.metadata?.cwd;
  return recorded && path.isAbsolute(recorded) ? recorded : null;
}

/** `p` with the home folder shortened to `~`. */
export function homeShortPath(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** FACTORY_BOT_SUGGEST_REPO's answer: the repo "Add bot" offers a workspace. */
export async function suggestBotRepo(
  store: BotStore | null,
  workspaceId: unknown,
  deps: BotRepoSuggestDeps = {},
): Promise<FactoryBotRepoSuggestion> {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId.length > 256) return { ok: false, code: 'invalid_argument' };
  const home = deps.homeDir ?? os.homedir();
  const inherited = store ? workspaceRepo(store, workspaceId) : null;
  if (inherited) {
    return { ok: true, repoKey: inherited.repoKey, root: inherited.repoPath, displayRoot: homeShortPath(inherited.repoPath, home), inherited: true };
  }
  const folder = workspaceFolder(workspaceId, deps.entries?.() ?? null, deps.cwdOf ?? (() => undefined));
  if (!folder) return { ok: false, code: 'no_folder' };
  const resolved = await resolveBotRepo(folder, deps);
  // Read after the await: a bot given a repo meanwhile is the workspace's repo.
  const since = store ? workspaceRepo(store, workspaceId) : null;
  if (since) return { ok: true, repoKey: since.repoKey, root: since.repoPath, displayRoot: homeShortPath(since.repoPath, home), inherited: true };
  if (!resolved.ok) return { ok: false, code: resolved.code === 'invalid_argument' ? 'no_folder' : resolved.code };
  const { repoKey, repoPath } = resolved.repo;
  return { ok: true, repoKey, root: repoPath, displayRoot: homeShortPath(repoPath, home), inherited: false };
}
