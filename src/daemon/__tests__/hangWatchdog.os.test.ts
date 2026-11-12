/**
 * The watchdog in a real process, bundled the way the daemon is: one file, with
 * nothing beside it for a Worker to load. Each child sticks its main thread and
 * the test reads what it left.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';

let root: string;
let bundle: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hang-watchdog-'));
  bundle = path.join(root, 'bundle', 'hangWatchdog.cjs');
  buildSync({
    entryPoints: [path.join(__dirname, '..', 'hangWatchdog.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
  });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  ms: number;
  logsDir: string;
  dumps: string[];
  log: string;
}

/** Fast settings: a stall is seen after 100 ms silent, and a dump gives up after 500 ms. */
const FAST = { tickMs: 20, pollMs: 50, staleReads: 2, timeboxMs: 500 };

function runChild(body: string, opts: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const logsDir = fs.mkdtempSync(path.join(root, 'logs-'));
  const logFile = path.join(logsDir, 'log.out');
  const script = `
    const fs = require('fs');
    const { startHangWatchdog } = require(${JSON.stringify(bundle)});
    startHangWatchdog({
      logsDir: ${JSON.stringify(logsDir)},
      version: '9.9.9',
      log: (level, msg) => fs.appendFileSync(${JSON.stringify(logFile)}, level + ' ' + msg + '\\n'),
      ...${JSON.stringify({ ...FAST, ...opts })},
    });
    ${body}
  `;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', env: { ...process.env, ...env }, windowsHide: true });
    const killer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(killer);
      const names = fs.readdirSync(logsDir).filter((n) => n.startsWith('daemon-hang-')).sort();
      resolve({
        code,
        ms: Date.now() - started,
        logsDir,
        dumps: names.map((n) => fs.readFileSync(path.join(logsDir, n), 'utf8')),
        log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '',
      });
    });
  });
}

/** Give the Worker time to start on a slow runner, call `fn`, then exit once a dump had time to land. */
const afterStart = (fn: string, thenMs = 50) => `
  setTimeout(() => { ${fn}; setTimeout(() => process.exit(0), ${thenMs}); }, 1000);
`;

const STUCK_IN_JS = `
  function outerCaller(argSecret) {
    const scopeSecret = 'SCOPE-SECRET-' + argSecret;
    return stuckInALoop(scopeSecret);
  }
  function stuckInALoop(secretArg) {
    const end = Date.now() + 3000;
    let turns = 0;
    while (Date.now() < end) turns++;
    fs.writeFileSync(process.env.TURNS_FILE, String(turns));
    return secretArg;
  }
`;

