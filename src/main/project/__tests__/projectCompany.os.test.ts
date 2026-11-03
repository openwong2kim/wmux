// A company saved to its folder's wmux.json from the New company dialog: the
// save trusts the written bytes with the company marked reviewed, keeps the
// rest of the file and its grant, and never approves what somebody else wrote.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectConfigStore } from '../ProjectConfigStore';
import { readProjectCompany, saveProjectCompany } from '../projectCompany';
import { saveWorkspacePrepSettings } from '../workspacePrepSettings';
import { saveBlock, writeProjectConfig, type ProjectConfigWriteDeps } from '../projectConfigWrite';
import { companyNeedsReview, PROJECT_CONFIG_MAX_FILE_BYTES } from '../../../shared/wmuxProjectConfig';

let tmp: string;
let repo: string;
let store: ProjectConfigStore;
let deps: ProjectConfigWriteDeps;

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const wmuxJson = () => JSON.parse(fs.readFileSync(path.join(repo, 'wmux.json'), 'utf8'));
const shop = {
  name: 'shop team',
  mission: 'Ship one-click refunds by Friday',
  standingOrders: 'The CEO plans and writes no code.\nEvery PR gets a review from #reviewer.',
  ceo: 'ceo',
  seats: [
    { name: 'ceo', owns: 'Plans and hands out the work', agent: 'claude' },
    { name: 'api', owns: 'Payments API', agent: 'codex' },
    { name: 'reviewer', agent: 'claude' },
  ],
};

