// "Add bot" (name, job and template; a repo from a picked folder or the
// workspace's; the store's own validation), its IPC's main-window guard,
// and a new bot's greeting wake.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { BotStore, botsFilePath } from '../botStore';
import { botRepoFromFolder, createBotFromFolder, createTeamFromFolder, greetNewBot, homeShortPath, recordWorkspaceRepo, resolveBotRepo, suggestBotRepo, workspaceFolderList, workspaceFolders, workspaceRepo } from '../botCreate';
import { WorkspaceRepoStore, workspaceReposPath } from '../workspaceRepos';
import { persisterWritesSettled } from '../versionedFile';
import { DEFAULT_FACTORY_SETTINGS, type FactorySettings } from '../factorySettings';
import { factoryBotClearRemovedHandler, factoryBotCreateHandler, factoryBotCreateTeamHandler, factoryBotSuggestRepoHandler, factorySettingsSetHandler } from '../../ipc/handlers/factory.handler';
import type { WorkspaceListEntry } from '../../../shared/workspaceMirror';
import type { FactorySettingsStore } from '../factorySettings';
import type { GitResult } from '../../git/git';

let dir = '';
let store: BotStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfui-botcreate-'));
  store = new BotStore(botsFilePath(dir));
});
afterEach(async () => {
  await store.flush().catch(() => undefined);
  await persisterWritesSettled();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ok = (stdout: string): GitResult => ({ stdout, stderr: '', code: 0 });
const fail: GitResult = { stdout: '', stderr: 'fatal', code: 128 };

/** A fake git: `rev-parse` answers `top`, `remote get-url` answers `url`,
 *  and the repository config holds `raw` (default: get-url's answer) as
 *  origin's URL. */
function fakeGit(top: GitResult, url: GitResult, raw?: string) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return top;
    if (args.includes('config')) return url.code === 0 ? ok(`local\0remote.origin.url\n${raw ?? url.stdout.trim()}\0`) : url;
    return url;
  });
}

function settings(over: Partial<FactorySettings> = {}): FactorySettings {
  return { ...DEFAULT_FACTORY_SETTINGS, trustedAuthors: [], morning: { hour: 9, weekdays: [1] }, ...over };
}

describe('resolveBotRepo', () => {
  it('refuses a folder that is not a git checkout', async () => {
    const r = await resolveBotRepo('/tmp/plain', { git: fakeGit(fail, fail) });
    expect(r).toMatchObject({ ok: false, code: 'not_a_repo' });
  });

  it('a repository git will not open over ownership is not "not a checkout" (#2231)', async () => {
    const folder = '/mnt/wsl/repo';
    const dubious: GitResult = {
      stdout: '',
      stderr: "fatal: detected dubious ownership in repository at '//wsl.localhost/Ubuntu/home/dev/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu/home/dev/repo'\n",
      code: 128,
    };
    const r = await resolveBotRepo(folder, { git: fakeGit(dubious, fail) });
    expect(r).toMatchObject({ ok: false, code: 'repo_untrusted' });
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain("git config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu/home/dev/repo'");
    expect(r.message).toContain(folder);
    // The origin read refused the same way (the root is trusted, its gitdir is not).
    const atOrigin = await resolveBotRepo('/src/app', { git: fakeGit(ok('/src/app\n'), dubious), realpath: (p) => p });
    expect(atOrigin).toMatchObject({ ok: false, code: 'repo_untrusted' });
  });

  it('refuses a checkout without an origin, or whose origin names no owner/repo', async () => {
    const top = ok('/src/app\n');
    const none = await resolveBotRepo('/src/app', { git: fakeGit(top, fail), realpath: (p) => p });
    expect(none).toMatchObject({ ok: false, code: 'no_remote' });
    // No origin at all is added; an origin naming no host is changed, so the
    // refusal says which (the page offers set-url instead of add).
    expect(none.ok ? null : none.originSet).toBeUndefined();
    expect(await resolveBotRepo('/src/app', { git: fakeGit(top, ok('/srv/git/app.git\n')), realpath: (p) => p })).toMatchObject({ ok: false, code: 'no_remote', originSet: true });
    // The refusal says what origin has to be, not only that it is wrong: the
    // folder picker is the only way to link, so the fix is in the repository.
    for (const url of [fail, ok('/srv/git/app.git\n')]) {
      const r = await resolveBotRepo('/src/app', { git: fakeGit(top, url), realpath: (p) => p });
      expect(r.ok ? '' : r.message).toMatch(/https:\/\/github\.com\/<owner>\/<repo>\.git/);
      expect(r.ok ? '' : r.message).toContain('A local path or a bare repository on disk cannot be used.');
    }
    expect(await resolveBotRepo('/src/app', { git: fakeGit(top, ok('https://gitlab.example.com/app.git\n')), realpath: (p) => p }))
      .toMatchObject({ ok: false, code: 'no_remote' });
    // A GitLab subgroup project is a repository, keyed by its whole path.
    expect(await resolveBotRepo('/src/app', { git: fakeGit(top, ok('ssh://git@gitlab.example.com:2222/group/sub/app.git\n')), realpath: (p) => p }))
      .toMatchObject({ ok: true, repo: { repoKey: 'gitlab.example.com/group/sub/app' } });
  });

  it('refuses a relative or missing folder before running git', async () => {
    const git = fakeGit(ok('/x\n'), ok('git@github.com:a/b.git\n'));
    expect(await resolveBotRepo('relative/path', { git })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await resolveBotRepo(undefined, { git })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(git).not.toHaveBeenCalled();
  });

  it('keys the repo by origin and roots it at the realpath of the git toplevel', async () => {
    const git = fakeGit(ok('/link/app\n'), ok('git@github.com:Acme/App.git\n'));
    const r = await resolveBotRepo('/link/app/src', { git, realpath: (p) => p.replace('/link', '/real') });
    expect(r).toEqual({ ok: true, repo: { repoKey: 'github.com/acme/app', repoPath: '/real/app', originPin: 'git@github.com:Acme/App.git' } });
    expect(git).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/real/app');
  });

  it('keys and pins the repo by origin\'s URL as the repository config holds it, not as an owner\'s insteadOf rewrites it', async () => {
    // get-url answers the rewritten address (an ssh Host alias); the config holds https.
    const git = fakeGit(ok('/src/app\n'), ok('git@github-work:Acme/App.git\n'), 'https://github.com/Acme/App.git');
    expect(await resolveBotRepo('/src/app', { git, realpath: (p) => p })).toEqual({ ok: true, repo: { repoKey: 'github.com/acme/app', repoPath: '/src/app', originPin: 'https://github.com/Acme/App.git' } });
    // A config URL with no owner/repo (a shortcut only insteadOf expands): get-url's key, no pin.
    const short = fakeGit(ok('/src/app\n'), ok('https://github.com/acme/app.git\n'), 'gh:acme/app');
    expect(await resolveBotRepo('/src/app', { git: short, realpath: (p) => p })).toEqual({ ok: true, repo: { repoKey: 'github.com/acme/app', repoPath: '/src/app' } });
  });

  it('reads a real checkout (subfolder → its root)', async () => {
    const repo = path.join(dir, 'app');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: repo });
    const r = await resolveBotRepo(path.join(repo, 'src'));
    // git prints the long form of a Windows 8.3 short name; the native realpath does too.
    expect(r).toEqual({ ok: true, repo: { repoKey: 'github.com/acme/app', repoPath: fs.realpathSync.native(repo), originPin: 'git@github.com:acme/app.git' } });
  });
});

