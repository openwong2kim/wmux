import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { ProjectConfigStore, normalizeProjectRoot } from '../ProjectConfigStore';
import { PROJECT_CONFIG_MAX_FILE_BYTES } from '../../../shared/wmuxProjectConfig';

let tmpRoot: string;
let trustPath: string;

function makeStore(): ProjectConfigStore {
  return new ProjectConfigStore(trustPath);
}

function writeConfig(dir: string, value: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'wmux.json');
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  return p;
}

const VALID = { version: 1, commands: [{ id: 'dev', title: 'Dev', command: 'npm run dev' }] };

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-projcfg-'));
  trustPath = path.join(tmpRoot, 'trust', 'project-trust.json');
  fs.mkdirSync(path.dirname(trustPath), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('findConfigDir — discovery walk', () => {
  it('finds wmux.json in the starting directory', () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    expect(makeStore().findConfigDir(proj)).toBe(proj);
  });

  it('walks up to a parent directory', () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const nested = path.join(proj, 'packages', 'web');
    fs.mkdirSync(nested, { recursive: true });
    expect(makeStore().findConfigDir(nested)).toBe(proj);
  });

  it('stops at a .git repo boundary without escaping', () => {
    // tmpRoot/wmux.json exists, but tmpRoot/repo has .git and no wmux.json —
    // a cwd inside repo must NOT pick up the file above the repo root.
    writeConfig(tmpRoot, VALID);
    const repo = path.join(tmpRoot, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const inside = path.join(repo, 'src');
    fs.mkdirSync(inside, { recursive: true });
    expect(makeStore().findConfigDir(inside)).toBeNull();
  });

  it('treats a .git FILE (linked worktree) as a boundary too', () => {
    writeConfig(tmpRoot, VALID);
    const wt = path.join(tmpRoot, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../somewhere');
    expect(makeStore().findConfigDir(wt)).toBeNull();
  });

  it('finds wmux.json AT the repo root', () => {
    const repo = path.join(tmpRoot, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    writeConfig(repo, VALID);
    const inside = path.join(repo, 'src', 'deep');
    fs.mkdirSync(inside, { recursive: true });
    expect(makeStore().findConfigDir(inside)).toBe(repo);
  });

  it('returns null for a nonexistent cwd', () => {
    expect(makeStore().findConfigDir(path.join(tmpRoot, 'nope'))).toBeNull();
  });
});

describe('getState — config + trust evaluation', () => {
  it('reports untrusted on first sight', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const state = await makeStore().getState(proj);
    expect(state.found).toBe(true);
    expect(state.trust).toBe('untrusted');
    expect(state.config?.commands).toHaveLength(1);
    expect(state.root).toBe(normalizeProjectRoot(proj));
    expect(state.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports invalid JSON as found+invalid without config', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, '{ not json');
    const state = await makeStore().getState(proj);
    expect(state.found).toBe(true);
    expect(state.invalid).toBe(true);
    expect(state.config).toBeUndefined();
    expect(state.trust).toBeUndefined();
  });

  it('trusted after setDecision with the matching hash', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false);
    const s2 = await store.getState(proj);
    expect(s2.trust).toBe('trusted');
  });

  it('a record from before copy settings existed does not cover them; a new decision does', async () => {
    const proj = path.join(tmpRoot, 'legacy');
    writeConfig(proj, { version: 1, fanout: { setup: 'npm ci', copy: ['.env'], copyIntoAutomated: true } });
    const hash = createHash('sha256').update(fs.readFileSync(path.join(proj, 'wmux.json'))).digest('hex');
    // What an older wmux wrote: no copy-review mark.
    fs.writeFileSync(trustPath, JSON.stringify({ schemaVersion: 1, projects: { [normalizeProjectRoot(proj)]: { status: 'trusted', contentHash: hash, decidedAt: 1 } } }));
    const legacy = await makeStore().getState(proj);
    expect(legacy).toMatchObject({ trust: 'trusted', prepReviewed: false });
    const store = makeStore();
    await store.setDecision(proj, 'trusted', hash, false);
    expect(await store.getState(proj)).toMatchObject({ trust: 'trusted', prepReviewed: true });
  });

  it('demotes to stale when the file changes after trust', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false);
    // Edit the file — e.g. a malicious PR changed a command.
    writeConfig(proj, { ...VALID, commands: [{ id: 'dev', title: 'Dev', command: 'evil.exe' }] });
    const s2 = await store.getState(proj);
    expect(s2.trust).toBe('stale');
  });

  it('denied is sticky across content changes', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'denied', s1.contentHash!, false);
    writeConfig(proj, { ...VALID, commands: [{ id: 'x', title: 'X', command: 'other' }] });
    const s2 = await store.getState(proj);
    expect(s2.trust).toBe('denied');
  });

  it('clearDecision returns the project to untrusted', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false);
    await store.clearDecision(s1.root!);
    const s2 = await store.getState(proj);
    expect(s2.trust).toBe('untrusted');
  });

  it('a grant bound to OLD bytes never trusts NEW bytes (TOCTOU)', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    // File changes while the approval dialog is open…
    writeConfig(proj, { ...VALID, commands: [{ id: 'dev', title: 'Dev', command: 'evil.exe' }] });
    // …user approves what they SAW (old hash).
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false);
    const s2 = await store.getState(proj);
    expect(s2.trust).toBe('stale'); // live bytes ≠ reviewed bytes
  });

  it('persists decisions across store instances', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false);
    const fresh = makeStore();
    const s2 = await fresh.getState(proj);
    expect(s2.trust).toBe('trusted');
  });

  it('rejects malformed content hashes', async () => {
    await expect(makeStore().setDecision(tmpRoot, 'trusted', 'nope', false)).rejects.toThrow();
  });

  it('refuses NEW roots past the entry cap but allows updates', async () => {
    // Small injected cap — the production default (512) would mean 512
    // serialized atomic disk writes, which blows the test timeout.
    const store = new ProjectConfigStore(trustPath, { entryCap: 4 });
    const hash = createHash('sha256').update('x').digest('hex');
    for (let i = 0; i < 4; i++) {
      await store.setDecision(path.join(tmpRoot, `p${i}`), 'trusted', hash, false);
    }
    await expect(store.setDecision(path.join(tmpRoot, 'overflow'), 'trusted', hash, false)).rejects.toThrow(/full/);
    // Existing root stays updatable.
    await expect(store.setDecision(path.join(tmpRoot, 'p0'), 'denied', hash, false)).resolves.toBeUndefined();
  });

  it('survives a corrupt trust file', async () => {
    fs.writeFileSync(trustPath, '%%% corrupt');
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const state = await makeStore().getState(proj);
    expect(state.trust).toBe('untrusted');
  });

  it('ignores prototype-polluting root keys safely', async () => {
    fs.writeFileSync(trustPath, JSON.stringify({
      schemaVersion: 1,
      projects: { __proto__: { status: 'trusted', contentHash: 'a'.repeat(64), decidedAt: 1 } },
    }));
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const state = await makeStore().getState(proj);
    expect(state.trust).toBe('untrusted');
    expect(({} as { status?: unknown }).status).toBeUndefined();
  });
});