beforeEach(() => {
  // The long form of the path (Windows CI's temp dir is an 8.3 short name).
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-company-file-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q');
  store = new ProjectConfigStore(path.join(tmp, 'trust.json'));
  deps = {
    getState: (cwd) => store.getState(cwd),
    setTrusted: (root, hash, grant) => store.setDecision(root, 'trusted', hash, grant.unattended, grant.companyReviewed),
    grantFor: (root, hash) => store.grantFor(root, hash),
  };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('saveProjectCompany', () => {
  it('writes the company and trusts the bytes with the company reviewed', async () => {
    const view = await readProjectCompany(repo, deps);
    expect(view).toEqual({ dir: repo, exists: false });
    const r = await saveProjectCompany(repo, shop, undefined, deps);
    expect(r).toEqual({ ok: true, contentHash: expect.any(String) });
    expect(wmuxJson()).toEqual({ version: 1, company: shop });
    const state = await store.getState(repo);
    expect(state.trust).toBe('trusted');
    expect(state.companyReviewed).toBe(true);
    expect(companyNeedsReview(state)).toBe(false);
    expect(state.config?.company?.seats.map((s) => s.label)).toEqual(['ceo', 'api', 'reviewer']);
  });

  it('keeps the rest of the file and the unattended consent on its bytes', async () => {
    const raw = { version: 1, commands: [{ id: 't', title: 't', command: 'npm test' }], extra: 'kept' };
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify(raw));
    const before = await store.getState(repo);
    await store.setDecision(repo, 'trusted', before.contentHash!, true);
    const view = await readProjectCompany(repo, deps);
    expect(view.saveBlocked).toBeUndefined();
    expect((await saveProjectCompany(repo, shop, view.contentHash, deps)).ok).toBe(true);
    expect(wmuxJson()).toEqual({ ...raw, company: shop });
    const state = await store.getState(repo);
    expect(state).toMatchObject({ trust: 'trusted', unattended: true, companyReviewed: true });
  });

  it('a save of the new workspace setup keeps the company reviewed', async () => {
    const saved = await saveProjectCompany(repo, shop, undefined, deps);
    expect(saved.ok).toBe(true);
    const r = await saveWorkspacePrepSettings(repo, { copy: [], setup: 'npm ci', portRange: '', copyIntoAutomated: false }, saved.ok ? saved.contentHash : undefined, deps);
    expect(r.ok).toBe(true);
    expect(wmuxJson().company).toEqual(shop);
    expect(await store.getState(repo)).toMatchObject({ trust: 'trusted', companyReviewed: true });
  });

  it('never saves over a file holding something not approved here', async () => {
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, company: { ...shop, name: 'theirs' } }));
    const view = await readProjectCompany(repo, deps);
    expect(view.saveBlocked).toBe('review-first');
    expect(view.company?.name).toBe('theirs');
    expect(await saveProjectCompany(repo, shop, view.contentHash, deps)).toEqual({ ok: false, error: 'review-first' });
    expect((await store.getState(repo)).trust).toBe('untrusted');
  });

  it('never approves a copy list it did not show', async () => {
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, fanout: { copy: ['.env'], copyIntoAutomated: true } }));
    const view = await readProjectCompany(repo, deps);
    expect(view.saveBlocked).toBe('review-first');
    expect(await saveProjectCompany(repo, shop, view.contentHash, deps)).toEqual({ ok: false, error: 'review-first' });
    expect((await store.getState(repo)).trust).toBe('untrusted');
  });

  it('asks for review first when a file not approved here holds more than the company', async () => {
    for (const raw of [
      { version: 1, fanout: { portRange: '3000-3010' } },
      { version: 1, fanout: { portRange: '3000-3010', setup: 42 } },
      { version: 1, fanout: { portRange: '3000-3010' }, notes: 'a key wmux does not know' },
    ]) {
      const text = JSON.stringify(raw);
      fs.writeFileSync(path.join(repo, 'wmux.json'), text);
      const view = await readProjectCompany(repo, deps);
      expect(view.saveBlocked).toBe('review-first');
      expect(await saveProjectCompany(repo, shop, view.contentHash, deps)).toEqual({ ok: false, error: 'review-first' });
      expect(fs.readFileSync(path.join(repo, 'wmux.json'), 'utf8')).toBe(text);
      expect((await store.getState(repo)).trust).toBe('untrusted');
    }
  });

  it('writes only the wmux.json its folder check found', async () => {
    const sub = path.join(repo, 'packages', 'web');
    fs.mkdirSync(sub, { recursive: true });
    const text = JSON.stringify({ version: 1, commands: [{ id: 't', title: 't', command: 'npm test' }] });
    fs.writeFileSync(path.join(sub, 'wmux.json'), text);
    fs.writeFileSync(path.join(repo, 'wmux.json'), text);
    const { contentHash } = await store.getState(repo);
    await store.setDecision(repo, 'trusted', contentHash ?? '', false);
    // The folder's own file goes away after the folder check, leaving the one above it.
    let calls = 0;
    const racing: ProjectConfigWriteDeps = {
      ...deps,
      getState: async (cwd) => {
        const state = await store.getState(cwd);
        if (++calls === 1) fs.rmSync(path.join(sub, 'wmux.json'));
        return state;
      },
    };
    expect(await saveProjectCompany(sub, shop, contentHash, racing)).toEqual({ ok: false, error: 'changed' });
    expect(fs.readFileSync(path.join(repo, 'wmux.json'), 'utf8')).toBe(text);
    expect((await store.getState(repo)).companyReviewed).toBe(false);
  });

  it('trusts the folder as the dialog names it, also when it is reached through a link', async () => {
    if (process.platform === 'win32') return;
    const link = path.join(tmp, 'linked');
    fs.symlinkSync(repo, link);
    expect((await saveProjectCompany(link, shop, undefined, deps)).ok).toBe(true);
    expect(await store.getState(link)).toMatchObject({ trust: 'trusted', companyReviewed: true });
    expect((await readProjectCompany(link, deps)).saveBlocked).toBeUndefined();
  });

  it('refuses a file changed since the dialog read it', async () => {
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, fanout: { portRange: '3000-3010' } }));
    expect(await saveProjectCompany(repo, shop, 'f'.repeat(64), deps)).toEqual({ ok: false, error: 'changed' });
    expect(await saveProjectCompany(repo, shop, undefined, deps)).toEqual({ ok: false, error: 'changed' });
  });

  it('saves only into the wmux.json of the folder the company is for', async () => {
    const sub = path.join(repo, 'packages', 'web');
    fs.mkdirSync(sub, { recursive: true });
    expect(await readProjectCompany(sub, deps)).toEqual({ dir: repo, exists: false, saveBlocked: 'other-folder' });
    expect(await saveProjectCompany(sub, shop, undefined, deps)).toEqual({ ok: false, error: 'other-folder' });
    expect(fs.existsSync(path.join(repo, 'wmux.json'))).toBe(false);
  });

  it('refuses a company that would not read back as asked, and a folder outside a checkout', async () => {
    expect(await saveProjectCompany(repo, { ...shop, seats: [{ name: 'ceo', agent: 'my-own-agent' }] }, undefined, deps)).toEqual({ ok: false, error: 'invalid-input' });
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    expect(await saveProjectCompany(plain, shop, undefined, deps)).toEqual({ ok: false, error: 'no-project' });
    expect(fs.existsSync(path.join(repo, 'wmux.json'))).toBe(false);
  });
});

