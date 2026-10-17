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
import { botRepoFromFolder, createBotFromFolder, createTeamFromFolder, greetNewBot, homeShortPath, resolveBotRepo, suggestBotRepo, workspaceFolder, workspaceRepo } from '../botCreate';
import { DEFAULT_FACTORY_SETTINGS, type FactorySettings } from '../factorySettings';
import { factoryBotCreateHandler, factoryBotCreateTeamHandler, factoryBotSuggestRepoHandler, factorySettingsSetHandler } from '../../ipc/handlers/factory.handler';
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
    expect(await resolveBotRepo('/src/app', { git: fakeGit(top, fail), realpath: (p) => p })).toMatchObject({ ok: false, code: 'no_remote' });
    expect(await resolveBotRepo('/src/app', { git: fakeGit(top, ok('/srv/git/app.git\n')), realpath: (p) => p })).toMatchObject({ ok: false, code: 'no_remote' });
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

  it('a later repo bot without a folder takes the workspace\'s repo, without running git', async () => {
    await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    const git = vi.fn();
    const r = await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'verifier' }, { git });
    expect(r).toMatchObject({ ok: true, bot: { role: 'verifier', repo: { repoKey: 'github.com/acme/app', repoPath: path.normalize('/src/app') } } });
    expect(git).not.toHaveBeenCalled();
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

  it('checks the workspace\'s repo after resolving the folder (a bot added meanwhile counts)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowGit = vi.fn(async (args: string[]) => {
      await gate;
      return args[0] === 'rev-parse' ? ok('/src/api\n') : ok('git@github.com:acme/api.git\n');
    });
    const pending = createBotFromFolder(store, { workspaceId: 'ws-1', role: 'verifier', repoFolder: '/src/api' }, { git: slowGit, realpath: (p) => p });
    await createBotFromFolder(store, { workspaceId: 'ws-1', role: 'lead', repoFolder: '/src/app' }, deps);
    release();
    expect(await pending).toMatchObject({ ok: false, code: 'repo_mismatch' });
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

  it('a folder that is not a git checkout, or has no origin', async () => {
    const cwdOf = () => '/home/me/notes';
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git: fakeGit(fail, fail), entries: entries(), cwdOf })).toEqual({ ok: false, code: 'not_a_repo' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git: fakeGit(ok('/home/me/notes\n'), fail), entries: entries(), cwdOf }))
      .toEqual({ ok: false, code: 'no_remote' });
  });

  it('no folder known: no mirror, an unknown workspace, no pane, no tracked cwd, a relative cwd', async () => {
    const git = vi.fn();
    const cwd = () => '/home/me/code/app';
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: () => null, cwdOf: cwd })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-9', { ...base, git, entries: entries(), cwdOf: cwd })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries({ activePtyId: null, ptyIds: [] }), cwdOf: cwd })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries(), cwdOf: () => undefined })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries(), cwdOf: () => 'relative' })).toEqual({ ok: false, code: 'no_folder' });
    expect(await suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries() })).toEqual({ ok: false, code: 'no_folder' });
    expect(git).not.toHaveBeenCalled();
  });

  it('falls back from an active pane with no cwd to the workspace\'s other panes', () => {
    expect(workspaceFolder('ws-1', entries()(), (p) => (p === 'pty-b' ? '/x/b' : undefined))).toBe('/x/b');
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
    const pending = suggestBotRepo(store, 'ws-1', { ...base, git, entries: entries(), cwdOf: () => '/home/me/code/api' });
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

describe('factoryBotSuggestRepoHandler (IPC guard)', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;

  it('answers only the main window\'s top frame, and reads only the workspace id from the request', async () => {
    const git = fakeGit(ok('/src/app\n'), ok('git@github.com:acme/app.git\n'));
    const cwdOf = vi.fn(() => '/src/app');
    const handler = factoryBotSuggestRepoHandler(() => win, {
      store: () => store, git, realpath: (p) => p, homeDir: '/home/me', cwdOf,
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

  it('refuses before making any bot: a workspace with a coordinator, a name taken or missing', async () => {
    store.create({ workspaceId: 'ws-2', template: 'developer', name: '구현' });
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-2', names })).toMatchObject({ ok: false, code: 'name_taken' });
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-3', names: { ...names, issue: '대장' } })).toMatchObject({ ok: false, code: 'name_taken' });
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-3', names: { ...names, reviewer: ' ' } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    store.create({ workspaceId: 'ws-4', template: 'coordinator', name: 'Boss' });
    expect(await createTeamFromFolder(store, { workspaceId: 'ws-4', names })).toMatchObject({ ok: false, code: 'has_lead' });
    expect(store.list({ workspaceId: 'ws-3' })).toEqual([]);
    expect(store.list({ workspaceId: 'ws-4' })).toHaveLength(1);
    // Without a folder the team takes the workspace's repository, when it has one.
    store.create({ workspaceId: 'ws-5', template: 'custom', name: 'Old', repo: { repoKey: 'github.com/acme/old', repoPath: '/src/old' } });
    const inherited = await createTeamFromFolder(store, { workspaceId: 'ws-5', names });
    expect(inherited.ok && inherited.bots.every((b) => b.repo?.repoKey === 'github.com/acme/old')).toBe(true);
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
  });
});
