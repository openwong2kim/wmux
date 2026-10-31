// Placing a conversation another PC handed over where Claude Code reads it:
// the project folder of the pane's exact folder, an earlier state of the
// same files taken over and put back, refusals for what has moved on, a
// link, a folder outside the request's worktree, a full disk and a long path,
// and a copy where a rename cannot cross volumes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostId } from '../../../shared/a2aRemote';
import type { A2aContinueManifestV1 } from '../../../shared/a2aContinue';
import { claudeProjectFolder } from '../../../shared/claudeProjectFolder';
import { ContinuePlacer, type ContinuePlacerDeps } from '../continuePlacer';
import type { ContinueRequestRecordV1 } from '../continueRequestStore';
import { continueStagingDir } from '../continueStaging';

const HOST = '11111111-1111-4111-8111-111111111111' as HostId;
const CID = 'ct-9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SID = '0f1e2d3c-4b5a-4697-8877-665544332211';
const TRANSCRIPT = '{"turn":1}\n{"turn":2}\n';
const FILES: Record<string, string> = { 'tool-results/a.txt': 'result a, whole', 'subagents/agent-1.jsonl': '{"sub":1}\n' };

let root: string;
let a2aDir: string;
let worktrees: string;
let configDir: string;
let cwd: string;
let staging: string;
let state: ContinueRequestRecordV1['state'];

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

function manifest(files: Record<string, string> = FILES): A2aContinueManifestV1 {
  return {
    v: 1,
    continueId: CID,
    head: 'a'.repeat(40),
    transcript: { sha256: sha(TRANSCRIPT), bytes: Buffer.byteLength(TRANSCRIPT) },
    files: Object.entries(files).map(([rel, body]) => ({ rel, sha256: sha(body), bytes: Buffer.byteLength(body) })),
  };
}

let held: A2aContinueManifestV1;
const record = (): ContinueRequestRecordV1 => ({
  v: 1,
  hostId: HOST,
  request: {
    v: 1, continueId: CID, sessionId: SID, agent: 'claude',
    repo: { origin: 'github.com/acme/widget', branch: 'main', head: 'a'.repeat(40) },
    estimate: { bytes: 100, files: 2 }, expiresAt: '2099-01-01T00:00:00.000Z',
  },
  manifest: held,
  state,
  rootId: 'web',
  receivedAt: '2026-10-29T12:00:00.000Z',
  updatedAt: '2026-10-29T12:00:00.000Z',
});

