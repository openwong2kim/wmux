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
// "Add bot" offers before that: the workspace's remembered repository
// (workspaceRepos.ts) or its sibling's, else the workspace's folders (the
// folder it was opened on, its panes' shell cwds main tracks, the folder the
// workspace mirror records), each resolved like a picked folder. A refused
// folder's reason comes with the answer, and an owner's None is remembered
// for the workspace, so the owner is asked once.
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
import type { BotEngine, BotProfile, BotTemplate } from '../../shared/bot';
import { HERMES_BOT_ENGINE, MY_HERMES_DEFAULT_PROFILE, myHermesEngine, normalizeBotName } from '../../shared/bot';
import { TEAM_TEMPLATES, teamTemplatesPresent, type FactoryBotCreateResult, type FactoryBotCreateTeamResult, type FactoryBotRepoSuggestion } from '../../shared/botCreate';
import { BOTS_MAX } from './botStore';
import type { WakeItem } from '../../shared/wake';
import { normalizeRepoKey } from '../../shared/repoKey';
import { sameRepoKey } from '../../shared/forgeHosts';
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
import { getWorkspaceRepoStore, type WorkspaceRepo, type WorkspaceRepoStore } from './workspaceRepos';
import { getBotRuntime } from './BotRuntime';
import { hostCwdForPane, type DaemonRpc } from '../pty/wslCallerCwd';

export interface BotRepoDeps {
  git?: (args: string[], cwd: string) => Promise<GitResult>;
  realpath?: (p: string) => string;
  /** The workspaces' remembered repositories (default: the bot runtime's
   *  store; null: none). */
  records?: WorkspaceRepoStore | null;
  /** Told of each bot given the workspace's repository here
   *  (recordWorkspaceRepo; default: the bot runtime's profileChanged). */
  profileChanged?: (botId: string) => void;
}

function recordsOf(deps: Pick<BotRepoDeps, 'records'>): WorkspaceRepoStore | null {
  return deps.records === undefined ? getWorkspaceRepoStore() : deps.records;
}

export type BotRepoResult =
  | { ok: true; repo: { repoKey: string; repoPath: string; originPin?: string } }
  | { ok: false; code: 'invalid_argument' | 'not_a_repo' | 'repo_untrusted' | 'no_remote'; message: string; originSet?: boolean };

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
  if (!repoKey) return { ok: false, code: 'no_remote', originSet: true, message: `The origin remote of ${repoPath} is not an owner/repo address on a git host. ${NEEDS_HOSTED_ORIGIN}` };
  const originPin = rawKey && isOriginPin(raw) ? raw : null;
  return { ok: true, repo: { repoKey, repoPath, ...(originPin ? { originPin } : {}) } };
}

/** The repo the workspace's bots work on now (its oldest repo bot's), or
 *  null when none has one. */
export function workspaceBotsRepo(store: BotStore, workspaceId: unknown): WorkspaceRepo | null {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return null;
  const withRepo = store.list({ workspaceId }).filter((b) => b.repo).sort((a, b) => a.createdAt - b.createdAt);
  return withRepo[0]?.repo ? { ...withRepo[0].repo } : null;
}

/** The repo a workspace's bots work on: its bots' own, else the one
 *  remembered for it (unchecked: liveWorkspaceRepo checks it); null when
 *  there is neither. */
export function workspaceRepo(
  store: BotStore,
  workspaceId: unknown,
  records: WorkspaceRepoStore | null = getWorkspaceRepoStore(),
): WorkspaceRepo | null {
  const held = workspaceBotsRepo(store, workspaceId);
  if (held) return held;
  const remembered = typeof workspaceId === 'string' ? records?.get(workspaceId) : null;
  return remembered && 'repo' in remembered ? remembered.repo : null;
}

export type BrokenRepo = { code: 'not_a_repo' | 'repo_untrusted' | 'no_remote' | 'repo_mismatch'; message: string };

/** Why `repo` no longer works, resolved again now (its folder gone, no
 *  longer trusted, or naming another repository or origin pin), or null
 *  when it still resolves to itself. */