describe('readText — the whole file, for a view of it', () => {
  it('reads the file getState reads, hashed over the bytes it returns', async () => {
    const proj = path.join(tmpRoot, 'proj');
    const text = '{\r\n  "version": 1,\r\n  "portRange": [1, 2],\r\n  "note": "a\u202eb"\r\n}';
    writeConfig(proj, text);
    const nested = path.join(proj, 'src');
    fs.mkdirSync(nested);
    const store = makeStore();
    const read = store.readText(nested);
    expect(read).toEqual({
      configPath: path.join(proj, 'wmux.json'),
      contentHash: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
      text,
    });
    expect(read?.contentHash).toBe((await store.getState(nested)).contentHash);
  });

  it('shows bytes that are not UTF-8 as U+FFFD, hashed over the bytes themselves', () => {
    const proj = path.join(tmpRoot, 'proj');
    fs.mkdirSync(proj);
    const bytes = Buffer.from([0x7b, 0xff, 0x7d]);
    fs.writeFileSync(path.join(proj, 'wmux.json'), bytes);
    expect(makeStore().readText(proj)).toEqual({
      configPath: path.join(proj, 'wmux.json'),
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      text: '{\ufffd}',
    });
  });

  it('reads the folder it is given, a name ending in a space included', () => {
    const proj = path.join(tmpRoot, 'proj ');
    writeConfig(proj, VALID);
    writeConfig(path.join(tmpRoot, 'proj'), { version: 1 });
    expect(makeStore().readText(proj)?.configPath).toBe(path.join(proj, 'wmux.json'));
  });

  it('reads nothing without a file, or past the size cap', () => {
    const proj = path.join(tmpRoot, 'proj');
    fs.mkdirSync(proj);
    expect(makeStore().readText(proj)).toBeNull();
    writeConfig(proj, ' '.repeat(PROJECT_CONFIG_MAX_FILE_BYTES + 1));
    expect(makeStore().readText(proj)).toBeNull();
  });
});