describe('createBotFromFolder', () => {
  const git = fakeGit(ok('/src/app\n'), ok('https://github.com/acme/app.git\n'));
  const deps = { git, realpath: (p: string) => p };

  it('creates a lead with the derived repo and the store defaults', async () => {
    const r = await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The store keeps a repository path normalized (native separators).
    expect(r.bot).toMatchObject({ workspaceId: 'ws-1', role: 'lead', name: 'Lead', enabled: true, repo: { repoKey: 'github.com/acme/app', repoPath: path.normalize('/src/app') } });
    expect(r.bot.triggers.length).toBeGreaterThan(0);
  });

  it('creates a bot by name alone: no repository yet, the custom template, no job', async () => {
    const r = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Wmux Issue' }, deps);
    expect(r).toMatchObject({ ok: true, bot: { name: 'Wmux Issue', template: 'custom', role: 'lead' } });
    if (r.ok) {
      expect(r.bot.repo).toBeUndefined();
      expect(r.bot.job).toBeUndefined();
    }
    expect(git).not.toHaveBeenCalledWith(expect.anything(), '/src/app');
  });

  it('takes a template and the job it prefilled; the legacy role follows the template', async () => {
    const r = await createBotFromFolder(store, { workspaceId: 'ws-1', name: '대장', template: 'coordinator', job: 'Coordinate the team.' }, deps);
    expect(r).toMatchObject({ ok: true, bot: { name: '대장', template: 'coordinator', role: 'moa', job: 'Coordinate the team.' } });
  });

  it('keeps a known recipe across a reload, and refuses an unknown one or one of another template', async () => {
    const r = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Notes', template: 'custom', recipe: 'notionMeetingDigest' }, deps);
    expect(r).toMatchObject({ ok: true, bot: { template: 'custom', recipe: 'notionMeetingDigest' } });
    await store.flush();
    const reread = new BotStore(botsFilePath(dir));
    reread.load();
    expect(reread.list()[0]).toMatchObject({ recipe: 'notionMeetingDigest' });
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'X', template: 'custom', recipe: 'sendAllMail' }, deps)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Y', template: 'researcher', recipe: 'notionMeetingDigest' }, deps)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.list()).toHaveLength(1);
  });

  it('keeps a well-formed recipe id it does not know (a newer build wrote it), and drops a malformed one', async () => {
    await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Notes', template: 'custom', recipe: 'notionMeetingDigest' }, deps);
    await store.flush();
    const file = botsFilePath(dir);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.bots[0].recipe = 'recipeFromANewerBuild';
    fs.writeFileSync(file, JSON.stringify(raw));
    const newer = new BotStore(file);
    newer.load();
    expect(newer.list()[0].recipe).toBe('recipeFromANewerBuild');
    raw.bots[0].recipe = '../not an id';
    fs.writeFileSync(file, JSON.stringify(raw));
    const broken = new BotStore(file);
    broken.load();
    expect(broken.list()[0]).not.toHaveProperty('recipe');
  });

  it('refuses a folder that is not a checkout, a bad template and a bad job', async () => {
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'verifier', repoFolder: '/tmp/x' }, { git: fakeGit(fail, fail) }))
      .toMatchObject({ ok: false, code: 'not_a_repo' });
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', template: 'boss' }, deps)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', job: 'x'.repeat(5000) }, deps)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.list()).toEqual([]);
  });

  it('passes the store\'s own refusals through (bad role, bad workspace); two bots of one template may share a workspace', async () => {
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'boss' }, deps)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await createBotFromFolder(store, { workspaceId: '../etc', role: 'lead', repoFolder: '/src/app' }, deps)).toMatchObject({ ok: false, code: 'invalid_argument' });
    await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    expect((await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps)).ok).toBe(true);
    expect((await createBotFromFolder(store, { workspaceId: 'ws-1', template: 'developer' }, deps)).ok).toBe(true);
    expect(store.list({ workspaceId: 'ws-1' })).toHaveLength(3);
  });

  it('any number of coordinators, in any workspace', async () => {
    expect((await createBotFromFolder(store, { workspaceId: 'ws-hq', role: 'moa' }, deps)).ok).toBe(true);
    expect((await createBotFromFolder(store, { workspaceId: 'ws-2', template: 'coordinator' }, deps)).ok).toBe(true);
  });

  it('answers not_started before the factory runs', async () => {
    expect(await createBotFromFolder(null, { workspaceId: 'ws-1', role: 'lead' }, deps)).toMatchObject({ ok: false, code: 'not_started' });
  });
});