async function repoBroken(repo: WorkspaceRepo, deps: BotRepoDeps): Promise<BrokenRepo | null> {
  const again = await resolveBotRepo(repo.repoPath, deps);
  if (!again.ok) return { code: again.code === 'invalid_argument' ? 'not_a_repo' : again.code, message: again.message };
  if (!sameRepoKey(again.repo.repoKey, repo.repoKey)) return { code: 'repo_mismatch', message: `${repo.repoPath} now names ${again.repo.repoKey}, not ${repo.repoKey}` };
  // A repository stored before origin pins existed has none to compare.
  if (repo.originPin && again.repo.originPin !== repo.originPin) return { code: 'repo_mismatch', message: `the origin of ${repo.repoPath} changed` };
  return null;
}

/** The refusal of an add to a workspace whose bots' repository no longer
 *  works: never bound to a new bot, never re-pointed here; a bot profile's
 *  Change is the fix. */
export function brokenRepoRefusal(b: BrokenRepo): { ok: false } & BrokenRepo {
  return { ok: false, code: b.code, message: `The workspace's repository folder no longer works (${b.message.replace(/\.$/, '')}); change it in a bot's settings.` };
}

/** The workspace's repository as a new bot there takes it, resolved again
 *  now: its bots' own, or else the remembered one. A remembered repository
 *  no bot holds that no longer resolves to itself is forgotten (null); one
 *  its bots hold is `broken` instead, and the add is refused. */
export async function liveWorkspaceRepo(
  store: BotStore,
  workspaceId: unknown,
  deps: BotRepoDeps = {},
): Promise<{ repo: WorkspaceRepo; held: boolean } | { broken: BrokenRepo } | null> {
  const held = workspaceBotsRepo(store, workspaceId);
  if (held) {
    const broken = await repoBroken(held, deps);
    return broken ? { broken } : { repo: held, held: true };
  }
  if (typeof workspaceId !== 'string') return null;
  const records = recordsOf(deps);
  const remembered = records?.get(workspaceId);
  if (!remembered || !('repo' in remembered)) return null;
  if (!(await repoBroken(remembered.repo, deps))) return { repo: remembered.repo, held: false };
  // Forgotten only when it is still the answer that was checked.
  const now = records?.get(workspaceId);
  if (now && 'repo' in now && now.at === remembered.at) records?.clear(workspaceId);
  return null;
}

/** The repository a new bot (or team) takes: none for None (`noRepo`) or
 *  an unchecked form (`noInherit`, which goes with neither `noRepo` nor a
 *  folder); a picked folder, refused when the workspace's bots work on
 *  another repository or theirs no longer works; else the workspace's,
 *  resolved again (liveWorkspaceRepo). */
async function repoForNewBot(
  store: BotStore,
  workspaceId: unknown,
  r: Record<string, unknown>,
  deps: BotRepoDeps,
): Promise<{ ok: true; repo?: WorkspaceRepo } | { ok: false; code: 'invalid_argument' | 'not_a_repo' | 'repo_untrusted' | 'no_remote' | 'repo_mismatch'; message: string }> {
  if (r.noInherit === true && (r.noRepo === true || r.repoFolder !== undefined)) {
    return { ok: false, code: 'invalid_argument', message: 'noInherit goes with neither noRepo nor repoFolder' };
  }
  if (r.repoFolder === undefined) {
    if (r.noRepo === true || r.noInherit === true) return { ok: true };
    const live = await liveWorkspaceRepo(store, workspaceId, deps);
    if (live && 'broken' in live) return brokenRepoRefusal(live.broken);
    return live ? { ok: true, repo: live.repo } : { ok: true };
  }
  const resolved = await resolveBotRepo(r.repoFolder, deps);
  if (!resolved.ok) return resolved;
  // Only a bot of the workspace binds it; a remembered repository no bot
  // holds gives way to the folder the owner picked.
  const held = workspaceBotsRepo(store, workspaceId);
  if (!held) return { ok: true, repo: resolved.repo };
  if (!sameRepoKey(held.repoKey, resolved.repo.repoKey)) return mismatch(held, resolved.repo);
  const broken = await repoBroken(held, deps);
  return broken ? brokenRepoRefusal(broken) : { ok: true, repo: held };
}

/** One chain per workspace: everything that reads a workspace's repository
 *  and then writes it (a create, a team, the first run, a profile's Change)
 *  runs alone, so two of them never both pass the one-repository check. */
const workspaceLocks = new Map<string, Promise<unknown>>();

