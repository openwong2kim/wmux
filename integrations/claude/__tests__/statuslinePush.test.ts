// The statusline script pushes Claude Code's `rate_limits` to the running wmux
// app over the main pipe (`usage.rateLimits`) AFTER it has written its line.
// The contract that matters most is what it must never do: change stdout,
// change the exit code, write to stderr, or hang — with wmux down, with no
// token, or with a pipe that never answers. Spawned exactly the way Claude
// Code runs it, with a fully scrubbed env so nothing can reach a real wmux.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('../bin/wmux-statusline.mjs', import.meta.url));
const SUFFIX = '-statusline-push-test';
const RESET = Math.floor(Date.now() / 1000) + 3 * 3600;

let root: string;
let home: string;
let tmp: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-'));
  home = path.join(root, 'h');
  tmp = path.join(root, 't');
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function input(fivePct: number): Record<string, unknown> {
  return {
    model: { display_name: 'Opus 4.8' },
    rate_limits: {
      five_hour: { used_percentage: fivePct, resets_at: RESET },
      seven_day: { used_percentage: 20, resets_at: RESET + 86_400 },
    },
  };
}

function scrubbedEnv(socketPath: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('WMUX_') || k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    WMUX_DATA_SUFFIX: SUFFIX,
    WMUX_SOCKET_PATH: socketPath,
    WMUX_PTY_ID: 'pty-test',
    ...extra,
  };
}

interface Run { stdout: string; stderr: string; code: number | null; ms: number }

function run(stdin: Record<string, unknown>, socketPath: string, extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { env: scrubbedEnv(socketPath, extra), cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const kill = setTimeout(() => child.kill(), 10_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve({ stdout, stderr, code, ms: Date.now() - started });
    });
    child.stdin.end(JSON.stringify(stdin));
  });
}

