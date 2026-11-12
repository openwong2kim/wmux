import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepAsides } from '../lifecycleIntegrations';
import {
  PROBE_LOCK,
  lockDir,
  PROBE_RECORD,
  expectationKey,
  prepareProbedNative,
  probeKey,
  recordedProbe,
  runProbe,
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

  it('creates a missing directory for the copy and the record, private to the user', async () => {
    ship('good v1');
    const fresh = path.join(root, 'new', 'hooks');
    const result = await prepare({ destinationPath: path.join(fresh, 'wmux-native'), recordDir: fresh });
    expect(result).toEqual({ binary: path.join(fresh, 'wmux-native') });
    if (process.platform !== 'win32') expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
  });

  it('takes the windows path: the copy in place goes aside, the staged one takes its name', async () => {
    ship('good v1');
    await prepare({ platform: 'win32' });
    ship('good v2');
    expect(await prepare({ platform: 'win32' })).toEqual({ binary: dest() });
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v2 wmux-managed: native-hooks');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.previous'))).toEqual([]);
  });

  it('on windows stages under the real extension, and sweeps such a copy left behind', async () => {
    ship('good v1');
    const exe = path.join(dir, 'wmux-native.exe');
    fs.writeFileSync(path.join(dir, 'wmux-native.staged-1-aa.exe'), 'left by a crash');
    expect(await prepare({ destinationPath: exe, platform: 'win32' })).toEqual({ binary: exe });
    expect(path.basename(probed[0])).toMatch(/^wmux-native\.staged-[^.]+\.exe$/);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.staged-'))).toEqual([]);
  });

  it('never replaces a foreign file that took the name while the probe ran', async () => {
    for (const before of [null, 'good v1']) {
      fs.rmSync(dest(), { force: true });
      if (before) {
        ship(before);
        await prepare();
      }
      // New bytes each round: a recorded pass would skip the probe.
      ship(`good v2 after ${before}`);
      const probe = async (binary: string): Promise<ProbeVerdict> => {
        fs.writeFileSync(dest(), 'someone else\'s program');
        return passIfGood(binary);
      };
      expect(await prepare({ probe })).toEqual({ binary: null, reason: 'copy is foreign' });
      expect(fs.readFileSync(dest(), 'utf8')).toBe('someone else\'s program');
      expect(fs.readdirSync(dir).filter((f) => f.includes('.staged-') || f.includes('.previous'))).toEqual([]);
    }
  });

  it('judges ownership on the bytes, never decoding the copy', async () => {
    ship('good v1');
    await prepare();
    const inPlace = fs.readFileSync(dest());
    ship('good v2');
    const toString = vi.spyOn(Buffer.prototype, 'toString');
    try {
      await prepare({ probe: async () => 'pass' });
      expect(toString.mock.contexts.some((buffer) => Buffer.isBuffer(buffer) && buffer.equals(inPlace))).toBe(false);
    } finally {
      toString.mockRestore();
    }
  });

  it('sweeps by the prefix it is given', () => {
    fs.writeFileSync(dest(), 'in place');
    for (const name of ['wmux-native.staged-1-aa', 'wmux-native.previous-1-aa', 'other.staged-1-aa']) fs.writeFileSync(path.join(dir, name), 'x');
    sweepAsides(dest(), 'wmux-native.staged-');
    expect(fs.readdirSync(dir).sort()).toEqual(['other.staged-1-aa', 'wmux-native', 'wmux-native.previous-1-aa']);
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

  // One record serves every copy in the directory (the compat wmux-native and
  // the Claude hook's wmux-claude-hook): one copy's refreshes must not evict
  // the verdict of another copy still in place.
  it('never evicts the verdict of any copy in the directory, whoever writes the record', async () => {
    ship('good other');
    const other = path.join(dir, 'wmux-claude-hook');
    await prepare({ destinationPath: other });
    expect(recordedProbe(dir, keyOf('good other'))).toBe('pass');
    for (let i = 1; i <= 9; i++) {
      ship(`good v${i}`);
      await prepare();
    }
    expect(recordedProbe(dir, keyOf('good other'))).toBe('pass');
    expect(recordedProbe(dir, keyOf('good v9'))).toBe('pass');
  });

  it('reads a version 1 record as empty, so the copy is probed once more', async () => {
    ship('good v1');
    await prepare();
    fs.writeFileSync(path.join(dir, PROBE_RECORD), JSON.stringify({ version: 1, verdicts: { [sha256Of(fs.readFileSync(source))]: 'pass' } }));
    await prepare();
    expect(probed).toHaveLength(2);
  });
});