export function withWorkspaceRepoLock<T>(workspaceId: unknown, run: () => Promise<T>): Promise<T> {
  const key = typeof workspaceId === 'string' ? workspaceId : '';
  const before = workspaceLocks.get(key) ?? Promise.resolve();
  const next = before.then(run, run);
  const tail = next.then(() => undefined, () => undefined);
  workspaceLocks.set(key, tail);
  void tail.then(() => { if (workspaceLocks.get(key) === tail) workspaceLocks.delete(key); });
  return next;
}

function mismatch(current: WorkspaceRepo, picked: WorkspaceRepo, who = "This workspace's bots"): { ok: false; code: 'repo_mismatch'; message: string } {
  return {
    ok: false,
    code: 'repo_mismatch',
    message: `${who} work on ${current.repoKey} (${current.repoPath}); ${picked.repoPath} is ${picked.repoKey}. A workspace works on one repository.`,
  };
}

/** One bot for "Add bot". */
export async function createBotFromFolder(
  store: BotStore | null,
  req: unknown,
  deps: BotRepoDeps = {},
): Promise<FactoryBotCreateResult> {
  if (!store) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
  const r = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
  // The engine Add bot picked (absent or Claude: the store's default, with
  // the template's model).
  let engine: BotEngine | undefined;
  if (r.engine === 'hermes') engine = { ...HERMES_BOT_ENGINE };
  else if (r.engine === 'my-hermes') engine = myHermesEngine(r.hermesProfile === undefined ? MY_HERMES_DEFAULT_PROFILE : (r.hermesProfile as string));
  else if (r.engine !== undefined && r.engine !== 'claude-sdk') return { ok: false, code: 'invalid_argument', message: 'engine must be claude-sdk, hermes or my-hermes' };
  return withWorkspaceRepoLock(r.workspaceId, async (): Promise<FactoryBotCreateResult> => {
    const chosen = await repoForNewBot(store, r.workspaceId, r, deps);
    if (!chosen.ok) return chosen;
    const repo = chosen.repo;
    const heldBefore = workspaceBotsRepo(store, r.workspaceId) !== null;
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
      ...(engine !== undefined ? { engine } : {}),
    });
    if (!created.ok) return created;
    rememberWorkspaceAnswer(store, created.bot.workspaceId, repo, r.repoFolder === undefined && r.noRepo === true, heldBefore, deps);
    return { ok: true, bot: created.bot };
  });
}

/** What a create told about the workspace's repository: the repo its bots
 *  now work on (recordWorkspaceRepo), or the owner's None (`noRepo`, sent
 *  when the owner pressed None), so the next add does not ask again. A None
 *  replaces a remembered repository no bot holds, and never takes a
 *  repository from any bot. `heldBefore`: a bot held the repository before
 *  this create, so the repo-less bots there are ones the owner left without
 *  one, and none is filled. */
function rememberWorkspaceAnswer(
  store: BotStore,
  workspaceId: string,
  repo: WorkspaceRepo | undefined,
  noRepo: boolean,
  heldBefore: boolean,
  deps: Pick<BotRepoDeps, 'records' | 'profileChanged'>,
): void {
  if (repo) recordWorkspaceRepo(store, workspaceId, repo, deps, { fill: !heldBefore });
  else if (noRepo && !workspaceBotsRepo(store, workspaceId)) recordsOf(deps)?.setNone(workspaceId, { replace: true });
}

/** The workspace works on `repo` from now on: remembered for it, and, when
 *  it is newly chosen for the workspace (`fill`: no bot held a repository
 *  before this write), given to each of its bots that has no repository
 *  (every role, as Add team gives it to every template), each told to the
 *  bot runtime (`profileChanged`). When a bot already held it, a bot
 *  without one is one the owner left without one (None), and keeps none.
 *  Called by every path that resolves a workspace's repository (Add bot,
 *  Add team, the first run, a profile's Change, a pipe `bot.update` that
 *  sets one), after the store accepted it, inside withWorkspaceRepoLock. A
 *  bot on another repository keeps it (that one was refused, `repo_mismatch`,
 *  before this). Returns the ids filled in. */