describe('botRepoFromFolder: an existing bot\'s repository', () => {
  const app = { git: fakeGit(ok('/src/app\n'), ok('https://github.com/acme/app.git\n')), realpath: (p: string) => p };
  const api = { git: fakeGit(ok('/src/api\n'), ok('git@github.com:acme/api.git\n')), realpath: (p: string) => p };

  it('resolves the folder as Add bot does, local-path origins refused', async () => {
    const made = await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead' }, app);
    if (!made.ok) throw new Error('not made');
    expect(await botRepoFromFolder(store, made.bot.id, '/src/app', app)).toEqual({ ok: true, repo: { repoKey: 'github.com/acme/app', repoPath: '/src/app', originPin: 'https://github.com/acme/app.git' } });
    const local = { git: fakeGit(ok('/src/app\n'), ok('/srv/git/app.git\n')), realpath: (p: string) => p };
    expect(await botRepoFromFolder(store, made.bot.id, '/src/app', local)).toMatchObject({ ok: false, code: 'no_remote' });
    expect(await botRepoFromFolder(store, made.bot.id, 'relative/dir', app)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await botRepoFromFolder(store, 'bot-00000fff', '/src/app', app)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a bot alone on its repository may move to another; one sharing the workspace\'s may not', async () => {
    const lead = await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, app);
    if (!lead.ok) throw new Error('not made');
    expect(await botRepoFromFolder(store, lead.bot.id, '/src/api', api)).toMatchObject({ ok: true, repo: { repoKey: 'github.com/acme/api' } });
    const dev = await createBotFromFolder(store, { workspaceId: 'ws-1', template: 'developer' }, app);
    if (!dev.ok) throw new Error('not made');
    const r = await botRepoFromFolder(store, dev.bot.id, '/src/api', api);
    expect(r).toMatchObject({ ok: false, code: 'repo_mismatch' });
    if (!r.ok) expect(r.message).toContain('github.com/acme/app');
  });
});

describe('createBotFromFolder: one repository per workspace', () => {
  const appGit = fakeGit(ok('/src/app\n'), ok('https://github.com/acme/app.git\n'));
  const deps = { git: appGit, realpath: (p: string) => p };

  it('the first bot with a repository in a workspace names its folder; without one the bot has none', async () => {
    expect(workspaceRepo(store, 'ws-1')).toBeNull();
    const bare = await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead' }, deps);
    expect(bare.ok && bare.bot.repo).toBeUndefined();
    expect(workspaceRepo(store, 'ws-1')).toBeNull();
    expect((await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps)).ok).toBe(true);
    // The store keeps origin's pin with the repository.
    expect(workspaceRepo(store, 'ws-1')).toEqual({ repoKey: 'github.com/acme/app', repoPath: path.normalize('/src/app'), originPin: 'https://github.com/acme/app.git' });
  });

  it('a later repo bot without a folder takes the workspace\'s repo, resolved once again first (one resolve, no extra git)', async () => {
    await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    const git = fakeGit(ok('/src/app\n'), ok('https://github.com/acme/app.git\n'));
    const r = await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'verifier' }, { git, realpath: (p: string) => p });
    expect(r).toMatchObject({ ok: true, bot: { role: 'verifier', repo: { repoKey: 'github.com/acme/app', repoPath: path.normalize('/src/app') } } });
    expect(git.mock.calls.filter((c) => c[0][1] === '--show-toplevel')).toHaveLength(1);
  });

  it('the bots\' repository no longer works: a new bot is refused with the reason and the fix, and no bot is re-pointed', async () => {
    const lead = await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    if (!lead.ok) throw new Error('not made');
    const names = { coordinator: 'Lead', researcher: 'Res', developer: 'Dev', issue: 'Iss', reviewer: 'Rev' };
    const cases: Array<[string, ReturnType<typeof fakeGit>]> = [
      ['gone', fakeGit(fail, fail)],
      ['another repository', fakeGit(ok('/src/app\n'), ok('git@github.com:acme/api.git\n'))],
      ['another pin', fakeGit(ok('/src/app\n'), ok('git@github.com:acme/app.git\n'))],
    ];
    for (const [why, git] of cases) {
      const r = await createBotFromFolder(store, { workspaceId: 'ws-1', name: `Bot ${why}` }, { git, realpath: (p: string) => p });
      expect(r, why).toMatchObject({ ok: false });
      if (r.ok) continue;
      expect(r.message, why).toContain('The workspace\'s repository folder no longer works (');
      expect(r.message, why).toContain('change it in a bot\'s settings');
      // A picked folder of the same repository does not slip past it either.
      expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: `Picked ${why}`, repoFolder: '/src/app' }, { git, realpath: (p: string) => p }), why).toMatchObject({ ok: false });
      expect(await createTeamFromFolder(store, { workspaceId: 'ws-1', names }, { git, realpath: (p: string) => p }), why).toMatchObject({ ok: false });
    }
    expect(store.list({ workspaceId: 'ws-1' })).toHaveLength(1);
    expect(store.get(lead.bot.id)?.repo).toMatchObject({ repoKey: 'github.com/acme/app', originPin: 'https://github.com/acme/app.git' });
  });

  it('noInherit goes with neither noRepo nor a folder', async () => {
    for (const extra of [{ noRepo: true }, { repoFolder: '/src/app' }]) {
      expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Ann', noInherit: true, ...extra }, deps)).toMatchObject({ ok: false, code: 'invalid_argument' });
    }
    expect(store.list()).toHaveLength(0);
  });

  it('refuses a folder of another repository in that workspace, and creates nothing', async () => {
    await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    const other = { git: fakeGit(ok('/src/api\n'), ok('git@github.com:acme/api.git\n')), realpath: (p: string) => p };
    const r = await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'verifier', repoFolder: '/src/api' }, other);
    expect(r).toMatchObject({ ok: false, code: 'repo_mismatch' });
    if (!r.ok) expect(r.message).toContain('github.com/acme/app');
    expect(store.list({ workspaceId: 'ws-1' })).toHaveLength(1);
    // Another workspace may work on it.
    expect((await createBotFromFolder(store, { workspaceId: 'ws-2', role: 'verifier', repoFolder: '/src/api' }, other)).ok).toBe(true);
  });

  it('accepts a folder of the same repository (a subfolder resolves to the same repo)', async () => {
    await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    const r = await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'verifier', repoFolder: '/src/app/lib' }, deps);
    expect(r).toMatchObject({ ok: true, bot: { repo: { repoKey: 'github.com/acme/app' } } });
  });

  it('two adds with different folders at once: one runs after the other, and the second is repo_mismatch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowGit = vi.fn(async (args: string[]) => {
      await gate;
      return args[0] === 'rev-parse' ? ok('/src/api\n') : ok('git@github.com:acme/api.git\n');
    });
    const first = createBotFromFolder(store, { workspaceId: 'ws-1', role: 'verifier', repoFolder: '/src/api' }, { git: slowGit, realpath: (p) => p });
    const second = createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    release();
    expect(await first).toMatchObject({ ok: true, bot: { repo: { repoKey: 'github.com/acme/api' } } });
    expect(await second).toMatchObject({ ok: false, code: 'repo_mismatch' });
    expect(store.list({ workspaceId: 'ws-1' })).toHaveLength(1);
  });

  it('a coordinator takes the workspace\'s repo like any bot', async () => {
    await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    const r = await createBotFromFolder(store, { workspaceId: 'ws-1', template: 'coordinator' }, deps);
    expect(r).toMatchObject({ ok: true, bot: { repo: { repoKey: 'github.com/acme/app' } } });
  });
});