describe('runProbe — what a pass is', () => {
  const printing = (text: string) => ['-e', `process.stdout.write(${JSON.stringify(text)})`];

  it('an exact line, or output that contains a text', async () => {
    const out = 'wmux-native 4.15.0\nwmux-managed: native-hooks\n';
    expect(await runProbe(process.execPath, printing(out), { contains: 'wmux-managed: native-hooks' }, 10_000)).toBe('pass');
    expect(await runProbe(process.execPath, printing(out), { line: 'wmux-managed: native-hooks' }, 10_000)).toBe('fail');
    expect(await runProbe(process.execPath, printing('protocol 1\n'), { line: 'protocol 1' }, 10_000)).toBe('pass');
    expect(await runProbe(process.execPath, printing('usage: wmux-native'), { contains: 'wmux-managed: native-hooks' }, 10_000)).toBe('fail');
  });

  it('keys a line as itself (the keys recorded so far stay valid) and a contained text apart from any line', () => {
    expect(expectationKey({ line: 'protocol 1' })).toBe('protocol 1');
    expect(expectationKey({ contains: 'protocol 1' })).not.toBe('protocol 1');
  });
});

describe('prepareProbedNative — reprobe', () => {
  it('probes again bytes recorded as failing, and records the new verdict', async () => {
    ship('good v1');
    const fail = async (binary: string): Promise<ProbeVerdict> => { probed.push(binary); return 'fail'; };
    expect(await prepare({ probe: fail })).toMatchObject({ binary: null });
    expect(await prepare()).toMatchObject({ binary: null, reason: 'recorded as failing' });
    expect(probed).toHaveLength(1);
    expect(await prepare({ reprobe: true })).toEqual({ binary: dest() });
    expect(probed).toHaveLength(2);
    expect(recordedProbe(dir, keyOf('good v1'))).toBe('pass');
  });

  it('probes again bytes already in place with a recorded pass', async () => {
    ship('good v1');
    await prepare();
    const fail = async (binary: string): Promise<ProbeVerdict> => { probed.push(binary); return 'fail'; };
    expect(await prepare({ reprobe: true, probe: fail })).toMatchObject({ binary: null, reason: 'self-test failed' });
    expect(probed).toEqual([probed[0], dest()]);
    expect(recordedProbe(dir, keyOf('good v1'))).toBe('fail');
  });
});

describe('prepareProbedNative — a reprobe that proves nothing', () => {
  it('a timeout leaves the recorded verdict, and what it offers, as they were', async () => {
    ship('good v1');
    await prepare();
    expect(await prepare({ reprobe: true, probe: async () => 'timeout' })).toEqual({ binary: dest() });
    expect(recordedProbe(dir, keyOf('good v1'))).toBe('pass');
    ship('good v2');
    await prepare({ probe: async () => 'fail' });
    expect(await prepare({ reprobe: true, probe: async () => 'timeout' })).toMatchObject({ binary: dest(), reason: 'recorded as failing; the installed copy stays' });
    expect(recordedProbe(dir, keyOf('good v2'))).toBe('fail');
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
  });

  // A home that turned noexec after the copy passed: `--reprobe` is what the
  // person runs, and a copy that cannot start must not be offered on the
  // strength of the old pass, nor kept trusted for the next plain install.
  it('a copy that cannot start: nothing offered, the recorded pass forgotten, nothing recorded, and the next run probes again', async () => {
    ship('good v1');
    await prepare();
    expect(await prepare({ reprobe: true, probe: async () => 'unstartable' })).toEqual({ binary: null, reason: 'self-test could not start' });
    expect(recordedProbe(dir, keyOf('good v1'))).toBeUndefined();
    const before = probed.length;
    expect(await prepare()).toEqual({ binary: dest() });
    expect(probed).toHaveLength(before + 1);
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

  it('without the lock, still offers the copy in place when its bytes have a recorded pass, and writes nothing', async () => {
    ship('good v1');
    await prepare();
    ship('good v2');
    const record = path.join(dir, PROBE_RECORD);
    const before = fs.statSync(record).mtimeMs;
    fs.writeFileSync(lockFile(), `${liveProcess().pid as number} ${Date.now()} other`);
    const result = await prepare({ lock: { waitMs: 200 } });
    expect(result.binary).toBe(dest());
    expect(result.reason).toContain('another install holds the lock');
    expect(fs.readFileSync(dest(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
    expect(fs.statSync(record).mtimeMs).toBe(before);
    expect(probed).toHaveLength(1);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.staged-'))).toEqual([]);
  });

  it('holds an empty or unreadable lock (a holder between its open and its write) until its mtime is stale', async () => {
    for (const content of ['', 'not a lock']) {
      fs.writeFileSync(lockFile(), content);
      expect(await lockDir(dir, { waitMs: 200, pollMs: 50 })).toBeNull();
      expect(fs.readFileSync(lockFile(), 'utf8')).toBe(content);
      const old = (Date.now() - 31_000) / 1000;
      fs.utimesSync(lockFile(), old, old);
      const lock = await lockDir(dir, { waitMs: 200, pollMs: 50 });
      expect(lock).not.toBeNull();
      lock?.release();
    }
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