describe('writeProjectConfig', () => {
  it('loses no edit made to the file after it was read', async () => {
    fs.writeFileSync(path.join(repo, 'wmux.json'), JSON.stringify({ version: 1, fanout: { portRange: '3000-3010' } }));
    const { contentHash } = await store.getState(repo);
    const theirs = JSON.stringify({ version: 1, fanout: { portRange: '4000-4010' } });
    const r = await writeProjectConfig(repo, contentHash, (doc) => {
      fs.writeFileSync(path.join(repo, 'wmux.json'), theirs);
      doc.company = shop;
      return true;
    }, (prior) => prior, { copy: false }, deps);
    expect(r).toEqual({ ok: false, error: 'changed' });
    expect(fs.readFileSync(path.join(repo, 'wmux.json'), 'utf8')).toBe(theirs);
    expect((await store.getState(repo)).trust).toBe('untrusted');
  });

  it('trusts the written bytes only for the file it wrote', async () => {
    let written = false;
    const granted: string[] = [];
    const elsewhere = path.join(tmp, 'elsewhere');
    const binding: ProjectConfigWriteDeps = {
      ...deps,
      // Read back after the write, the same bytes come from another folder's file.
      getState: async (cwd) => {
        const state = await store.getState(cwd);
        return written && state.found ? { ...state, root: elsewhere, configPath: path.join(elsewhere, 'wmux.json') } : state;
      },
      setTrusted: async (root, hash, grant) => {
        granted.push(root);
        await deps.setTrusted(root, hash, grant);
      },
    };
    const r = await writeProjectConfig(repo, undefined, (doc) => {
      written = true;
      doc.company = shop;
      return true;
    }, (prior) => prior, { copy: false }, binding);
    expect(r).toEqual({ ok: false, error: 'changed' });
    expect(granted).toEqual([]);
  });

  it('never writes a file too big to be read back', async () => {
    const raw = JSON.stringify({ version: 1, fanout: { portRange: '3000-3010' }, notes: 'x'.repeat(PROJECT_CONFIG_MAX_FILE_BYTES - 200) });
    fs.writeFileSync(path.join(repo, 'wmux.json'), raw);
    const { contentHash } = await store.getState(repo);
    await store.setDecision(repo, 'trusted', contentHash ?? '', false);
    expect(await saveProjectCompany(repo, shop, contentHash, deps)).toEqual({ ok: false, error: 'invalid-input' });
    expect(fs.readFileSync(path.join(repo, 'wmux.json'), 'utf8')).toBe(raw);
  });
});

describe('saveBlock', () => {
  it('asks for review of a file not approved here that holds a key the save does not show, known or not', () => {
    const shows = { copy: false, only: ['version', 'company'] };
    const untrusted = { found: true, trust: 'untrusted', config: { version: 1 } } as const;
    expect(saveBlock(untrusted, shows, { version: 1, company: { name: 'x' } })).toBeUndefined();
    expect(saveBlock(untrusted, shows, { version: 1, notes: 'x' })).toBe('review-first');
    expect(saveBlock({ ...untrusted, trust: 'trusted' }, shows, { version: 1, notes: 'x' })).toBeUndefined();
    expect(saveBlock(untrusted, { copy: true }, { version: 1, notes: 'x' })).toBeUndefined();
  });
});