describe('normalizeProjectRoot', () => {
  it('strips trailing separators and lowercases on win32', () => {
    const a = normalizeProjectRoot(`${tmpRoot}${path.sep}`);
    const b = normalizeProjectRoot(tmpRoot);
    expect(a).toBe(b);
    if (process.platform === 'win32') {
      expect(normalizeProjectRoot(tmpRoot.toUpperCase())).toBe(b);
    }
  });
});

describe('setDecision — unattended reboot-survival consent (U-PERM)', () => {
  it('persists and surfaces unattended consent for trusted bytes', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, true);
    const s2 = await store.getState(proj);
    expect(s2.trust).toBe('trusted');
    expect(s2.unattended).toBe(true);
  });

  it('omits unattended when the checkbox was not ticked', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false);
    expect((await store.getState(proj)).unattended).toBe(false);
  });

  it('re-trust with consent OFF clears a prior grant — no silent carry-forward (codex P2)', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, true);
    expect((await store.getState(proj)).unattended).toBe(true);
    // Same bytes, re-trusted WITHOUT the checkbox → full-record replace drops it.
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false);
    expect((await store.getState(proj)).unattended).toBe(false);
  });

  it('does not surface unattended while the file is stale (consent bound to old bytes)', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, true);
    writeConfig(proj, { ...VALID, commands: [{ id: 'dev', title: 'Dev', command: 'other' }] });
    const s2 = await store.getState(proj);
    expect(s2.trust).toBe('stale');
    expect(s2.unattended).toBe(false); // must not apply to un-reviewed bytes
  });

  it('a denied decision forces unattended false even when requested', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'denied', s1.contentHash!, true);
    const s2 = await store.getState(proj);
    expect(s2.trust).toBe('denied');
    expect(s2.unattended ?? false).toBe(false);
  });

  it('persists unattended across store instances', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, VALID);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, true);
    expect((await makeStore().getState(proj)).unattended).toBe(true);
  });
});

describe('setDecision — the company review', () => {
  const WITH_COMPANY = { version: 1, company: { name: 'shop', seats: [{ name: 'lead', agent: 'claude' }] } };

  it('surfaces the company review only for a grant that showed it', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, WITH_COMPANY);
    const store = makeStore();
    const s1 = await store.getState(proj);
    expect(s1.companyReviewed).toBeUndefined();
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false);
    expect((await store.getState(proj)).companyReviewed).toBe(false);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false, true);
    expect((await store.getState(proj)).companyReviewed).toBe(true);
    expect(await store.grantFor(s1.root!, s1.contentHash!)).toEqual({ unattended: false, companyReviewed: true });
    expect((await makeStore().getState(proj)).companyReviewed).toBe(true);
  });

  it('is never carried to a re-trust that did not show the company, nor to changed bytes', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, WITH_COMPANY);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false, true);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false);
    expect((await store.getState(proj)).companyReviewed).toBe(false);
    await store.setDecision(s1.root!, 'trusted', s1.contentHash!, false, true);
    writeConfig(proj, { ...WITH_COMPANY, company: { ...WITH_COMPANY.company, name: 'other' } });
    const s2 = await store.getState(proj);
    expect(s2.trust).toBe('stale');
    expect(s2.companyReviewed).toBeUndefined();
    expect(await store.grantFor(s1.root!, s2.contentHash!)).toEqual({ unattended: false, companyReviewed: false });
  });

  it('a denied decision, or a record from an older wmux, never holds it', async () => {
    const proj = path.join(tmpRoot, 'proj');
    writeConfig(proj, WITH_COMPANY);
    const store = makeStore();
    const s1 = await store.getState(proj);
    await store.setDecision(s1.root!, 'denied', s1.contentHash!, false, true);
    expect((await store.getRecord(s1.root!))?.companyReviewed).toBeUndefined();
    fs.writeFileSync(trustPath, JSON.stringify({
      schemaVersion: 1,
      projects: { [s1.root!]: { status: 'denied', contentHash: s1.contentHash, decidedAt: 1, companyReviewed: true } },
    }));
    expect((await makeStore().getRecord(s1.root!))?.companyReviewed).toBeUndefined();
    fs.writeFileSync(trustPath, JSON.stringify({
      schemaVersion: 1,
      projects: { [s1.root!]: { status: 'trusted', contentHash: s1.contentHash, decidedAt: 1, prepReviewed: true } },
    }));
    expect((await makeStore().getState(proj)).companyReviewed).toBe(false);
  });
});