describe('hang watchdog', () => {
  it('a main thread stuck in JavaScript leaves its frames, and keeps running after the dump', async () => {
    const turnsFile = path.join(root, 'turns.txt');
    const run = await runChild(STUCK_IN_JS + afterStart(`outerCaller('ARG-SECRET')`), {}, { TURNS_FILE: turnsFile });
    expect(run.code).toBe(0);
    expect(run.dumps).toHaveLength(1);
    const dump = run.dumps[0];
    expect(dump).toContain('state: JavaScript');
    expect(dump).toContain('version: 9.9.9');
    expect(dump).toMatch(/^ {2}stuckInALoop \S+:\d+:\d+$/m);
    expect(dump).toMatch(/^ {2}outerCaller \S+:\d+:\d+$/m);
    // The loop finished its 3 s and went on: the debugger let go of it.
    expect(Number(fs.readFileSync(turnsFile, 'utf8'))).toBeGreaterThan(0);
  }, 30_000);

  it('privacy: a dump holds function names and file:line, never an argument, a scope value or terminal text', async () => {
    const run = await runChild(`
      const terminalText = 'TERMINAL-CONTENT-' + process.pid;
      globalThis.paneOutput = Buffer.from(terminalText);
    ` + STUCK_IN_JS + afterStart(`outerCaller('ARG-SECRET' + terminalText)`), {}, { TURNS_FILE: path.join(root, 'turns2.txt') });
    expect(run.dumps).toHaveLength(1);
    const dump = run.dumps[0];
    expect(dump).not.toContain('ARG-SECRET');
    expect(dump).not.toContain('SCOPE-SECRET');
    expect(dump).not.toContain('TERMINAL-CONTENT');
    // Everything past the header is the state lines and frames, nothing else.
    const frames = dump.slice(dump.indexOf('frames:\n') + 'frames:\n'.length).trimEnd().split('\n');
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame).toMatch(/^ {2}\S.* \S+:\d+:\d+$/);
  }, 30_000);

  it('a dump does not spell out the home folder', async () => {
    const home = fs.mkdtempSync(path.join(root, 'home-'));
    const script = path.join(home, 'stuck.js');
    fs.writeFileSync(script, 'module.exports = function stuckInHome() { const end = Date.now() + 3000; while (Date.now() < end); };\n');
    const run = await runChild(afterStart(`require(${JSON.stringify(script)})()`), {}, { HOME: home, USERPROFILE: home });
    expect(run.dumps).toHaveLength(1);
    expect(run.dumps[0]).toMatch(/stuckInHome ~\/stuck\.js:1:\d+/);
    expect(run.dumps[0]).not.toContain(path.basename(home));
  }, 30_000);

  it('a main thread stuck below JavaScript leaves that fact, and returns normally', async () => {
    const run = await runChild(`
      const { spawnSync } = require('child_process');
    ` + afterStart(`spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore', windowsHide: true })`));
    expect(run.code).toBe(0);
    expect(run.dumps).toHaveLength(1);
    expect(run.dumps[0]).toContain('state: below JavaScript');
    expect(run.dumps[0]).toMatch(/process cpu in that wait: \d+ ms/);
    expect(run.dumps[0]).not.toContain('frames:');
  }, 30_000);

  it('a healthy loop is never dumped', async () => {
    // Slower settings: a loaded runner must not read as a stall in a test of no stall.
    const run = await runChild('setTimeout(() => process.exit(0), 2000);', { pollMs: 200, staleReads: 5 });
    expect(run.code).toBe(0);
    expect(run.dumps).toHaveLength(0);
  }, 30_000);

  it('one dump for one stall, however long it lasts', async () => {
    const run = await runChild(STUCK_IN_JS + afterStart(`outerCaller('x')`), {}, { TURNS_FILE: path.join(root, 'turns3.txt') });
    expect(run.dumps).toHaveLength(1);
  }, 30_000);

  it('a second stall inside the gap leaves nothing more; past the gap it does, and a run keeps only its newest', async () => {
    const twoStalls = `
      function stall() { const end = Date.now() + 1000; while (Date.now() < end); }
      const stalls = ${'${N}'};
      let done = 0;
      const next = () => { if (done++ === stalls) return process.exit(0); stall(); setTimeout(next, 200); };
      setTimeout(next, 1000);
    `;
    const inGap = await runChild(twoStalls.replace('${N}', '3'), { minGapMs: 60_000 });
    expect(inGap.dumps).toHaveLength(1);
    const pastGap = await runChild(twoStalls.replace('${N}', '4'), { minGapMs: 0, keptPerRun: 2 });
    expect(pastGap.dumps).toHaveLength(2);
  }, 30_000);

  it('a watchdog does not keep the process alive, whatever it is doing', async () => {
    const idle = await runChild('');
    expect(idle.code).toBe(0);
    expect(idle.ms).toBeLessThan(10_000);
    // Exiting right after a dump, while the Worker sleeps with no timeout on the heartbeat.
    const stuck = await runChild(STUCK_IN_JS + afterStart(`outerCaller('x')`), {}, { TURNS_FILE: path.join(root, 'turns4.txt') });
    expect(stuck.code).toBe(0);
    expect(stuck.ms).toBeLessThan(15_000);
  }, 30_000);

  it('the off switch starts nothing', async () => {
    const run = await runChild(afterStart(`const end = Date.now() + 1000; while (Date.now() < end);`), {}, { WMUX_HANG_EVIDENCE: '0' });
    expect(run.code).toBe(0);
    expect(run.dumps).toHaveLength(0);
    expect(run.log).toContain('watchdog off');
  }, 30_000);

  it('a folder it cannot write to costs nothing but the file', async () => {
    const run = await runChild(STUCK_IN_JS + afterStart(`outerCaller('x')`), { logsDir: path.join(root, 'bundle', 'hangWatchdog.cjs', 'nope') }, { TURNS_FILE: path.join(root, 'turns5.txt') });
    expect(run.code).toBe(0);
    expect(run.log).not.toContain('watchdog stopped');
  }, 30_000);
});
