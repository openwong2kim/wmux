import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildDaemonLaunchdPlist,
  filterEnvForLaunchd,
  daemonJobCreatedAt,
  launchdBaseLabel,
  newDaemonJobLabel,
  parseLaunchctlList,
  parseLaunchctlPrint,
  PRUNE_GRACE_MS,
  pruneStaleDaemonJobs,
  startDaemonViaLaunchd,
  sweepLeftoverDaemonPlists,
  withDaemonStartLock,
  LaunchdUnavailableError,
  type LaunchdRuntime,
} from '../launchdDaemonJob';

describe('launchdBaseLabel', () => {
  it('derives the label from the data suffix so dev and prod never share jobs', () => {
    expect(launchdBaseLabel('')).toBe('com.wmux.daemon');
    expect(launchdBaseLabel('-dev')).toBe('com.wmux.daemon-dev');
    expect(launchdBaseLabel('-a b/c')).toBe('com.wmux.daemon-a-b-c');
  });
});

describe('filterEnvForLaunchd', () => {
  it('keeps the spawn env, drops undefined, launchd-owned, non-plist-safe and credential values', () => {
    const out = filterEnvForLaunchd({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/x',
      ELECTRON_RUN_AS_NODE: '1',
      WMUX_SPAWNED_BY_VERSION: '1.2.3',
      UNSET: undefined,
      XPC_SERVICE_NAME: 'application.com.wmux.app',
      XPC_FLAGS: '0x0',
      BAD: 'a\u0001b',
      CR: 'a\rb',
      MULTI: 'line1\nline2',
      GH_TOKEN: 'ghp_x',
      ANTHROPIC_API_KEY: 'sk-ant',
      DB_PASSWORD: 'pw',
      WMUX_AUTH_TOKEN: 'outer-pane-token',
      WMUX_PUSH_RELAY_SECRET: 'relay',
    });
    expect(out).toEqual({
      WMUX_PUSH_RELAY_SECRET: 'relay',
      PATH: '/usr/bin:/bin',
      HOME: '/Users/x',
      ELECTRON_RUN_AS_NODE: '1',
      WMUX_SPAWNED_BY_VERSION: '1.2.3',
      MULTI: 'line1\nline2',
    });
  });
});