function placer(over: Partial<ContinuePlacerDeps> = {}): ContinuePlacer {
  return new ContinuePlacer({
    a2aDir,
    worktreesRoot: worktrees,
    requests: { get: (h, c) => (h === HOST && c === CID ? record() : undefined) },
    env: () => ({ CLAUDE_CONFIG_DIR: configDir }),
    freeBytes: async () => 1024 * 1024 * 1024,
    log: () => undefined,
    // The Windows path limit has its own test: a long CI temp dir must not trip it everywhere.
    platform: 'linux',
    ...over,
  });
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const projectDir = (): string => path.join(configDir, 'projects', claudeProjectFolder(cwd));
const read = (file: string): string => fs.readFileSync(file, 'utf8');

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-continue-place-')));
  a2aDir = path.join(root, 'a2a');
  worktrees = path.join(root, 'worktrees');
  configDir = path.join(root, 'claude');
  cwd = path.join(worktrees, `continue-${CID}`, 'apps');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(configDir);
  staging = continueStagingDir(a2aDir, HOST, CID);
  write(path.join(staging, `${SID}.jsonl`), TRANSCRIPT);
  for (const [rel, body] of Object.entries(FILES)) write(path.join(staging, SID, ...rel.split('/')), body);
  held = manifest();
  state = 'starting';
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ContinuePlacer.place', () => {
  it('moves the staged files into the project folder of the pane\'s folder, and answers the transcript\'s path', async () => {
    const res = await placer().place(HOST, CID, cwd);
    const transcript = path.join(projectDir(), `${SID}.jsonl`);
    expect(res).toEqual({ ok: true, transcriptPath: transcript });
    expect(read(transcript)).toBe(TRANSCRIPT);
    for (const [rel, body] of Object.entries(FILES)) expect(read(path.join(projectDir(), SID, ...rel.split('/')))).toBe(body);
    // Moved, not copied.
    expect(fs.existsSync(path.join(staging, `${SID}.jsonl`))).toBe(false);
  });

  it('names the project folder after the folder\'s realpath, not the path it was given by', async () => {
    const link = path.join(root, 'via-link');
    fs.symlinkSync(path.join(worktrees, `continue-${CID}`), link, 'junction');
    const res = await placer().place(HOST, CID, path.join(link, 'apps'));
    expect(res).toEqual({ ok: true, transcriptPath: path.join(projectDir(), `${SID}.jsonl`) });
  });

  it('takes over an earlier state of the same files, and unplace puts exactly that back', async () => {
    const transcript = path.join(projectDir(), `${SID}.jsonl`);
    const a = path.join(projectDir(), SID, 'tool-results', 'a.txt');
    write(transcript, '{"turn":1}\n');
    write(a, 'result a');
    const p = placer();
    expect(await p.place(HOST, CID, cwd)).toMatchObject({ ok: true });
    expect(read(transcript)).toBe(TRANSCRIPT);
    expect(read(a)).toBe(FILES['tool-results/a.txt']);

    expect(await p.unplace(HOST, CID)).toEqual({ ok: true });
    expect(read(transcript)).toBe('{"turn":1}\n');
    expect(read(a)).toBe('result a');
    // What only the place brought goes, with the folder it made.
    expect(fs.existsSync(path.join(projectDir(), SID, 'subagents'))).toBe(false);
    expect(fs.readdirSync(path.join(projectDir(), SID))).toEqual(['tool-results']);
  });

  it('unplace after a fresh place leaves no file and no folder it made', async () => {
    const p = placer();
    expect(await p.place(HOST, CID, cwd)).toMatchObject({ ok: true });
    expect(await p.unplace(HOST, CID)).toEqual({ ok: true });
    expect(fs.readdirSync(configDir)).toEqual([]);
    // A second unplace has nothing left to take back.
    expect(await p.unplace(HOST, CID)).toMatchObject({ ok: false });
  });

  it('refuses a transcript here that is not an earlier state of the staged one, and changes nothing', async () => {
    const transcript = path.join(projectDir(), `${SID}.jsonl`);
    write(transcript, '{"turn":1}\n{"other":true}\n');
    expect(await placer().place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'diverged' });
    expect(read(transcript)).toBe('{"turn":1}\n{"other":true}\n');
    expect(read(path.join(staging, `${SID}.jsonl`))).toBe(TRANSCRIPT);
  });

  it('refuses a file of the conversation this PC holds and the manifest lacks', async () => {
    write(path.join(projectDir(), SID, 'tool-results', 'mine.txt'), 'only here');
    expect(await placer().place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'diverged' });
    expect(fs.existsSync(path.join(projectDir(), `${SID}.jsonl`))).toBe(false);
  });

  it('refuses when another project folder holds the conversation (the checkout it once ran in)', async () => {
    const projects = path.join(configDir, 'projects');
    // Other folders around it, holding other conversations, are looked past.
    write(path.join(projects, '-Users-b-other', 'ffffffff-4b5a-4697-8877-665544332211.jsonl'), '{}\n');
    write(path.join(projects, '-Users-b-repo', `${SID}.jsonl`), '{"turn":1}\n');
    expect(await placer().place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'diverged' });
    expect(fs.existsSync(projectDir())).toBe(false);
    expect(read(path.join(staging, `${SID}.jsonl`))).toBe(TRANSCRIPT);

    // Its folder alone counts as well.
    fs.rmSync(path.join(projects, '-Users-b-repo'), { recursive: true });
    fs.mkdirSync(path.join(projects, '-Users-b-repo', SID, 'tool-results'), { recursive: true });
    expect(await placer().place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'diverged' });

    // With no copy elsewhere it places.
    fs.rmSync(path.join(projects, '-Users-b-repo'), { recursive: true });
    expect(await placer().place(HOST, CID, cwd)).toMatchObject({ ok: true });
  });

  it('refuses a project folder that is a link: whether it holds the conversation is not looked up through it', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    write(path.join(elsewhere, `${SID}.jsonl`), '{"turn":1}\n');
    fs.mkdirSync(path.join(configDir, 'projects'));
    fs.symlinkSync(elsewhere, path.join(configDir, 'projects', '-Users-b-linked'), 'junction');
    expect(await placer().place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'failed' });
    expect(fs.existsSync(projectDir())).toBe(false);
  });

  it('refuses a projects folder that is a link', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(configDir, 'projects'), 'junction');
    expect(await placer().place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'failed' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('copies, syncs and renames into place when a rename would cross volumes, and puts back the same way', async () => {
    const transcript = path.join(projectDir(), `${SID}.jsonl`);
    write(transcript, '{"turn":1}\n');
    // Every rename between two folders fails as a rename across volumes does; one within a folder works.
    const rename = async (from: string, to: string): Promise<void> => {
      if (path.dirname(from) !== path.dirname(to)) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      await fs.promises.rename(from, to);
    };
    const p = placer({ rename });
    expect(await p.place(HOST, CID, cwd)).toMatchObject({ ok: true });
    expect(read(transcript)).toBe(TRANSCRIPT);
    expect(fs.existsSync(path.join(staging, `${SID}.jsonl`))).toBe(false);
    expect(fs.readdirSync(projectDir()).sort()).toEqual([SID, `${SID}.jsonl`]);
    expect(await p.unplace(HOST, CID)).toEqual({ ok: true });
    expect(read(transcript)).toBe('{"turn":1}\n');
  });

  it('puts back what was there when a step fails part way', async () => {
    const transcript = path.join(projectDir(), `${SID}.jsonl`);
    write(transcript, '{"turn":1}\n');
    // The last staged file is gone, so its move fails after the others landed.
    fs.rmSync(path.join(staging, SID, 'subagents', 'agent-1.jsonl'));
    expect(await placer().place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'failed' });
    expect(read(transcript)).toBe('{"turn":1}\n');
    expect(fs.readdirSync(projectDir())).toEqual([`${SID}.jsonl`]);
  });

  it('refuses a request that is not starting', async () => {
    state = 'received';
    expect(await placer().place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'failed' });
    expect(fs.readdirSync(configDir)).toEqual([]);
  });

  it('refuses a folder outside the request\'s worktree', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    expect(await placer().place(HOST, CID, outside)).toMatchObject({ ok: false, code: 'failed' });
    expect(await placer().place(HOST, CID, path.join(cwd, '..', '..'))).toMatchObject({ ok: false, code: 'failed' });
    expect(fs.readdirSync(configDir)).toEqual([]);
  });

  it('refuses when the config folder\'s volume lacks the room', async () => {
    expect(await placer({ freeBytes: async () => 10 }).place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'no-space' });
  });

  it('refuses a placed path longer than Windows takes, on win32 only', async () => {
    held = manifest({ [`${'x'.repeat(110)}/${'y'.repeat(110)}`]: 'deep' });
    expect(await placer({ platform: 'win32' }).place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'path-too-long' });
    expect(await placer({ platform: 'linux', freeBytes: async () => 0 }).place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'no-space' });
  });

  it('places a request once', async () => {
    const p = placer();
    expect(await p.place(HOST, CID, cwd)).toMatchObject({ ok: true });
    expect(await p.place(HOST, CID, cwd)).toMatchObject({ ok: false, code: 'failed' });
  });

  /**
   * A placer whose move of the staged transcript waits until released, as a
   * slow place does when main stops waiting for its answer and takes it back.
   */
  function heldPlacer(): { p: ContinuePlacer; reached: Promise<void>; release: () => void } {
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => { reach = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const staged = path.join(staging, `${SID}.jsonl`);
    const rename = async (from: string, to: string): Promise<void> => {
      if (from === staged) {
        reach();
        await gate;
      }
      await fs.promises.rename(from, to);
    };
    return { p: placer({ rename }), reached, release };
  }

  it('an unplace while the place still runs waits for it, then takes back all of it', async () => {
    const transcript = path.join(projectDir(), `${SID}.jsonl`);
    write(transcript, '{"turn":1}\n');
    const { p, reached, release } = heldPlacer();
    const placing = p.place(HOST, CID, cwd);
    await reached;
    const unplacing = p.unplace(HOST, CID);
    // A second place meanwhile is refused, and a forget (main reporting failed) drops nothing.
    const second = p.place(HOST, CID, cwd);
    p.forget(HOST, CID);
    release();
    expect(await second).toMatchObject({ ok: false, code: 'failed' });
    expect(await placing).toMatchObject({ ok: true });
    expect(await unplacing).toEqual({ ok: true });
    expect(read(transcript)).toBe('{"turn":1}\n');
    expect(fs.readdirSync(projectDir())).toEqual([`${SID}.jsonl`]);
  });

  it('an unplace waiting for a place that then fails answers ok, and nothing it made remains', async () => {
    const transcript = path.join(projectDir(), `${SID}.jsonl`);
    write(transcript, '{"turn":1}\n');
    const { p, reached, release } = heldPlacer();
    const placing = p.place(HOST, CID, cwd);
    await reached;
    const unplacing = p.unplace(HOST, CID);
    // The last staged file is gone, so the place fails once released.
    fs.rmSync(path.join(staging, SID, 'subagents', 'agent-1.jsonl'));
    release();
    expect(await placing).toMatchObject({ ok: false, code: 'failed' });
    expect(await unplacing).toEqual({ ok: true });
    expect(read(transcript)).toBe('{"turn":1}\n');
    expect(fs.readdirSync(projectDir())).toEqual([`${SID}.jsonl`]);
  });

  it('uses ~/.claude when CLAUDE_CONFIG_DIR is not absolute', async () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      // Never the real home: the place below runs only once the home is the temp one.
      expect(os.homedir()).toBe(home);
      const res = await placer({ env: () => ({ CLAUDE_CONFIG_DIR: 'relative/dir' }) }).place(HOST, CID, cwd);
      expect(res).toEqual({ ok: true, transcriptPath: path.join(home, '.claude', 'projects', claudeProjectFolder(cwd), `${SID}.jsonl`) });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