function socketPathFor(name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux${SUFFIX}-${name}-${process.pid}`
    : path.join(root, `${name}.sock`);
}

const stateDir = (): string => path.join(home, `.wmux${SUFFIX}`, 'statusline-push');

function writeToken(): void {
  fs.writeFileSync(path.join(home, `.wmux${SUFFIX}-auth-token`), 'test-token\n');
}

function removeToken(): void {
  fs.rmSync(path.join(home, `.wmux${SUFFIX}-auth-token`), { force: true });
}

function clearState(): void {
  // A detached `--push` child from the previous test can still be writing its
  // state here (tmp file, then rename). On Windows a file created after rmSync
  // listed the directory makes the final rmdir fail with ENOTEMPTY (seen on
  // windows-latest CI and 2 of 8 local runs). rmSync retries on exactly that.
  fs.rmSync(stateDir(), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function readStates(): Array<{ sig: string; ok: boolean; at: number }> {
  if (!fs.existsSync(stateDir())) return [];
  return fs.readdirSync(stateDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(stateDir(), f), 'utf8')) as { sig: string; ok: boolean; at: number });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A fake main pipe answering every request with `result`. */
async function fakeMain(pipe: string, result: unknown): Promise<{ received: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const received: Array<Record<string, unknown>> = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      received.push(req);
      sock.end(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
    });
  });
  await new Promise<void>((r) => server.listen(pipe, r));
  return { received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Give a detached push child time to finish (it caps itself at 300 ms). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 600));

describe('statusline live-usage push', () => {
  it('no token: same stdout, exit 0, silent stderr, nothing written', async () => {
    clearState();
    removeToken();
    const r = await run(input(10), socketPathFor('absent'));
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('5h 10%');
    await settle();
    expect(fs.existsSync(stateDir())).toBe(false);
  });

  it('main down: stdout identical to the no-token run, exit 0, nothing recorded as delivered', async () => {
    clearState();
    removeToken();
    const baseline = await run(input(11), socketPathFor('absent'));
    writeToken();
    const down = await run(input(11), socketPathFor('absent'));
    expect(down).toMatchObject({ code: 0, stderr: '', stdout: baseline.stdout });
    await settle();
    expect(readStates().every((s) => !s.ok)).toBe(true);
  });

  it('delivers one request per changed sample; unchanged is not re-sent', async () => {
    clearState();
    writeToken();
    const pipe = socketPathFor('live');
    const main = await fakeMain(pipe, { ok: true, applied: true });
    try {
      const first = await run(input(30.5), pipe);
      expect(first).toMatchObject({ code: 0, stderr: '' });
      await waitFor(() => readStates().some((s) => s.ok));
      expect(main.received).toHaveLength(1);
      expect(main.received[0]).toMatchObject({
        method: 'usage.rateLimits',
        token: 'test-token',
        params: {
          configDir: null,
          ptyId: 'pty-test',
          rateLimits: {
            five_hour: { pct: 30.5, resets_at: RESET },
            seven_day: { pct: 20, resets_at: RESET + 86_400 },
          },
        },
      });
      expect(main.received[0]).not.toHaveProperty('clientName');

      await run(input(30.5), pipe); // unchanged → nothing sent
      await settle();
      expect(main.received).toHaveLength(1);
      await run(input(31), pipe);   // changed → sent
      await waitFor(() => main.received.length === 2);
    } finally {
      await main.close();
    }
  });

  it('an accepted sample is re-sent unchanged once the record is 10 minutes old', async () => {
    clearState();
    writeToken();
    const pipe = socketPathFor('resend');
    const main = await fakeMain(pipe, { ok: true, applied: true });
    try {
      await run(input(44), pipe);
      await waitFor(() => readStates().some((s) => s.ok));
      const [file] = fs.readdirSync(stateDir()).filter((f) => f.endsWith('.json'));
      const rec = JSON.parse(fs.readFileSync(path.join(stateDir(), file), 'utf8')) as { at: number };
      fs.writeFileSync(path.join(stateDir(), file), JSON.stringify({ ...rec, at: Date.now() - 11 * 60_000 }));
      await run(input(44), pipe);
      await waitFor(() => main.received.length === 2);
    } finally {
      await main.close();
    }
  });

  it.each([
    ['not applied', { ok: false, reason: 'not-applied' }],
    ['unknown account', { ok: false, reason: 'unknown-account' }],
    ['legacy bare ok', { ok: true }],
  ])('a %s answer is not recorded as delivered', async (_label, result) => {
    clearState();
    writeToken();
    const pipe = socketPathFor('reject');
    const main = await fakeMain(pipe, result);
    try {
      await run(input(50), pipe);
      await waitFor(() => main.received.length === 1);
      await settle();
      const states = readStates();
      expect(states).toHaveLength(1);
      expect(states[0].ok).toBe(false);
    } finally {
      await main.close();
    }
  });

  it('resolves a relative CLAUDE_CONFIG_DIR and keeps state owner-only', async () => {
    clearState();
    writeToken();
    const pipe = socketPathFor('abs');
    const main = await fakeMain(pipe, { ok: false, reason: 'unknown-account' });
    try {
      await run(input(51), pipe, { CLAUDE_CONFIG_DIR: 'rel-profile' });
      await waitFor(() => main.received.length === 1);
      const params = main.received[0].params as { configDir: string };
      expect(path.isAbsolute(params.configDir)).toBe(true);
      expect(params.configDir.endsWith('rel-profile')).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(stateDir()).mode & 0o777).toBe(0o700);
      }
    } finally {
      await main.close();
    }
  });

  it('a pipe that never answers does not hold the statusline process', async () => {
    clearState();
    writeToken();
    const pipe = socketPathFor('mute');
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => { sockets.add(sock); });
    await new Promise<void>((r) => server.listen(pipe, r));
    try {
      // Best of two, so one slow node startup cannot make the budget look spent.
      removeToken();
      const a = await run(input(40), socketPathFor('absent'));
      const b = await run(input(40), socketPathFor('absent'));
      const baseline = a.ms <= b.ms ? a : b;
      writeToken();
      clearState();
      const r = await run(input(40), pipe);
      expect(r).toMatchObject({ code: 0, stderr: '', stdout: baseline.stdout });
      // The push runs in a detached child; the statusline itself only pays
      // for the spawn, never for the 300 ms wait.
      expect(r.ms - baseline.ms).toBeLessThan(250);
      await waitFor(() => sockets.size === 1);
    } finally {
      await settle();
      for (const sk of sockets) sk.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