describe('suggestBotRepo', () => {
  const entries = (over: Partial<WorkspaceListEntry> = {}): (() => WorkspaceListEntry[]) =>
    () => [{ id: 'ws-1', name: 'App', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'], ...over }];
  // Native absolute paths, so the home folder shortens on every platform.
  const HOME = path.resolve('/home/me');
  const APP = path.join(HOME, 'code', 'app');
  const appGit = fakeGit(ok(`${APP}\n`), ok('git@github.com:acme/app.git\n'));
  const base = { realpath: (p: string) => p, homeDir: HOME };

  it('a git folder with an origin: its repo, from the active pane\'s cwd main tracks', async () => {
    const cwdOf = vi.fn((pty: string) => (pty === 'pty-a' ? path.join(APP, 'src') : undefined));
    const r = await suggestBotRepo(store, 'ws-1', { ...base, git: appGit, entries: entries(), cwdOf });
    expect(r).toEqual({ ok: true, repoKey: 'github.com/acme/app', root: APP, displayRoot: path.join('~', 'code', 'app'), inherited: false });
    expect(appGit).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], path.join(APP, 'src'));
  });

  it('a workspace whose panes report no cwd: the folder the mirror records for it', async () => {
    const r = await suggestBotRepo(store, 'ws-1', { ...base, git: appGit, entries: entries({ metadata: { cwd: APP } }), cwdOf: () => undefined });
    expect(r).toEqual({ ok: true, repoKey: 'github.com/acme/app', root: APP, displayRoot: path.join('~', 'code', 'app'), inherited: false });
    // A pane's own cwd still comes first.
    const elsewhere = path.resolve('/elsewhere');
    expect(await workspaceFolders('ws-1', entries({ metadata: { cwd: APP } })(), (p) => (p === 'pty-b' ? elsewhere : undefined))).toEqual([elsewhere, APP]);
  });

  it('a folder that is not a git checkout, or has no origin: refused with the reason and its fix', async () => {
    const NOTES = path.join(HOME, 'notes');
    const cwdOf = () => NOTES;
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git: fakeGit(fail, fail), entries: entries(), cwdOf }))
      .toEqual({ ok: false, code: 'not_a_repo', message: `${NOTES} is not a git checkout.` });
    const noOrigin = await suggestBotRepo(store, 'ws-1', { ...base, git: fakeGit(ok(`${NOTES}\n`), fail), entries: entries(), cwdOf });
    expect(noOrigin).toMatchObject({ ok: false, code: 'no_remote' });
    if (noOrigin.ok) throw new Error('unreachable');
    expect(noOrigin.message).toContain(`${NOTES} has no origin remote.`);
    expect(noOrigin.message).toContain('git remote add origin');
  });

  it('no folder known: no mirror, an unknown workspace, no pane, no tracked cwd, a relative cwd', async () => {
    const git = vi.fn();
    const cwd = () => APP;
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: () => null, cwdOf: cwd })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-9', { ...base, git, entries: entries(), cwdOf: cwd })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries({ activePtyId: null, ptyIds: [] }), cwdOf: cwd })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries({ metadata: { cwd: 'relative' } }), cwdOf: () => undefined })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries(), cwdOf: () => undefined })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries(), cwdOf: () => 'relative' })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries() })).toEqual({ ok: false, code: 'no_folder' });
    expect(git).not.toHaveBeenCalled();
  });

  it('falls back from an active pane with no cwd to the workspace\'s other panes', async () => {
    const b = path.resolve('/x/b');
    expect(await workspaceFolders('ws-1', entries()(), (p) => (p === 'pty-b' ? b : undefined))).toEqual([b]);
  });

  it('a workspace whose bot has a repo answers that repo, inherited, without reading any folder', async () => {
    store.create({ workspaceId: 'ws-1', role: 'lead', repo: { repoKey: 'github.com/acme/app', repoPath: APP } });
    const git = vi.fn();
    const cwdOf = vi.fn(() => '/elsewhere');
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries(), cwdOf }))
      .toEqual({ ok: true, repoKey: 'github.com/acme/app', root: APP, displayRoot: path.join('~', 'code', 'app'), inherited: true });
    expect(git).not.toHaveBeenCalled();
    expect(cwdOf).not.toHaveBeenCalled();
  });

  it('a repo bot added while the folder resolves makes the answer that bot\'s repo, inherited', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const git = vi.fn(async (args: string[]) => {
      await gate;
      return args[0] === 'rev-parse' ? ok('/home/me/code/api\n') : ok('git@github.com:acme/api.git\n');
    });
    const pending = suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries(), cwdOf: () => path.join(HOME, 'code', 'api') });
    store.create({ workspaceId: 'ws-1', role: 'lead', repo: { repoKey: 'github.com/acme/app', repoPath: '/home/me/code/app' } });
    release();
    expect(await pending).toMatchObject({ ok: true, repoKey: 'github.com/acme/app', inherited: true });
  });

  it('refuses a missing workspace id', async () => {
    expect(await suggestBotRepo(store, undefined, base)).toEqual({ ok: false, code: 'invalid_argument' });
    expect(await suggestBotRepo(store, '', base)).toEqual({ ok: false, code: 'invalid_argument' });
  });

  it('shortens only the home folder itself or paths under it', () => {
    expect(homeShortPath(HOME, HOME)).toBe('~');
    expect(homeShortPath(path.join(HOME, 'code'), HOME)).toBe(path.join('~', 'code'));
    expect(homeShortPath(path.resolve('/home/meow/code'), HOME)).toBe(path.resolve('/home/meow/code'));
    expect(homeShortPath('/srv/app', '')).toBe('/srv/app');
  });
});

