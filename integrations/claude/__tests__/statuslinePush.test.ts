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

function scrubbedEnv(socketPath: string): NodeJS.ProcessEnv {
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
  };
}

interface Run { stdout: string; stderr: string; code: number | null; ms: number }

function run(stdin: Record<string, unknown>, socketPath: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { env: scrubbedEnv(socketPath) });
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

function writeToken(): void {
  fs.writeFileSync(path.join(home, `.wmux${SUFFIX}-auth-token`), 'test-token\n');
}

function clearState(): void {
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
}

describe('statusline live-usage push', () => {
  it('no token: same stdout, exit 0, silent stderr, no state file', async () => {
    clearState();
    const r = await run(input(10), socketPathFor('absent'));
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toContain('5h 10%');
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('main down: stdout identical to the no-token run, exit 0', async () => {
    clearState();
    const baseline = await run(input(11), socketPathFor('absent'));
    writeToken();
    const down = await run(input(11), socketPathFor('absent'));
    expect(down).toMatchObject({ code: 0, stderr: '', stdout: baseline.stdout });
  });

  it('delivers one request per changed sample to a live pipe', async () => {
    clearState();
    writeToken();
    const pipe = socketPathFor('live');
    const received: Array<Record<string, unknown>> = [];
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        received.push(req);
        sock.end(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + '\n');
      });
    });
    await new Promise<void>((r) => server.listen(pipe, r));
    try {
      const first = await run(input(30.5), pipe);
      expect(first).toMatchObject({ code: 0, stderr: '' });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
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
      expect(received[0]).not.toHaveProperty('clientName');

      await run(input(30.5), pipe); // unchanged → nothing sent
      expect(received).toHaveLength(1);
      await run(input(31), pipe);   // changed → sent
      expect(received).toHaveLength(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a pipe that never answers is abandoned within the cap', async () => {
    clearState();
    writeToken();
    const pipe = socketPathFor('mute');
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => { sockets.add(sock); });
    await new Promise<void>((r) => server.listen(pipe, r));
    try {
      // Best of two, so one slow node startup cannot make the budget look spent.
      const a = await run(input(40), socketPathFor('absent'));
      const b = await run(input(40), socketPathFor('absent'));
      const baseline = a.ms <= b.ms ? a : b;
      clearState();
      const r = await run(input(40), pipe);
      expect(r).toMatchObject({ code: 0, stderr: '', stdout: baseline.stdout });
      // Node startup dominates; the push adds at most its 300 ms cap.
      expect(r.ms - baseline.ms).toBeLessThan(1000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
