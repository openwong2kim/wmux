// Shared plumbing for the wmux Electron e2e suite: an isolated HOME, the plain
// electron binary on the .vite build, a fake `claude`, a pipe RPC client that
// plays Moa's brain, and process cleanup (the app's daemon is detached).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACTS = process.env.WMUX_E2E_ARTIFACTS || path.join(ROOT, 'e2e', 'artifacts');
const SUFFIX = '-e2e';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 30_000, interval = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

export function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=wmux-e2e', '-c', 'user.email=e2e@wmux.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** A fresh HOME with the fake claude first on PATH, and a project cloned from
 *  a local bare remote. */
export function makeSandbox(name) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wmux-e2e-${name}-`)));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ['claude', 'gh']) {
    fs.copyFileSync(path.join(ROOT, 'e2e', 'fake-bin', tool), path.join(bin, tool));
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  fs.writeFileSync(path.join(home, '.bashrc'), 'export PATH="$HOME/.local/bin:$PATH"\n');
  fs.writeFileSync(path.join(home, '.profile'), '. "$HOME/.bashrc"\n');
  const remote = path.join(home, 'remote.git');
  git(['init', '-q', '--bare', '-b', 'main', remote], home);
  const seed = path.join(home, 'seed');
  fs.mkdirSync(seed);
  git(['init', '-q', '-b', 'main'], seed);
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: 'e2e-project', version: '1.0.0', private: true, scripts: { test: 'node test.js' } }, null, 2));
  // The project's own test: feature.txt must say "done".
  fs.writeFileSync(path.join(seed, 'test.js'), [
    "const fs = require('fs');",
    "const v = fs.existsSync('feature.txt') ? fs.readFileSync('feature.txt', 'utf8').trim() : '(missing)';",
    "if (v !== 'done') { console.error(`FAIL feature.txt is ${v}`); process.exit(1); }",
    "console.log('PASS 1 test: feature.txt is done');",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
  git(['add', '.'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['remote', 'add', 'origin', remote], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  const project = path.join(home, 'project');
  git(['clone', '-q', remote, project], home);
  fs.rmSync(seed, { recursive: true, force: true });
  return { home, bin, remote, project, runId: crypto.randomUUID() };
}

/** The pull requests the fake gh recorded, by number. */
export function fakePrs(sb) {
  const db = path.join(sb.home, '.e2e-gh');
  if (!fs.existsSync(db)) return {};
  const out = {};
  for (const f of fs.readdirSync(db).filter((x) => /^pr-\d+\.json$/.test(x))) {
    const pr = JSON.parse(fs.readFileSync(path.join(db, f), 'utf8'));
    pr.body = fs.readFileSync(path.join(db, f.replace('.json', '.body')), 'utf8');
    out[pr.number] = pr;
  }
  return out;
}

/** The script the fake claude runs once in its worktree. */
export function setWorkerScript(sb, body) {
  fs.writeFileSync(path.join(sb.home, '.e2e-worker.sh'), `set -e\n${body}\n`);
}

export async function launchApp(sb) {
  const env = {
    ...process.env,
    HOME: sb.home,
    PATH: `${sb.bin}:${process.env.PATH}`,
    WMUX_DATA_SUFFIX: SUFFIX,
    WMUX_E2E_HOOKS: '1',
    WMUX_E2E_RUN: sb.runId,
  };
  delete env.WMUX_SOCKET_PATH;
  delete env.WMUX_AUTH_TOKEN;
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [ROOT, '--no-sandbox'],
    env,
    timeout: 90_000,
  });
  const logs = [];
  const keep = (d) => {
    logs.push(String(d));
    if (logs.length > 4000) logs.shift();
  };
  app.process().stdout?.on('data', keep);
  app.process().stderr?.on('data', keep);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, logs };
}

/** Kill every process of this run: the app and its detached daemon and ptys
 *  (they carry WMUX_E2E_RUN in their environment). */
export function killRun(sb) {
  const mine = [];
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      if (env.includes(`WMUX_E2E_RUN=${sb.runId}`) || env.includes(`HOME=${sb.home}\0`)) mine.push(Number(pid));
    } catch {
      /* gone or not ours */
    }
  }
  for (const pid of mine) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return mine.length;
}

export async function shot(win, name) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const p = path.join(ARTIFACTS, `${name}.png`);
  await win.screenshot({ path: p });
  return p;
}

/** One pipe RPC, framed like src/mcp/wmux-client.ts, as Moa's brain. */
export function rpc(sb, method, params, { commanderToken, timeout = 60_000 } = {}) {
  const auth = fs.readFileSync(path.join(sb.home, `.wmux${SUFFIX}-auth-token`), 'utf8').trim();
  const sock = path.join(sb.home, `.wmux${SUFFIX}.sock`);
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const envelope = { id, method, params: { ...params, ...(commanderToken ? { token: commanderToken } : {}) }, token: auth, clientName: 'wmux-e2e' };
    if (commanderToken) envelope.commanderToken = commanderToken;
    const s = net.connect(sock);
    let buf = '';
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`rpc timeout ${method}`));
    }, timeout);
    s.on('connect', () => s.write(`${JSON.stringify(envelope)}\n`));
    s.on('data', (c) => {
      buf += c.toString('utf8');
      for (const line of buf.split('\n').slice(0, -1)) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        s.end();
        if (msg.ok === false) reject(new Error(`${method}: ${typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    s.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
