import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareNativeLauncher } from '../nativeLauncher';
import { approvedInstalledNative, nativeLauncherPath, type SelfTestVerdict } from '../../../shared/mcpLauncher';

// The copy is real; the self-test is a stand-in that passes for bytes saying
// "good", so each case decides which copies run.
let root = '';
let stableDir = '';
let source = '';
let runs = 0;
const dest = () => nativeLauncherPath(stableDir);
const asides = () => fs.readdirSync(stableDir).filter((f) => f.includes('.previous'));
const ship = (text: string) => fs.writeFileSync(source, `${text} wmux-managed: native-hooks`);
const runsIfGood = async (binary: string): Promise<SelfTestVerdict> => {
  runs++;
  return fs.readFileSync(binary, 'utf8').includes('good') ? 'pass' : 'fail';
};
const prepare = (selfTest = runsIfGood) => prepareNativeLauncher({ sourcePath: source, stableDir, selfTest });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-launcher-'));
  stableDir = path.join(root, '.wmux', 'mcp');
  fs.mkdirSync(stableDir, { recursive: true });
  fs.writeFileSync(path.join(stableDir, 'index.js'), '// bundle');
  source = path.join(root, 'resources', 'native-hooks', 'wmux-native');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  runs = 0;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('prepareNativeLauncher', () => {
  it('installs a copy that passes its self-test and offers it', async () => {
    ship('good v1');
    expect(await prepare()).toEqual({ binary: dest(), restored: false });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
  });

  it('records a pass by content hash, so the next boot does not run the self-test again', async () => {
    ship('good v1');
    await prepare();
    expect(await prepare()).toEqual({ binary: dest(), restored: false });
    expect(runs).toBe(1);
    expect(approvedInstalledNative(stableDir)).toBe(dest());
    // New bytes are a new hash: tested once more.
    ship('good v2');
    await prepare();
    expect(runs).toBe(2);
  });

  it('never deletes a copy that fails: keeps it, records it, and offers nothing', async () => {
    ship('broken v1');
    expect(await prepare()).toMatchObject({ binary: null, restored: false, reason: 'self-test failed' });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('broken v1 wmux-managed: native-hooks');
    expect(approvedInstalledNative(stableDir)).toBeNull();
    // Recorded as failing: not run again for the same bytes.
    expect(await prepare()).toMatchObject({ binary: null });
    expect(runs).toBe(1);
  });

  it('treats a timeout as unknown: nothing offered now, nothing recorded, tested again next boot', async () => {
    ship('good v1');
    expect(await prepare(async () => 'timeout')).toMatchObject({ binary: null, reason: 'self-test timed out' });
    expect(fs.existsSync(dest())).toBe(true);
    expect(approvedInstalledNative(stableDir)).toBeNull();
    expect(await prepare()).toEqual({ binary: dest(), restored: false });
    expect(runs).toBe(1);
  });

  it('treats a copy that could not be started as unknown too: nothing recorded, tested again next boot', async () => {
    ship('good v1');
    expect(await prepare(async () => 'unstartable')).toMatchObject({ binary: null, reason: 'self-test could not start' });
    expect(approvedInstalledNative(stableDir)).toBeNull();
    expect(await prepare()).toEqual({ binary: dest(), restored: false });
    expect(runs).toBe(1);
  });

  it('puts the working copy back when a refresh fails, and offers nothing this time', async () => {
    ship('good v1');
    await prepare();
    ship('broken v2');
    expect(await prepare()).toMatchObject({ binary: null, restored: true });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
    expect(asides()).toEqual([]);
  });

  it('after a failed restore, the next boot keeps the failing copy, offers nothing, and does not rerun it', async () => {
    ship('good v1');
    await prepare();
    ship('broken v2');
    // The aside disappears before it can be renamed back: the restore fails.
    const loseTheAside = async (binary: string) => {
      for (const f of asides()) fs.unlinkSync(path.join(stableDir, f));
      return runsIfGood(binary);
    };
    expect(await prepare(loseTheAside)).toMatchObject({ binary: null, restored: false });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('broken v2 wmux-managed: native-hooks');
    expect(await prepare()).toMatchObject({ binary: null, restored: false });
    expect(fs.existsSync(dest())).toBe(true);
    expect(runs).toBe(2);
  });

  it('serializes overlapping calls, so one call never sweeps the aside another is about to restore', async () => {
    ship('good v1');
    await prepare();
    ship('broken v2');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowFail = async (binary: string): Promise<SelfTestVerdict> => {
      await gate;
      return runsIfGood(binary);
    };
    const first = prepare(slowFail);
    const second = prepare();
    // Let the second call reach its sweep if it were not waiting.
    await new Promise((resolve) => setImmediate(resolve));
    release?.();
    expect(await first).toMatchObject({ binary: null, restored: true });
    await second;
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
  });

  it('drops the replaced copy after a refresh that passes, and sweeps old asides first', async () => {
    ship('good v1');
    await prepare();
    fs.writeFileSync(`${dest()}.previous-1-aa`, 'left while it was running');
    ship('good v2');
    expect(await prepare()).toEqual({ binary: dest(), restored: false });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v2 wmux-managed: native-hooks');
    expect(asides()).toEqual([]);
  });

  it('offers nothing when the build ships no launcher, and leaves no copy', async () => {
    const result = await prepareNativeLauncher({ sourcePath: null, stableDir, selfTest: runsIfGood });
    expect(result).toMatchObject({ binary: null, reason: 'not shipped with this build' });
    expect(fs.existsSync(dest())).toBe(false);
  });

  it('never overwrites a foreign file in its place', async () => {
    fs.writeFileSync(dest(), 'someone else\'s program');
    ship('good v1');
    expect(await prepare()).toMatchObject({ binary: null, reason: 'copy is foreign' });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('someone else\'s program');
  });
});
