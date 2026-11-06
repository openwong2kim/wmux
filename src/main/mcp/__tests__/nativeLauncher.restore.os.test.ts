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
const staged = () => fs.readdirSync(stableDir).filter((f) => f.includes('.staged-'));
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

  it('never puts a copy that fails in place: records it, offers nothing, leaves no staged file', async () => {
    ship('broken v1');
    expect(await prepare()).toMatchObject({ binary: null, restored: false, reason: 'self-test failed' });
    expect(fs.existsSync(dest())).toBe(false);
    expect(staged()).toEqual([]);
    expect(approvedInstalledNative(stableDir)).toBeNull();
    // Recorded as failing: not run again for the same bytes.
    expect(await prepare()).toMatchObject({ binary: null });
    expect(runs).toBe(1);
  });

  it('treats a timeout as unknown: nothing offered now, nothing recorded, tested again next boot', async () => {
    ship('good v1');
    expect(await prepare(async () => 'timeout')).toMatchObject({ binary: null, reason: 'self-test timed out' });
    expect(fs.existsSync(dest())).toBe(false);
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

  it('a refresh that fails leaves the working copy in place and still offers it', async () => {
    ship('good v1');
    await prepare();
    ship('broken v2');
    const result = await prepare();
    expect(result).toMatchObject({ binary: dest(), restored: false });
    expect(result.reason).toContain('the installed copy stays');
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
    expect(asides()).toEqual([]);
    expect(staged()).toEqual([]);
  });

  it('the copy in place keeps its bytes and its inode through a refresh that fails, and the failure is not rerun', async () => {
    ship('good v1');
    await prepare();
    const inode = fs.statSync(dest()).ino;
    ship('broken v2');
    await prepare();
    await prepare();
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
    expect(fs.statSync(dest()).ino).toBe(inode);
    expect(runs).toBe(2);
  });

  it('serializes overlapping calls: the second starts only once the first is done', async () => {
    ship('good v1');
    await prepare();
    ship('broken v2');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const slowFail = async (binary: string): Promise<SelfTestVerdict> => {
      order.push('first probes');
      await gate;
      return runsIfGood(binary);
    };
    const first = prepare(slowFail).then((r) => { order.push('first done'); return r; });
    const second = prepare().then((r) => { order.push('second done'); return r; });
    await new Promise((resolve) => setImmediate(resolve));
    release?.();
    expect(await first).toMatchObject({ binary: dest() });
    expect(await second).toMatchObject({ binary: dest() });
    expect(order).toEqual(['first probes', 'first done', 'second done']);
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