describe('the workspace\'s repository is asked once (workspace-repos.json)', () => {
  const entries = (over: Partial<WorkspaceListEntry> = {}): (() => WorkspaceListEntry[]) =>
    () => [{ id: 'ws-1', name: 'App', activePtyId: 'pty-a', ptyIds: ['pty-a', 'pty-b'], ...over }];
  const HOME = path.resolve('/home/me');
  const APP = path.join(HOME, 'code', 'app');
  const NOTES = path.join(HOME, 'notes');
  let records: WorkspaceRepoStore;
  beforeEach(() => {
    records = new WorkspaceRepoStore({ file: workspaceReposPath(dir) });
    records.load();
  });
  const reload = async (): Promise<WorkspaceRepoStore> => {
    await records.flush();
    const again = new WorkspaceRepoStore({ file: workspaceReposPath(dir) });
    again.load();
    return again;
  };
  const appGit = () => fakeGit(ok(`${APP}\n`), ok('git@github.com:acme/app.git\n'));

  it('a folder with no origin: refused once with its fix, then the owner\'s None is remembered and no folder is read again', async () => {
    const git = fakeGit(ok(`${NOTES}\n`), fail);
    const deps = { realpath: (p: string) => p, homeDir: HOME, records, git, entries: entries(), cwdOf: () => NOTES };
    const first = await suggestBotRepo(store, 'ws-1', deps);
    expect(first).toMatchObject({ ok: false, code: 'no_remote' });
    if (first.ok) throw new Error('unreachable');
    expect(first.message).toContain('git remote add origin');
    // The owner adds anyway: the form sends noRepo.
    const made = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Ann', noRepo: true }, deps);
    expect(made).toMatchObject({ ok: true });
    expect(records.get('ws-1')).toMatchObject({ none: true });
    git.mockClear();
    expect(await suggestBotRepo(store, 'ws-1', deps)).toEqual({ ok: false, code: 'none' });
    expect(git).not.toHaveBeenCalled();
    // Kept on disk, across a restart.
    const again = await reload();
    expect(await suggestBotRepo(store, 'ws-1', { ...deps, records: again })).toEqual({ ok: false, code: 'none' });
    // A folder picked later becomes the workspace's repository.
    const picked = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Bo', repoFolder: APP }, { ...deps, git: appGit() });
    expect(picked).toMatchObject({ ok: true, bot: { repo: { repoKey: 'github.com/acme/app' } } });
    expect(await suggestBotRepo(store, 'ws-1', deps)).toMatchObject({ ok: true, repoKey: 'github.com/acme/app', inherited: true });
  });

  it('an add without a folder and without noRepo remembers nothing (no answer was given)', async () => {
    const deps = { realpath: (p: string) => p, records };
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Ann' }, deps)).toMatchObject({ ok: true });
    expect(records.get('ws-1')).toBeNull();
  });

  it('the folder the workspace was opened on comes before a stray active pane', async () => {
    const stray = path.resolve('/elsewhere');
    const git = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'rev-parse') return cwd === APP ? ok(`${APP}\n`) : fail;
      return ok('git@github.com:acme/app.git\n');
    });
    const deps = { realpath: (p: string) => p, homeDir: HOME, records, git, entries: entries({ startupCwd: APP }), cwdOf: () => stray };
    expect(await suggestBotRepo(store, 'ws-1', deps)).toMatchObject({ ok: true, repoKey: 'github.com/acme/app', root: APP, inherited: false });
    expect(git.mock.calls[0]).toEqual([['rev-parse', '--show-toplevel'], APP]);
    expect(await workspaceFolders('ws-1', entries({ startupCwd: APP, metadata: { cwd: stray } })(), () => stray)).toEqual([APP, stray]);
  });

  it('a refused folder the workspace was opened on is the answer: no pane\'s repository is offered instead', async () => {
    const git = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'rev-parse') return cwd === APP ? ok(`${APP}\n`) : fail;
      return ok('git@github.com:acme/app.git\n');
    });
    const deps = { realpath: (p: string) => p, homeDir: HOME, records, git };
    expect(await suggestBotRepo(store, 'ws-1', { ...deps, entries: entries({ startupCwd: NOTES }), cwdOf: () => APP }))
      .toEqual({ ok: false, code: 'not_a_repo', message: `${NOTES} is not a git checkout.` });
    expect(git.mock.calls.map((c) => c[1])).toEqual([NOTES]);
    // A workspace opened on no folder still falls back to its panes.
    expect(await suggestBotRepo(store, 'ws-1', { ...deps, entries: entries(), cwdOf: () => APP })).toMatchObject({ ok: true, root: APP });
  });

  it('on Windows a Linux folder the workspace was opened on is read through its pane\'s distro, and one that cannot be is refused, never read on the host', async () => {
    const daemonRpc = vi.fn(async () => [{ id: 'pty-a', wslTarget: { distribution: 'Ubuntu' } }]);
    const list = await workspaceFolderList('ws-1', entries({ startupCwd: '/home/me/repo' })(), () => undefined, { platform: 'win32', daemonRpc });
    expect(list.opened).toEqual({ folder: '\\\\wsl$\\Ubuntu\\home\\me\\repo' });
    const git = vi.fn();
    const noDistro = await suggestBotRepo(store, 'ws-1', { realpath: (p: string) => p, records, git, platform: 'win32', entries: entries({ startupCwd: '/home/me/repo' }), cwdOf: () => APP });
    expect(noDistro).toMatchObject({ ok: false, code: 'not_a_repo' });
    expect(git).not.toHaveBeenCalled();
  });

  it('a WSL pane\'s Linux cwd is spelled as Windows opens it, with the pane\'s distro', async () => {
    const daemonRpc = vi.fn(async () => [{ id: 'pty-a', wslTarget: { distribution: 'Ubuntu' } }, { id: 'pty-b' }]);
    const cwdOf = (p: string) => (p === 'pty-a' ? '/home/me/repo' : '/mnt/d/src/app');
    expect(await workspaceFolders('ws-1', entries()(), cwdOf, { platform: 'win32', daemonRpc }))
      .toEqual(['\\\\wsl$\\Ubuntu\\home\\me\\repo', 'D:\\src\\app']);
    // No distro known: only the drive mount translates; nothing is guessed.
    expect(await workspaceFolders('ws-1', entries()(), cwdOf, { platform: 'win32' })).toEqual(['D:\\src\\app']);
    // Elsewhere a Linux cwd is a real path.
    expect(await workspaceFolders('ws-1', entries()(), cwdOf, { platform: 'linux' })).toEqual(['/home/me/repo', '/mnt/d/src/app']);
  });

  it('an add after a team never asks again: the team\'s repository, or its None', async () => {
    const names = { coordinator: 'Lead', researcher: 'Res', developer: 'Dev', issue: 'Iss', reviewer: 'Rev' };
    const git = appGit();
    const deps = { realpath: (p: string) => p, homeDir: HOME, records, git, entries: entries(), cwdOf: () => APP };
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-1', names, repoFolder: APP }, deps)).toMatchObject({ ok: true });
    expect(records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/app' } });
    git.mockClear();
    expect(await suggestBotRepo(store, 'ws-1', deps)).toMatchObject({ ok: true, inherited: true });
    expect(git).not.toHaveBeenCalled();
    // A team made with no repository (None): the next add is not asked either.
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-2', names, noRepo: true }, deps)).toMatchObject({ ok: true });
    expect(await suggestBotRepo(store, 'ws-2', { ...deps, entries: () => [{ id: 'ws-2', name: 'Two', activePtyId: 'pty-a' }] })).toEqual({ ok: false, code: 'none' });
    expect(git).not.toHaveBeenCalled();
  });

  it('None first, then Add bot with a picked repository: the earlier bots get it too, and the runtime is told', async () => {
    const told = vi.fn();
    const deps = { git: fakeGit(ok('/src/app\n'), ok('https://github.com/acme/app.git\n')), realpath: (p: string) => p, records, profileChanged: told };
    const first = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Ann', noRepo: true }, deps);
    if (!first.ok) throw new Error('not made');
    expect(first.bot.repo).toBeUndefined();
    // A bot on another workspace, and one with a repository of its own, stay as they are.
    const far = await createBotFromFolder(store, { workspaceId: 'ws-2', name: 'Far' }, deps);
    if (!far.ok) throw new Error('not made');
    const second = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Bo', repoFolder: '/src/app' }, deps);
    if (!second.ok) throw new Error('not made');
    expect(store.get(first.bot.id)?.repo).toMatchObject({ repoKey: 'github.com/acme/app' });
    expect(told).toHaveBeenCalledWith(first.bot.id);
    expect(told).not.toHaveBeenCalledWith(second.bot.id);
    expect(store.get(far.bot.id)?.repo).toBeUndefined();
    expect(records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/app' } });
    // A None is this bot's: it takes no repository, and takes none from anyone.
    const cy = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Cy', noRepo: true }, deps);
    expect(cy.ok && cy.bot.repo).toBeUndefined();
    expect(store.get(first.bot.id)?.repo).toMatchObject({ repoKey: 'github.com/acme/app' });
    expect(records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/app' } });
  });

  it('a repository a bot already holds fills nobody: a bot added with None keeps none when a later bot inherits it', async () => {
    const told = vi.fn();
    const deps = { git: fakeGit(ok('/src/app\n'), ok('https://github.com/acme/app.git\n')), realpath: (p: string) => p, records, profileChanged: told };
    const a = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Ann', repoFolder: '/src/app' }, deps);
    if (!a.ok) throw new Error('not made');
    const b = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Bo', noRepo: true }, deps);
    if (!b.ok) throw new Error('not made');
    told.mockClear();
    const c = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Cy' }, deps);
    expect(c.ok && c.bot.repo).toMatchObject({ repoKey: 'github.com/acme/app' });
    expect(store.get(b.bot.id)?.repo).toBeUndefined();
    expect(told).not.toHaveBeenCalledWith(b.bot.id);
    // A team added there inherits it too, and still fills nobody.
    const names = { coordinator: 'Lead', researcher: 'Res', developer: 'Dev', issue: 'Iss', reviewer: 'Rev' };
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-1', names }, deps)).toMatchObject({ ok: true });
    expect(store.get(b.bot.id)?.repo).toBeUndefined();
    expect(records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/app' } });
  });

  it('None and a check that could not be made are honoured: no repository is inherited, and only None is remembered', async () => {
    const git = vi.fn();
    records.setRepo('ws-1', { repoKey: 'github.com/acme/app', repoPath: APP });
    const held = store.create({ workspaceId: 'ws-2', name: 'Held', repo: { repoKey: 'github.com/acme/app', repoPath: APP } });
    if (!held.ok) throw new Error('not made');
    const names = { coordinator: 'Lead', researcher: 'Res', developer: 'Dev', issue: 'Iss', reviewer: 'Rev' };
    const none = await createBotFromFolder(store, { workspaceId: 'ws-2', name: 'Ann', noRepo: true }, { git, records });
    expect(none.ok && none.bot.repo).toBeUndefined();
    const team = await createTeamFromFolder(store, { workspaceId: 'ws-2', names, noRepo: true }, { git, records });
    expect(team.ok && team.bots.map((b) => b.repo)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    // A None where a bot holds the repository keeps the repository remembered.
    expect(records.get('ws-2')).toBeNull();
    // Unchecked: no repository, nothing remembered.
    const unchecked = await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Bo', noInherit: true }, { git, records });
    expect(unchecked.ok && unchecked.bot.repo).toBeUndefined();
    expect(records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/app' } });
    // A None where no bot holds the remembered repository replaces it.
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Cy', noRepo: true }, { git, records })).toMatchObject({ ok: true });
    expect(records.get('ws-1')).toMatchObject({ none: true });
    expect(git).not.toHaveBeenCalled();
  });

  it('a None saved while the suggestion reads the folder is the answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const git = vi.fn(async (args: string[]) => {
      await gate;
      return args[0] === 'rev-parse' ? ok(`${APP}\n`) : ok('git@github.com:acme/app.git\n');
    });
    const pending = suggestBotRepo(store, 'ws-1', { realpath: (p: string) => p, homeDir: HOME, records, git, entries: entries(), cwdOf: () => APP });
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Ann', noRepo: true }, { records })).toMatchObject({ ok: true });
    release();
    expect(await pending).toEqual({ ok: false, code: 'none' });
  });

  it('a team with a repository fills the workspace\'s earlier bots without one; a bot on another repository keeps it', async () => {
    const told = vi.fn();
    const app = { git: fakeGit(ok('/src/app\n'), ok('https://github.com/acme/app.git\n')), realpath: (p: string) => p, records, profileChanged: told };
    const bare = store.create({ workspaceId: 'ws-1', name: 'Bare' });
    if (!bare.ok) throw new Error('not made');
    const names = { coordinator: 'Lead', researcher: 'Res', developer: 'Dev', issue: 'Iss', reviewer: 'Rev' };
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-1', names, repoFolder: '/src/app' }, app)).toMatchObject({ ok: true });
    expect(store.get(bare.bot.id)?.repo).toMatchObject({ repoKey: 'github.com/acme/app' });
    expect(told).toHaveBeenCalledWith(bare.bot.id);
    // Filled straight from the record, a bot on another repository is not touched.
    const other = store.create({ workspaceId: 'ws-3', name: 'Api', repo: { repoKey: 'github.com/acme/api', repoPath: '/src/api' } });
    const none = store.create({ workspaceId: 'ws-3', name: 'None' });
    if (!other.ok || !none.ok) throw new Error('not made');
    expect(recordWorkspaceRepo(store, 'ws-3', { repoKey: 'github.com/acme/app', repoPath: '/src/app' }, { records, profileChanged: told })).toEqual([none.bot.id]);
    expect(store.get(other.bot.id)?.repo).toMatchObject({ repoKey: 'github.com/acme/api' });
  });

  it('a remembered repository no bot holds is resolved again before a new bot takes it, and offered with Change', async () => {
    records.setRepo('ws-1', { repoKey: 'github.com/acme/app', repoPath: APP, originPin: 'git@github.com:acme/app.git' });
    const git = appGit();
    expect(workspaceRepo(store, 'ws-1', records)).toEqual({ repoKey: 'github.com/acme/app', repoPath: APP, originPin: 'git@github.com:acme/app.git' });
    expect(await suggestBotRepo(store, 'ws-1', { realpath: (p: string) => p, homeDir: HOME, records, git }))
      .toMatchObject({ ok: true, repoKey: 'github.com/acme/app', root: APP, inherited: false });
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Ann' }, { git, realpath: (p: string) => p, records })).toMatchObject({ ok: true, bot: { repo: { repoKey: 'github.com/acme/app' } } });
    expect(git).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], APP);
  });

  it('a remembered repository whose folder is gone, untrusted, or now names another repository or pin is forgotten', async () => {
    const remembered = { repoKey: 'github.com/acme/app', repoPath: APP, originPin: 'git@github.com:acme/app.git' };
    const dubious: GitResult = { stdout: '', stderr: `fatal: detected dubious ownership in repository at '${APP}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory '${APP}'\n`, code: 128 };
    const cases: Array<[string, ReturnType<typeof fakeGit>]> = [
      ['gone', fakeGit(fail, fail)],
      ['untrusted', fakeGit(dubious, fail)],
      ['another repository', fakeGit(ok(`${APP}\n`), ok('git@github.com:acme/api.git\n'))],
      ['another pin', fakeGit(ok(`${APP}\n`), ok('https://github.com/acme/app.git\n'))],
    ];
    for (const [why, git] of cases) {
      records.setRepo('ws-1', remembered);
      const r = await createBotFromFolder(store, { workspaceId: 'ws-1', name: `Bot ${why}` }, { git, realpath: (p: string) => p, records });
      expect(r.ok && r.bot.repo, why).toBeUndefined();
      expect(records.get('ws-1'), why).toBeNull();
    }
  });

  it('an add that inherits and an add with another folder at once never leave the workspace on two repositories', async () => {
    records.setRepo('ws-1', { repoKey: 'github.com/acme/app', repoPath: APP, originPin: 'git@github.com:acme/app.git' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowApp = vi.fn(async (args: string[]) => {
      await gate;
      if (args[0] === 'rev-parse') return ok(`${APP}\n`);
      if (args.includes('config')) return ok('local\0remote.origin.url\ngit@github.com:acme/app.git\0');
      return ok('git@github.com:acme/app.git\n');
    });
    const api = { git: fakeGit(ok('/src/api\n'), ok('git@github.com:acme/api.git\n')), realpath: (p: string) => p, records };
    const inheriting = createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Ann' }, { git: slowApp, realpath: (p: string) => p, records });
    const picking = createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Bo', repoFolder: '/src/api' }, api);
    await new Promise((r) => setTimeout(r, 0));
    release();
    const results = await Promise.all([inheriting, picking]);
    const keys = new Set(store.list({ workspaceId: 'ws-1' }).map((b) => b.repo?.repoKey));
    expect(keys.size, JSON.stringify(results)).toBe(1);
    expect(results[1]).toMatchObject({ ok: false, code: 'repo_mismatch' });
  });

  it('a picked folder replaces a remembered repository no bot holds; one a bot holds still refuses it', async () => {
    records.setRepo('ws-1', { repoKey: 'github.com/acme/app', repoPath: APP });
    const api = { git: fakeGit(ok('/src/api\n'), ok('git@github.com:acme/api.git\n')), realpath: (p: string) => p, records };
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Ann', repoFolder: '/src/api' }, api)).toMatchObject({ ok: true, bot: { repo: { repoKey: 'github.com/acme/api' } } });
    expect(records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/api' } });
    const app = { git: appGit(), realpath: (p: string) => p, records };
    expect(await createBotFromFolder(store, { workspaceId: 'ws-1', name: 'Bo', repoFolder: APP }, app)).toMatchObject({ ok: false, code: 'repo_mismatch' });
  });

  it('a profile Change gives the repository to the workspace\'s bots without one; another repository stays repo_mismatch', async () => {
    const app = { git: fakeGit(ok('/src/app\n'), ok('https://github.com/acme/app.git\n')), realpath: (p: string) => p, records };
    const api = { git: fakeGit(ok('/src/api\n'), ok('git@github.com:acme/api.git\n')), realpath: (p: string) => p, records };
    const names = { coordinator: 'Lead', researcher: 'Res', developer: 'Dev', issue: 'Iss', reviewer: 'Rev' };
    const team = await createTeamFromFolder(store, { workspaceId: 'ws-1', names }, app);
    if (!team.ok) throw new Error('no team');
    const [lead, ...rest] = team.bots;
    const changed = await botRepoFromFolder(store, lead.id, '/src/app', app);
    if (!changed.ok) throw new Error('not resolved');
    expect(store.update(lead.id, { repo: changed.repo }).ok).toBe(true);
    const told = vi.fn();
    expect(recordWorkspaceRepo(store, 'ws-1', changed.repo, { records, profileChanged: told }).sort()).toEqual(rest.map((b) => b.id).sort());
    expect(told.mock.calls.map((c) => c[0]).sort()).toEqual(rest.map((b) => b.id).sort());
    for (const b of rest) expect(store.get(b.id)?.repo).toMatchObject({ repoKey: 'github.com/acme/app' });
    expect(records.get('ws-1')).toMatchObject({ repo: { repoKey: 'github.com/acme/app' } });
    expect(await botRepoFromFolder(store, rest[0].id, '/src/api', api)).toMatchObject({ ok: false, code: 'repo_mismatch' });
  });
});

describe('factoryBotSuggestRepoHandler (IPC guard)', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;

  it('answers only the main window\'s top frame, and reads only the workspace id from the request', async () => {
    const git = fakeGit(ok('/src/app\n'), ok('git@github.com:acme/app.git\n'));
    const cwdOf = vi.fn(() => '/src/app');
    const handler = factoryBotSuggestRepoHandler(() => win, {
      // A Linux host: on Windows a Linux-shaped cwd is a WSL pane's.
      store: () => store, git, realpath: (p) => p, homeDir: '/home/me', cwdOf, platform: 'linux',
      entries: () => [{ id: 'ws-1', name: 'App', activePtyId: 'pty-a' }],
    });
    const req = { workspaceId: 'ws-1', folder: '/evil', cwd: '/evil' };
    expect(await handler({ sender: {}, senderFrame: mainFrame }, req)).toEqual({ ok: false, code: 'operator_only' });
    expect(await handler({ sender: webContents, senderFrame: { id: 'sub' } }, req)).toEqual({ ok: false, code: 'operator_only' });
    expect(git).not.toHaveBeenCalled();
    expect(await handler({ sender: webContents, senderFrame: mainFrame }, req))
      .toEqual({ ok: true, repoKey: 'github.com/acme/app', root: '/src/app', displayRoot: '/src/app', inherited: false });
    expect(cwdOf).toHaveBeenCalledWith('pty-a');
    expect(git).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], '/src/app');
  });
});