describe('buildDaemonLaunchdPlist', () => {
  const xml = buildDaemonLaunchdPlist({
    label: 'com.wmux.daemon.abc',
    programArguments: ['/Applications/wmux.app/Contents/MacOS/wmux', '/x/daemon-bundle/index.js'],
    env: { ELECTRON_RUN_AS_NODE: '1', WEIRD: 'a & <b> "c"' },
  });

  it('carries label, program arguments and env', () => {
    expect(xml).toContain('<key>Label</key>\n\t<string>com.wmux.daemon.abc</string>');
    expect(xml).toMatch(
      /<key>ProgramArguments<\/key>\n\t<array>\n\t\t<string>\/Applications\/wmux.app\/Contents\/MacOS\/wmux<\/string>\n\t\t<string>\/x\/daemon-bundle\/index.js<\/string>\n\t<\/array>/,
    );
    expect(xml).toContain('<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>');
    expect(xml).toContain('<string>a &amp; &lt;b&gt; &quot;c&quot;</string>');
  });

  it('starts once, never respawns, is interactive and keeps stdio closed', () => {
    expect(xml).toContain('<key>RunAtLoad</key>\n\t<true/>');
    expect(xml).toContain('<key>KeepAlive</key>\n\t<false/>');
    expect(xml).toContain('<key>AbandonProcessGroup</key>\n\t<true/>');
    expect(xml).toContain('<key>ProcessType</key>\n\t<string>Interactive</string>');
    expect(xml).toContain('<key>StandardOutPath</key>\n\t<string>/dev/null</string>');
    expect(xml).toContain('<key>StandardErrorPath</key>\n\t<string>/dev/null</string>');
  });

  it.runIf(process.platform === 'darwin')('is a valid plist (plutil -lint)', async () => {
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const f = path.join(os.tmpdir(), `wmux-plist-lint-${process.pid}.plist`);
    fs.writeFileSync(f, xml);
    try {
      expect(execFileSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf-8' })).toMatch(/OK/);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });
});

describe('parseLaunchctlList', () => {
  it('parses pid, status and label, with - for none', () => {
    const m = parseLaunchctlList('PID\tStatus\tLabel\n123\t0\tcom.a\n-\t3\tcom.b\n-\t-15\tcom.c\n');
    expect(m.get('com.a')).toEqual({ pid: 123, status: 0 });
    expect(m.get('com.b')).toEqual({ pid: null, status: 3 });
    expect(m.get('com.c')).toEqual({ pid: null, status: -15 });
    expect(m.has('Label')).toBe(false);
  });
});

interface FakeJob { pid: number | null; runs: number; lastExit: number | null; status: number }

/**
 * A small launchd model: `jobs` drives `list` and `print`; `bootstrap` loads
 * the plist's label through `onBootstrap` (which may also throw).
 */
function fakeLaunchd(opts: {
  onBootstrap?: (label: string, plist: string) => FakeJob | 'throw' | 'throw-but-loaded';
  alive?: (pid: number) => boolean;
  printFails?: boolean;
} = {}) {
  const jobs = new Map<string, FakeJob>();
  const calls: string[][] = [];
  const plists: string[] = [];
  let nextPid = 4321;
  const rt: LaunchdRuntime = {
    uid: 501,
    log: () => undefined,
    sleep: () => Promise.resolve(),
    isPidAlive: opts.alive ?? (() => true),
    runLaunchctl: async (args) => {
      calls.push(args);
      if (args[0] === 'list') {
        return [...jobs].map(([l, j]) => `${j.pid ?? '-'}\t${j.status}\t${l}\n`).join('');
      }
      if (args[0] === 'print') {
        if (opts.printFails) throw new Error('launchctl print failed: Operation not permitted');
        const label = args[1].split('/').pop() ?? '';
        const j = jobs.get(label);
        if (!j) throw new Error(`launchctl print failed: Bad request.\nCould not find service "${label}" in domain for user gui: 501`);
        return `gui/501/${label} = {\n\tstate = ${j.pid ? 'running' : 'not running'}\n\truns = ${j.runs}\n` +
          (j.pid ? `\tpid = ${j.pid}\n` : '') +
          `\tlast exit code = ${j.lastExit ?? '(never exited)'}\n\tendpoints = {\n\t\tpid = 1\n\t}\n}\n`;
      }
      if (args[0] === 'bootout') { jobs.delete(args[1].split('/').pop() ?? ''); return ''; }
      if (args[0] === 'bootstrap') {
        const label = path.basename(args[2], '.plist');
        const plist = fs.readFileSync(args[2], 'utf-8');
        plists.push(plist);
        const r = opts.onBootstrap?.(label, plist) ?? { pid: nextPid++, runs: 1, lastExit: null, status: 0 };
        if (r === 'throw') throw new Error('launchctl bootstrap failed: Bootstrap failed: 125: Domain does not support specified action');
        if (r === 'throw-but-loaded') {
          jobs.set(label, { pid: nextPid++, runs: 1, lastExit: null, status: 0 });
          throw new Error('launchctl bootstrap failed: timed out');
        }
        jobs.set(label, r);
        return '';
      }
      return '';
    },
  };
  return { rt, jobs, calls, plists };
}

describe('parseLaunchctlPrint', () => {
  it('reads job-level pid, runs and last exit code, ignoring nested dicts', () => {
    const out = 'gui/501/x = {\n\tstate = running\n\truns = 1\n\tpid = 77\n\tlast exit code = (never exited)\n\tendpoints = {\n\t\tpid = 1\n\t}\n}\n';
    expect(parseLaunchctlPrint(out)).toEqual({ kind: 'loaded', pid: 77, runs: 1, lastExit: null });
    expect(parseLaunchctlPrint('\tstate = not running\n\truns = 1\n\tlast exit code = 0\n'))
      .toEqual({ kind: 'loaded', pid: null, runs: 1, lastExit: 0 });
  });
});

describe('startDaemonViaLaunchd / pruneStaleDaemonJobs', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-launchd-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

  const base = 'com.wmux.daemon-t';
  const startOpts = (env: Record<string, string> = { A: '1' }) => ({
    baseLabel: base,
    plistDir: dir,
    programArguments: ['/bin/node', '/x/index.js'],
    env,
  });
  const old = () => Date.now() - PRUNE_GRACE_MS - 1_000;

  it('prunes only jobs of this instance that are not running, never a live one', async () => {
    const dead = newDaemonJobLabel(base, old());
    const live = newDaemonJobLabel(base, old());
    const orphan = newDaemonJobLabel(base, old());
    fs.writeFileSync(path.join(dir, `${dead}.plist`), '');
    fs.writeFileSync(path.join(dir, `${orphan}.plist`), '');
    fs.writeFileSync(path.join(dir, `${live}.plist`), '');
    const { rt, jobs, calls } = fakeLaunchd();
    jobs.set(dead, { pid: null, runs: 1, lastExit: 0, status: 0 });
    jobs.set(live, { pid: 77, runs: 1, lastExit: null, status: 0 });
    jobs.set('com.wmux.daemon.other', { pid: null, runs: 1, lastExit: 0, status: 0 });
    jobs.set('com.wmux.daemon-t2.x', { pid: null, runs: 1, lastExit: 0, status: 0 });
    await pruneStaleDaemonJobs(base, dir, rt);
    expect(calls.filter((c) => c[0] === 'bootout').map((c) => c[1])).toEqual([`gui/501/${dead}`]);
    expect(fs.readdirSync(dir).sort()).toEqual([`${live}.plist`]);
  });

  it('encodes the creation time in the label', () => {
    const label = newDaemonJobLabel(base, 1_760_000_000_000);
    expect(label.startsWith(`${base}.`)).toBe(true);
    expect(daemonJobCreatedAt(label)).toBe(1_760_000_000_000);
    expect(daemonJobCreatedAt(`${base}.dead`)).toBeNull();
  });

  it('never prunes a job younger than the grace window, even with no pid yet', async () => {
    const young = newDaemonJobLabel(base, Date.now() - 1_000);
    const stale = newDaemonJobLabel(base, old());
    const { rt, jobs, calls } = fakeLaunchd();
    jobs.set(young, { pid: null, runs: 0, lastExit: null, status: 0 });
    jobs.set(stale, { pid: null, runs: 1, lastExit: 0, status: 0 });
    await pruneStaleDaemonJobs(base, dir, rt);
    expect(calls.filter((c) => c[0] === 'bootout').map((c) => c[1])).toEqual([`gui/501/${stale}`]);
  });

  it('stamps the label after the lock wait and prune, right before bootstrap', async () => {
    const { rt } = fakeLaunchd();
    let t = 1_000_000;
    const realNow = Date.now;
    Date.now = () => t;
    try {
      rt.sleep = async () => { t += 10_000; };
      // A dead holder's lock would be reclaimed at once; a live one makes us wait.
      fs.writeFileSync(path.join(dir, 'start.lock'), `${process.pid}:other`);
      let waits = 0;
      const sleep = rt.sleep;
      rt.sleep = async (ms) => { if (++waits === 2) fs.unlinkSync(path.join(dir, 'start.lock')); await sleep(ms); };
      const job = await startDaemonViaLaunchd(startOpts(), rt);
      job.dispose();
      expect(daemonJobCreatedAt(job.label)).toBe(1_020_000);
    } finally {
      Date.now = realNow;
    }
  });

  it('serializes concurrent starts: one prune+bootstrap finishes before the next begins', async () => {
    const { rt, calls } = fakeLaunchd();
    rt.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const run = rt.runLaunchctl;
    // Yield inside every launchctl call so the two starts could interleave.
    rt.runLaunchctl = async (args) => { await new Promise((r) => setTimeout(r, 5)); return run(args); };
    const [a, b] = await Promise.all([startDaemonViaLaunchd(startOpts(), rt), startDaemonViaLaunchd(startOpts(), rt)]);
    a.dispose();
    b.dispose();
    const pruneAndBoot = calls.map((c) => c[0]).filter((c) => c === 'list' || c === 'bootstrap');
    expect(pruneAndBoot).toEqual(['list', 'bootstrap', 'list', 'bootstrap']);
    expect(calls.filter((c) => c[0] === 'bootout')).toEqual([]);
    expect(new Set([a.pid, b.pid]).size).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('takes over a start lock whose owner is dead', async () => {
    fs.writeFileSync(path.join(dir, 'start.lock'), '999999:gone');
    const { rt } = fakeLaunchd({ alive: (pid) => pid !== 999999 });
    const job = await startDaemonViaLaunchd(startOpts(), rt);
    job.dispose();
    expect(job.pid).toBe(4321);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('never takes over a lock whose owner is alive, however old', async () => {
    const lock = path.join(dir, 'start.lock');
    fs.writeFileSync(lock, `${process.pid}:other`);
    fs.utimesSync(lock, new Date(0), new Date(0));
    const { rt, calls } = fakeLaunchd();
    let t = Date.now();
    const realNow = Date.now;
    Date.now = () => t;
    rt.sleep = async () => { t += 5_000; };
    try {
      await expect(startDaemonViaLaunchd(startOpts(), rt)).rejects.toBeInstanceOf(LaunchdUnavailableError);
    } finally {
      Date.now = realNow;
    }
    expect(fs.readFileSync(lock, 'utf-8')).toBe(`${process.pid}:other`);
    expect(calls).toEqual([]);
  });

  it('does not delete a fresh lock that replaced the dead one mid-takeover', async () => {
    const lock = path.join(dir, 'start.lock');
    fs.writeFileSync(lock, '999999:gone');
    let swapped = false;
    const { rt } = fakeLaunchd({
      alive: (pid) => {
        // Between our read and our rename another waiter reclaims and re-creates the lock.
        if (pid === 999999 && !swapped) {
          swapped = true;
          fs.unlinkSync(lock);
          fs.writeFileSync(lock, `${process.pid}:fresh`);
        }
        return pid !== 999999;
      },
    });
    let waits = 0;
    rt.sleep = async () => {
      expect(fs.readFileSync(lock, 'utf-8')).toBe(`${process.pid}:fresh`);
      if (++waits === 2) fs.unlinkSync(lock);
    };
    const job = await startDaemonViaLaunchd(startOpts(), rt);
    job.dispose();
    expect(waits).toBe(2);
  });

  it('releases only a lock it still owns', async () => {
    const lock = path.join(dir, 'start.lock');
    await withDaemonStartLock(dir, fakeLaunchd().rt, async () => {
      fs.writeFileSync(lock, `${process.pid}:someone-else`);
    });
    expect(fs.readFileSync(lock, 'utf-8')).toBe(`${process.pid}:someone-else`);
  });

  it('bootstraps in the gui domain, leaves no plist and keeps credentials out of it', async () => {
    const { rt, calls, plists } = fakeLaunchd();
    // Young enough that prune's grace window keeps it: only the in-lock sweep removes it.
    fs.writeFileSync(path.join(dir, `${newDaemonJobLabel(base)}.plist`), 'old env');
    const job = await startDaemonViaLaunchd(
      startOpts({ A: '1', GITHUB_TOKEN: 'ghp_x', OPENAI_API_KEY: 'sk-x', WMUX_PUSH_RELAY_SECRET: 'relay', SSH_AUTH_SOCK: '/tmp/s' }),
      rt,
    );
    job.dispose();
    const boot = calls.find((c) => c[0] === 'bootstrap');
    if (!boot) throw new Error('no bootstrap call');
    expect(boot[1]).toBe('gui/501');
    expect(job.pid).toBe(4321);
    expect(plists[0]).toContain(`<string>${job.label}</string>`);
    expect(plists[0]).toContain('<key>A</key>');
    expect(plists[0]).toContain('<key>WMUX_PUSH_RELAY_SECRET</key>');
    expect(plists[0]).toContain('<key>SSH_AUTH_SOCK</key>');
    expect(plists[0]).not.toContain('ghp_x');
    expect(plists[0]).not.toContain('sk-x');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('falls back (LaunchdUnavailableError) when bootstrap fails and the job is confirmed not loaded', async () => {
    const { rt } = fakeLaunchd({ onBootstrap: () => 'throw' });
    await expect(startDaemonViaLaunchd(startOpts(), rt)).rejects.toBeInstanceOf(LaunchdUnavailableError);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('uses the job when bootstrap errors but the job did load', async () => {
    const { rt } = fakeLaunchd({ onBootstrap: () => 'throw-but-loaded' });
    const job = await startDaemonViaLaunchd(startOpts(), rt);
    job.dispose();
    expect(job.pid).toBe(4321);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not fall back when bootstrap errors and the load state is unknown', async () => {
    const { rt } = fakeLaunchd({ onBootstrap: () => 'throw', printFails: true });
    const err = await startDaemonViaLaunchd(startOpts(), rt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LaunchdUnavailableError);
  });

  it('does not fall back when the pid never appears for a loaded job', async () => {
    const { rt } = fakeLaunchd({ onBootstrap: () => ({ pid: null, runs: 0, lastExit: null, status: 0 }) });
    let t = Date.now();
    const realNow = Date.now;
    Date.now = () => t;
    rt.sleep = async () => { t += 1_000; };
    try {
      const err = await startDaemonViaLaunchd(startOpts(), rt).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(LaunchdUnavailableError);
    } finally {
      Date.now = realNow;
    }
  });

  it('reports an early exit before the pid was observed, including status 0', async () => {
    for (const lastExit of [3, 0]) {
      const { rt } = fakeLaunchd({ onBootstrap: () => ({ pid: null, runs: 1, lastExit, status: lastExit }) });
      const job = await startDaemonViaLaunchd(startOpts(), rt);
      expect(job.pid).toBeNull();
      expect(job.isAlive()).toBe(false);
      expect(await new Promise((r) => job.onExit(r))).toBe(lastExit);
    }
  });

  it('watches the pid and reports the exit status launchd recorded', async () => {
    vi.useFakeTimers();
    let alive = true;
    const { rt, jobs } = fakeLaunchd({ alive: () => alive, onBootstrap: () => ({ pid: 55, runs: 1, lastExit: null, status: 0 }) });
    const job = await startDaemonViaLaunchd(startOpts(), rt);
    const exited = new Promise((r) => job.onExit(r));
    expect(job.isAlive()).toBe(true);
    alive = false;
    jobs.set(job.label, { pid: null, runs: 1, lastExit: 1, status: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(await exited).toBe(1);
    expect(job.isAlive()).toBe(false);
  });
});

describe('sweepLeftoverDaemonPlists', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-launchd-sweep-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'com.wmux.daemon-t';

  it('removes this instance\'s leftover plists and releases the lock', () => {
    fs.writeFileSync(path.join(dir, `${base}.a.plist`), 'env');
    fs.writeFileSync(path.join(dir, 'com.wmux.daemon-other.b.plist'), 'env');
    sweepLeftoverDaemonPlists(base, dir);
    expect(fs.readdirSync(dir)).toEqual(['com.wmux.daemon-other.b.plist']);
  });

  it('leaves files alone while another launcher holds the start lock', () => {
    fs.writeFileSync(path.join(dir, `${base}.a.plist`), 'env');
    fs.writeFileSync(path.join(dir, 'start.lock'), `${process.pid}:busy`);
    sweepLeftoverDaemonPlists(base, dir);
    expect(fs.readdirSync(dir).sort()).toEqual([`${base}.a.plist`, 'start.lock']);
  });
});