export function recordWorkspaceRepo(
  store: BotStore,
  workspaceId: string,
  repo: WorkspaceRepo,
  deps: Pick<BotRepoDeps, 'records' | 'profileChanged'> = {},
  opts: { fill: boolean } = { fill: true },
): string[] {
  recordsOf(deps)?.setRepo(workspaceId, repo);
  if (!opts.fill) return [];
  const changed = deps.profileChanged ?? ((id: string) => getBotRuntime()?.profileChanged(id));
  const filled: string[] = [];
  for (const bot of store.list({ workspaceId })) {
    if (bot.repo) continue;
    // The store checks it as on every write (a guest workspace's bots hold
    // no repository and stay as they are).
    if (!store.update(bot.id, { repo }).ok) continue;
    filled.push(bot.id);
    changed(bot.id);
  }
  return filled;
}

/** The repository the other bots of `botId`'s workspace work on, or null. */
export function otherBotsRepo(store: BotStore, botId: string): WorkspaceRepo | null {
  const bot = store.get(botId);
  if (!bot) return null;
  const others = store.list({ workspaceId: bot.workspaceId }).filter((b) => b.id !== botId && b.repo).sort((a, b) => a.createdAt - b.createdAt);
  return others[0]?.repo ? { ...others[0].repo } : null;
}

/** The repo patch for an existing bot's "Change" (the Bots page profile):
 *  the folder resolved exactly as "Add bot" resolves it (git root, origin's
 *  owner/repo, never a local-path origin), refused when another bot of its
 *  workspace works on another repository (a workspace works on one). The
 *  caller saves it and then calls recordWorkspaceRepo, all inside
 *  withWorkspaceRepoLock (bot.rpc.ts). */
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
  const current = otherBotsRepo(store, botId);
  if (current && !sameRepoKey(current.repoKey, resolved.repo.repoKey)) return mismatch(current, resolved.repo, "This workspace's other bots");
  // The same repository spelled as the workspace's bots stored it.
  return current ? { ...resolved, repo: { ...resolved.repo, repoKey: current.repoKey } } : resolved;
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
  return withWorkspaceRepoLock(workspaceId, async (): Promise<FactoryBotCreateTeamResult> => {
    // One repository for all five, resolved once, as "Add bot" resolves it.
    const chosen = await repoForNewBot(store, workspaceId, r, deps);
    if (!chosen.ok) return chosen;
    const repo = chosen.repo;
    const heldBefore = workspaceBotsRepo(store, workspaceId) !== null;
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
    if (bots.length > 0) rememberWorkspaceAnswer(store, workspaceId, repo, r.repoFolder === undefined && r.noRepo === true, heldBefore, deps);
    return { ok: true, bots, ...(skipped.length > 0 ? { skipped } : {}) };
  });
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
  /** The daemon, read for a WSL pane's distro (its session's wslTarget). */
  daemonRpc?: DaemonRpc;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

/** The workspace's folders: the folder it was opened on (`startupCwd`, the
 *  owner's own link), apart, and then its active pane's shell cwd as main
 *  tracks it, its other panes', and the folder the workspace mirror records
 *  for it (`metadata.cwd`, the last one any pane reported). A WSL pane's
 *  Linux cwd is spelled as this process opens it (hostCwdForPane, with the
 *  distro of the pane it came from; the opened folder and the recorded one
 *  are read with the active pane's). On Windows a Linux path that cannot be
 *  spelled so is never read on this host: the opened folder says why
 *  (`error`), a pane's is left out, as is anything not absolute. No
 *  duplicates. Never a path sent with the suggestion request itself. */
export async function workspaceFolderList(
  workspaceId: string,
  entries: WorkspaceListEntry[] | null,
  cwdOf: (ptyId: string) => string | undefined,
  opts: { platform?: NodeJS.Platform; daemonRpc?: DaemonRpc } = {},
): Promise<{ opened: { folder: string } | { error: string } | null; folders: string[] }> {
  const entry = entries?.find((e) => e.id === workspaceId);
  if (!entry) return { opened: null, folders: [] };
  const platform = opts.platform ?? process.platform;
  const absolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const ptys = [entry.activePtyId, ...(entry.ptyIds ?? [])].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const anyPty = ptys[0] ?? '';
  const host = async (cwd: string, ptyId: string): Promise<{ folder: string } | { error: string }> => {
    const r = await hostCwdForPane(cwd, ptyId, { platform, ...(opts.daemonRpc ? { daemonRpc: opts.daemonRpc } : {}) });
    if ('error' in r) return { error: r.error };
    return absolute(r.cwd) ? { folder: r.cwd } : { error: `${cwd} is not a full folder path.` };
  };
  const opened = entry.startupCwd ? await host(entry.startupCwd, anyPty) : null;
  const raw: { cwd: string | null | undefined; ptyId: string }[] = ptys.map((ptyId) => ({ cwd: cwdOf(ptyId), ptyId }));
  raw.push({ cwd: entry.metadata?.cwd, ptyId: anyPty });
  const folders: string[] = [];
  for (const { cwd, ptyId } of raw) {
    if (!cwd) continue;
    const h = await host(cwd, ptyId);
    if ('folder' in h && !folders.includes(h.folder) && !(opened && 'folder' in opened && opened.folder === h.folder)) folders.push(h.folder);
  }
  return { opened, folders };
}

