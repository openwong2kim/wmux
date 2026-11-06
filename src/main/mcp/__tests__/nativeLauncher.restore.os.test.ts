import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareNativeLauncher } from '../nativeLauncher';
import { nativeLauncherPath } from '../../../shared/mcpLauncher';

// The copy is real; the self-test is a stand-in that passes for bytes saying
// "good", so each case can decide which copies run.
let root = '';
let stableDir = '';
let source = '';
const dest = () => nativeLauncherPath(stableDir);
const asides = () => fs.readdirSync(stableDir).filter((f) => f.includes('.previous'));
const ship = (text: string) => fs.writeFileSync(source, `${text} wmux-managed: native-hooks`);
const runsIfGood = async (binary: string) => fs.readFileSync(binary, 'utf8').includes('good');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-launcher-'));
  stableDir = path.join(root, '.wmux', 'mcp');
  fs.mkdirSync(stableDir, { recursive: true });
  source = path.join(root, 'resources', 'native-hooks', 'wmux-native');
  fs.mkdirSync(path.dirname(source), { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('prepareNativeLauncher', () => {
  it('installs a copy that passes its self-test and offers it', async () => {
    ship('good v1');
    const result = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runsIfGood });
    expect(result).toEqual({ binary: dest(), restored: false });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
  });

  it('runs the self-test on every call, a current copy included', async () => {
    ship('good v1');
    let runs = 0;
    const counting = async (binary: string) => { runs++; return runsIfGood(binary); };
    await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: counting });
    await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: counting });
    expect(runs).toBe(2);
  });

  it('removes a fresh copy that fails, and offers nothing', async () => {
    ship('broken v1');
    const result = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runsIfGood });
    expect(result).toMatchObject({ binary: null, restored: false, reason: 'self-test failed' });
    expect(fs.existsSync(dest())).toBe(false);
  });

  it('puts the working copy back when a refresh fails, and offers nothing this time', async () => {
    ship('good v1');
    await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runsIfGood });
    ship('broken v2');
    const result = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runsIfGood });
    expect(result).toMatchObject({ binary: null, restored: true });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
    expect(asides()).toEqual([]);
  });

  it('catches a failed copy a failed restore left behind on the next call, and removes it', async () => {
    ship('good v1');
    await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runsIfGood });
    ship('broken v2');
    // The aside disappears before it can be renamed back: the restore fails.
    const loseTheAside = async (binary: string) => {
      for (const f of asides()) fs.unlinkSync(path.join(stableDir, f));
      return runsIfGood(binary);
    };
    const failed = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: loseTheAside });
    expect(failed).toMatchObject({ binary: null, restored: false });
    // The broken copy now matches the source, so it reads as current...
    expect(fs.readFileSync(dest(), 'utf8')).toBe('broken v2 wmux-managed: native-hooks');
    // ...and the next call's self-test is what removes it.
    const next = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runsIfGood });
    expect(next).toMatchObject({ binary: null, restored: false, reason: 'self-test failed' });
    expect(fs.existsSync(dest())).toBe(false);
  });

  it('drops the replaced copy after a refresh that passes, and sweeps old asides first', async () => {
    ship('good v1');
    await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runsIfGood });
    fs.writeFileSync(`${dest()}.previous-1-aa`, 'left while it was running');
    ship('good v2');
    const result = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runsIfGood });
    expect(result).toEqual({ binary: dest(), restored: false });
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
    const result = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runsIfGood });
    expect(result).toMatchObject({ binary: null, reason: 'copy is foreign' });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('someone else\'s program');
  });
});