describe('factoryBotCreateHandler (IPC guard)', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;
  const git = fakeGit(ok('/src/app\n'), ok('git@github.com:acme/app.git\n'));

  it('answers only the main window\'s top frame; anything else changes nothing', async () => {
    const greet = vi.fn();
    const handler = factoryBotCreateHandler(() => win, { store: () => store, git, realpath: (p) => p, greet });
    const req = { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' };
    expect(await handler({ sender: {}, senderFrame: mainFrame }, req)).toMatchObject({ ok: false, code: 'operator_only' });
    expect(await handler({ sender: webContents, senderFrame: { id: 'sub' } }, req)).toMatchObject({ ok: false, code: 'operator_only' });
    expect(await factoryBotCreateHandler(() => null, { store: () => store, git })({ sender: webContents, senderFrame: mainFrame }, req))
      .toMatchObject({ ok: false, code: 'operator_only' });
    expect(git).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(greet).not.toHaveBeenCalled();
    expect(await handler({ sender: webContents, senderFrame: mainFrame }, req)).toMatchObject({ ok: true, bot: { role: 'lead' } });
    expect(store.list()).toHaveLength(1);
    // The added bot greets the owner once; a refused add greets nobody.
    expect(greet).toHaveBeenCalledTimes(1);
    expect(greet.mock.calls[0][0]).toMatchObject({ id: store.list()[0].id });
    await handler({ sender: webContents, senderFrame: mainFrame }, { workspaceId: 'ws-1', template: 'nope' });
    expect(greet).toHaveBeenCalledTimes(1);
  });
});