/** workspaceFolderList as one list, the opened folder first. */
export async function workspaceFolders(
  workspaceId: string,
  entries: WorkspaceListEntry[] | null,
  cwdOf: (ptyId: string) => string | undefined,
  opts: { platform?: NodeJS.Platform; daemonRpc?: DaemonRpc } = {},
): Promise<string[]> {
  const { opened, folders } = await workspaceFolderList(workspaceId, entries, cwdOf, opts);
  return [...(opened && 'folder' in opened ? [opened.folder] : []), ...folders];
}

/** `p` with the home folder shortened to `~`. */
export function homeShortPath(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** FACTORY_BOT_SUGGEST_REPO's answer: the repo "Add bot" offers a workspace.
 *  Its bots' repository (inherited); a remembered one that still resolves
 *  (offered, with Change); the owner's None when one was remembered
 *  (`code: 'none'`, no folder read). Else the folder the workspace was
 *  opened on decides alone: its repo, or its refusal with the reason. Only
 *  a workspace opened on no folder falls back to its panes' folders: the
 *  first that resolves, else the first refusal. Read again after every
 *  await: a repository or a None saved meanwhile is the answer. */
export async function suggestBotRepo(
  store: BotStore | null,
  workspaceId: unknown,
  deps: BotRepoSuggestDeps = {},
): Promise<FactoryBotRepoSuggestion> {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId.length > 256) return { ok: false, code: 'invalid_argument' };
  const home = deps.homeDir ?? os.homedir();
  const records = recordsOf(deps);
  const offer = (repo: WorkspaceRepo, inherited: boolean): FactoryBotRepoSuggestion =>
    ({ ok: true, repoKey: repo.repoKey, root: repo.repoPath, displayRoot: homeShortPath(repo.repoPath, home), inherited });
  const settled = (): FactoryBotRepoSuggestion | null => {
    const held = store ? workspaceBotsRepo(store, workspaceId) : null;
    if (held) return offer(held, true);
    const remembered = records?.get(workspaceId);
    return remembered && 'none' in remembered ? { ok: false, code: 'none' } : null;
  };
  const first = settled();
  if (first) return first;
  const live = store ? await liveWorkspaceRepo(store, workspaceId, deps) : null;
  if (live && 'repo' in live) return settled() ?? offer(live.repo, live.held);
  const list = await workspaceFolderList(workspaceId, deps.entries?.() ?? null, deps.cwdOf ?? (() => undefined), {
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.daemonRpc ? { daemonRpc: deps.daemonRpc } : {}),
  });
  let refusal: { code: 'not_a_repo' | 'repo_untrusted' | 'no_remote'; message: string; originSet?: boolean } | null = null;
  let found: WorkspaceRepo | null = null;
  if (list.opened && 'error' in list.opened) {
    refusal = { code: 'not_a_repo', message: list.opened.error };
  } else {
    const folders = list.opened ? [list.opened.folder] : list.folders;
    for (const folder of folders) {
      const resolved = await resolveBotRepo(folder, deps);
      if (resolved.ok) {
        found = resolved.repo;
        break;
      }
      if (!refusal && resolved.code !== 'invalid_argument') refusal = { code: resolved.code, message: resolved.message, ...(resolved.originSet ? { originSet: true } : {}) };
    }
  }
  // Read after the awaits: a bot given a repo, or a None saved, meanwhile.
  const since = settled();
  if (since) return since;
  if (found) return offer(found, false);
  if (!refusal) return { ok: false, code: 'no_folder' };
  return { ok: false, code: refusal.code, message: refusal.message, ...(refusal.originSet ? { originSet: true } : {}) };
}
