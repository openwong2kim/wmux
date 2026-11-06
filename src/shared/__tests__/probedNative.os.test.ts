import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROBE_LOCK,
  PROBE_RECORD,
  prepareProbedNative,
  probeKey,
  recordedProbe,
  sha256Of,
  type ProbeVerdict,
  type ProbedNativeOptions,
} from '../probedNative';

// The copy is real; the probe is a stand-in that passes for bytes saying
// "good", and notes each path it ran.
let root = '';
let dir = '';
let source = '';
let probed: string[] = [];
let holder: ChildProcess | null = null;
const dest = () => path.join(dir, 'wmux-native');
const ship = (text: string) => fs.writeFileSync(source, `${text} wmux-managed: native-hooks`);
const keyOf = (text: string, line = 'line 1') => probeKey(sha256Of(Buffer.from(`${text} wmux-managed: native-hooks`)), line);
const passIfGood = async (binary: string): Promise<ProbeVerdict> => {
  probed.push(binary);
  return fs.readFileSync(binary, 'utf8').includes('good') ? 'pass' : 'fail';
};
const prepare = (over: Partial<ProbedNativeOptions> = {}) => prepareProbedNative({
  sourcePath: source,
  destinationPath: dest(),
  recordDir: dir,
  line: 'line 1',
  probe: passIfGood,
  ownershipMarkers: ['wmux-managed: native-hooks'],
  ...over,
});

/** A live process other than this one, holding nothing. */
function liveProcess(): ChildProcess {
  holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return holder;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-probed-native-'));
  dir = path.join(root, 'hooks');
  fs.mkdirSync(dir);
  source = path.join(root, 'resources', 'wmux-native');
  fs.mkdirSync(path.dirname(source));
  probed = [];
});
afterEach(() => {
  holder?.kill();
  holder = null;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('prepareProbedNative', () => {
  it('probes the staged copy where it will live, and the destination changes only after a pass', async () => {
    ship('good v1');
    await prepare();
    ship('good v2');
    const seen: string[] = [];
    const probe = async (binary: string): Promise<ProbeVerdict> => {
      seen.push(fs.readFileSync(dest(), 'utf8'));
      return passIfGood(binary);
    };
    expect(await prepare({ probe })).toEqual({ binary: dest() });
    const staged = probed[1];
    expect(path.dirname(staged)).toBe(dir);
    expect(path.basename(staged)).toMatch(/^wmux-native\.staged-/);
    expect(seen).toEqual(['good v1 wmux-managed: native-hooks']);
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v2 wmux-managed: native-hooks');
    if (process.platform !== 'win32') expect(fs.statSync(dest()).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.staged-') || f.includes('.previous'))).toEqual([]);
  });

  it('takes the windows path: the copy in place goes aside, the staged one takes its name', async () => {
    ship('good v1');
    await prepare({ platform: 'win32' });
    ship('good v2');
    expect(await prepare({ platform: 'win32' })).toEqual({ binary: dest() });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v2 wmux-managed: native-hooks');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.previous'))).toEqual([]);
  });

  it('keys a verdict by the bytes and the expected line: another line is probed again', async () => {
    ship('good v1');
    await prepare();
    await prepare();
    expect(probed).toHaveLength(1);
    await prepare({ line: 'line 2' });
    expect(probed).toHaveLength(2);
    expect(recordedProbe(dir, keyOf('good v1', 'line 2'))).toBe('pass');
  });

  it('never evicts the verdict of the copy in place, however many builds fail after it', async () => {
    ship('good v0');
    await prepare();
    for (let i = 1; i <= 9; i++) {
      ship(`broken v${i}`);
      expect(await prepare()).toMatchObject({ binary: dest() });
    }
    expect(recordedProbe(dir, keyOf('good v0'))).toBe('pass');
    expect(recordedProbe(dir, keyOf('broken v1'))).toBeUndefined();
    expect(recordedProbe(dir, keyOf('broken v9'))).toBe('fail');
  });

  it('reads a version 1 record as empty, so the copy is probed once more', async () => {
    ship('good v1');
    await prepare();
    fs.writeFileSync(path.join(dir, PROBE_RECORD), JSON.stringify({ version: 1, verdicts: { [sha256Of(fs.readFileSync(source))]: 'pass' } }));
    await prepare();
    expect(probed).toHaveLength(2);
  });
});

describe('prepareProbedNative — the lock across processes', () => {
  const lockFile = () => path.join(dir, PROBE_LOCK);

  it('waits for another process that holds the lock, then goes on', async () => {
    ship('good v1');
    const pid = liveProcess().pid as number;
    fs.writeFileSync(lockFile(), `${pid} ${Date.now()} other`);
    setTimeout(() => fs.unlinkSync(lockFile()), 500);
    const started = Date.now();
    expect(await prepare()).toEqual({ binary: dest() });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('serializes two installs in two processes: the second probes only after the first is done', async () => {
    ship('good v1');
    const bundle = path.join(root, 'probed.cjs');
    buildSync({ entryPoints: [path.join(__dirname, '..', 'probedNative.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const log = path.join(root, 'order.log');
    const script = `
      const fs = require('fs');
      const { prepareProbedNative } = require(${JSON.stringify(bundle)});
      const note = (t) => fs.appendFileSync(${JSON.stringify(log)}, t + '\\n');
      prepareProbedNative({
        sourcePath: ${JSON.stringify(source)}, destinationPath: ${JSON.stringify(dest())}, recordDir: ${JSON.stringify(dir)},
        line: 'line 1', ownershipMarkers: ['wmux-managed: native-hooks'],
        probe: async () => { note('child probes'); await new Promise((r) => setTimeout(r, 600)); note('child passes'); return 'pass'; },
      }).then((r) => note(r.binary ? 'child offered' : 'child none'));
    `;
    holder = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
    const deadline = Date.now() + 10_000;
    while (!read().includes('child probes')) {
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Another line for the same bytes: this process must probe too.
    const probe = async (binary: string): Promise<ProbeVerdict> => {
      fs.appendFileSync(log, 'parent probes\n');
      return passIfGood(binary);
    };
    expect(await prepare({ line: 'line 2', probe })).toEqual({ binary: dest() });
    expect(read()).toEqual(['child probes', 'child passes', 'child offered', 'parent probes']);
  });

  it('does not take over a lock whose pid lives and which is under 30 s old: nothing offered, written or recorded', async () => {
    ship('good v1');
    const held = `${liveProcess().pid as number} ${Date.now()} other`;
    fs.writeFileSync(lockFile(), held);
    expect(await prepare({ lock: { waitMs: 300 } })).toEqual({ binary: null, reason: 'another install holds the lock' });
    expect(fs.existsSync(dest())).toBe(false);
    expect(fs.existsSync(path.join(dir, PROBE_RECORD))).toBe(false);
    expect(probed).toEqual([]);
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe(held);
  });

  it('takes over a lock whose pid is gone', async () => {
    ship('good v1');
    const gone = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => gone.once('exit', resolve));
    fs.writeFileSync(lockFile(), `${gone.pid} ${Date.now()} other`);
    expect(await prepare({ lock: { waitMs: 300 } })).toEqual({ binary: dest() });
  });

  it('takes over a lock older than 30 s even when its pid lives', async () => {
    ship('good v1');
    const pid = liveProcess().pid as number;
    fs.writeFileSync(lockFile(), `${pid} ${Date.now() - 31_000} other`);
    expect(await prepare({ lock: { waitMs: 300 } })).toEqual({ binary: dest() });
  });
});