describe('factorySettingsSetHandler (IPC guard)', () => {
  it('writes only for the main window\'s top frame', async () => {
    const mainFrame = { id: 'top' };
    const webContents = { mainFrame };
    const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;
    const update = vi.fn(async (p: unknown) => ({ ...settings(), ...(p as object) }));
    const handler = factorySettingsSetHandler(() => win, () => ({ update, get: () => settings() }) as unknown as FactorySettingsStore);
    expect(await handler({ sender: {}, senderFrame: mainFrame }, { enabled: true })).toBeNull();
    expect(await handler({ sender: webContents, senderFrame: { id: 'sub' } }, { enabled: true })).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(await handler({ sender: webContents, senderFrame: mainFrame }, { enabled: true })).toMatchObject({ enabled: true });
    expect(update).toHaveBeenCalledWith({ enabled: true });
  });
});

describe('greetNewBot', () => {
  it('queues one intro wake for an enabled bot, pinned to its 1:1 thread, and none for a disabled bot or without a queue', () => {
    const enqueue = vi.fn((input: unknown) => ({ id: 'w-1', ...(input as object) }) as never);
    const bot = { id: 'bot-0a1b2c3d', workspaceId: 'ws-1', enabled: true };
    expect(greetNewBot(bot, enqueue)).toMatchObject({ id: 'w-1' });
    expect(enqueue).toHaveBeenCalledWith({ botId: 'bot-0a1b2c3d', workspaceId: 'ws-1', reason: { kind: 'intro' }, priority: 0, threadId: 'dm:bot-0a1b2c3d' });
    expect(greetNewBot({ ...bot, enabled: false }, enqueue)).toBeNull();
    expect(greetNewBot(bot, null)).toBeNull();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('"Add team"', () => {
  const names = { coordinator: '대장', researcher: '시장조사', developer: '구현', issue: '이슈처리', reviewer: '리뷰어' };
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;

  it('makes the five bots in order, coordinator first, on one repository read once', async () => {
    const git = fakeGit(ok('/src/app\n'), ok('git@github.com:acme/app.git\n'));
    const r = await createTeamFromFolder(store, { workspaceId: 'ws-1', names, repoFolder: '/src/app' }, { git, realpath: (p) => p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bots.map((b) => [b.template, b.name])).toEqual([
      ['coordinator', '대장'], ['researcher', '시장조사'], ['developer', '구현'], ['issue', '이슈처리'], ['reviewer', '리뷰어'],
    ]);
    expect(r.bots.every((b) => b.repo?.repoKey === 'github.com/acme/app' && b.repo.repoPath === path.normalize('/src/app'))).toBe(true);
    // The root, get-url, the common git dir and its config: once for the team.
    expect(git).toHaveBeenCalledTimes(4);
    expect(r.bots.every((b) => b.repo?.originPin === 'git@github.com:acme/app.git')).toBe(true);
    // The coordinator is the oldest of them: the room's lead.
    expect(r.bots[0].createdAt).toBeLessThanOrEqual(Math.min(...r.bots.map((b) => b.createdAt)));
  });

  it('refuses before making any bot: a name taken or missing', async () => {
    store.create({ workspaceId: 'ws-2', template: 'custom', name: '구현' });
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-2', names })).toMatchObject({ ok: false, code: 'name_taken' });
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-3', names: { ...names, issue: '대장' } })).toMatchObject({ ok: false, code: 'name_taken' });
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-3', names: { ...names, reviewer: ' ' } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.list({ workspaceId: 'ws-2' })).toHaveLength(1);
    expect(store.list({ workspaceId: 'ws-3' })).toEqual([]);
    // Without a folder the team takes the workspace's repository, when it has one.
    store.create({ workspaceId: 'ws-5', template: 'custom', name: 'Old', repo: { repoKey: 'github.com/acme/old', repoPath: '/src/old' } });
    const inherited = await createTeamFromFolder(store, { workspaceId: 'ws-5', names }, { git: fakeGit(ok('/src/old\n'), ok('https://github.com/acme/old.git\n')), realpath: (p) => p });
    expect(inherited.ok && inherited.bots.every((b) => b.repo?.repoKey === 'github.com/acme/old')).toBe(true);
  });

  it('fills a partial team in: only the missing templates, and a whole team makes nothing', async () => {
    store.create({ workspaceId: 'ws-4', template: 'coordinator', name: 'Boss' });
    store.create({ workspaceId: 'ws-4', template: 'developer', name: 'Dev' });
    // The present templates' names are not needed (nor checked against the workspace's).
    const r = await createTeamFromFolder(store, { workspaceId: 'ws-4', names: { ...names, coordinator: 'Boss', developer: '' } });
    expect(r).toMatchObject({ ok: true, skipped: ['coordinator', 'developer'] });
    expect(r.ok && r.bots.map((b) => [b.template, b.name])).toEqual([['researcher', '시장조사'], ['issue', '이슈처리'], ['reviewer', '리뷰어']]);
    expect(store.list({ workspaceId: 'ws-4' })).toHaveLength(5);
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-4', names })).toEqual({ ok: true, bots: [], skipped: ['coordinator', 'researcher', 'developer', 'issue', 'reviewer'] });
    expect(store.list({ workspaceId: 'ws-4' })).toHaveLength(5);
  });

  it('a bot that is off does not fill its role: a disabled lead gets a new one, named apart', async () => {
    const off = store.create({ workspaceId: 'ws-6', template: 'coordinator', name: 'Boss' });
    if (!off.ok) throw new Error('create');
    store.update(off.bot.id, { enabled: false });
    const r = await createTeamFromFolder(store, { workspaceId: 'ws-6', names: { ...names, coordinator: 'Boss 2' } });
    expect(r.ok && r.bots.map((b) => b.template)).toEqual(['coordinator', 'researcher', 'developer', 'issue', 'reviewer']);
    expect(r).not.toHaveProperty('skipped');
  });

  it('all five or none: a create refused midway takes back the ones made', async () => {
    const real = store.create.bind(store);
    let n = 0;
    const spy = vi.spyOn(store, 'create').mockImplementation((input) => (++n === 3 ? { ok: false, code: 'invalid_argument', message: 'no' } : real(input)));
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-9', names })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(store.list({ workspaceId: 'ws-9' })).toEqual([]);
    spy.mockRestore();
    // So the same team can be added again.
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-9', names })).toMatchObject({ ok: true });
  });

  it('answers only the main window, and only the coordinator greets the owner', async () => {
    const greet = vi.fn();
    const handler = factoryBotCreateTeamHandler(() => win, { store: () => store, greet });
    expect(await handler({ sender: {}, senderFrame: mainFrame }, { workspaceId: 'ws-1', names })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(store.list()).toEqual([]);
    const r = await handler({ sender: webContents, senderFrame: mainFrame }, { workspaceId: 'ws-1', names });
    expect(r).toMatchObject({ ok: true });
    expect(greet).toHaveBeenCalledTimes(1);
    expect(greet.mock.calls[0][0]).toMatchObject({ template: 'coordinator', name: '대장' });
    // A lead already there: the missing bots are made and none greets.
    store.create({ workspaceId: 'ws-2', template: 'coordinator', name: 'Boss' });
    expect(await handler({ sender: webContents, senderFrame: mainFrame }, { workspaceId: 'ws-2', names })).toMatchObject({ ok: true, skipped: ['coordinator'] });
    expect(greet).toHaveBeenCalledTimes(1);
  });
});

describe('Archive: FACTORY_BOT_CLEAR_REMOVED', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;

  it('answers only the main window, checks the id, and marks a kept tombstone', () => {
    const made = store.create({ workspaceId: 'ws-1', name: 'Gone' });
    if (!made.ok) throw new Error('create');
    store.remove(made.bot.id);
    const handler = factoryBotClearRemovedHandler(() => win, () => store);
    expect(handler({ sender: {}, senderFrame: mainFrame }, { botId: made.bot.id })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(handler({ sender: webContents, senderFrame: mainFrame }, { botId: '../x' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(handler({ sender: webContents, senderFrame: mainFrame }, null)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(handler({ sender: webContents, senderFrame: mainFrame }, { botId: 'bot-0000ffff' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(factoryBotClearRemovedHandler(() => win, () => null)({ sender: webContents, senderFrame: mainFrame }, { botId: made.bot.id }))
      .toMatchObject({ ok: false, code: 'not_started' });
    expect(store.listRemoved()[0].clearedAt).toBeUndefined();
    expect(handler({ sender: webContents, senderFrame: mainFrame }, { botId: made.bot.id })).toEqual({ ok: true });
    expect(store.listRemoved()[0].clearedAt).toEqual(expect.any(Number));
  });
});
