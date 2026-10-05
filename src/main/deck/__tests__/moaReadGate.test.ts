import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  READ_ROOT_GRACE_MS,
  READ_ROOT_OPEN_TTL_MS,
  buildReadGateScript,
  computeReadRoots,
  currentMoaReadRoots,
  isAcceptableReadRoot,
  resolveRepoRoot,
  setMoaReadRoots,
} from '../moaReadGate';

// The real generated script, run with node against a temp tree and a fake
// MAIN pipe: what it prints and how it exits are the whole contract with
// Claude Code, and main's answer is the only source of roots.
let dir: string;
let home: string;
let repo: string;
let outside: string;
let script: string;
let server: net.Server | null;
let mainRoots: unknown;
let requests: Array<Record<string, unknown>>;

const POSIX = process.platform !== 'win32';

async function startMain(reply: 'ok' | 'silent' = 'ok'): Promise<void> {
  server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      requests.push(req);
      if (reply === 'ok') sock.write(`${JSON.stringify({ id: req.id, ok: true, result: { roots: mainRoots } })}\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(path.join(home, '.wmux.sock'), resolve));
}

beforeEach(() => {
  // Short: a Unix socket path has a length limit.
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mrg-')));
  home = path.join(dir, 'h');
  repo = path.join(dir, 'repo');
  outside = path.join(dir, 'outside');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.wmux-auth-token'), 'tok\n');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(repo, 'math.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(repo, 'src', 'x.ts'), 'export {};\n');
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote]\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOKEN=x\n');
  script = path.join(dir, 'read-gate.cjs');
  fs.writeFileSync(script, buildReadGateScript());
  server = null;
  mainRoots = [repo];
  requests = [];
});
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function gate(tool: string, input: Record<string, unknown>, opts: { cwd?: string; raw?: string } = {}) {
  return new Promise<{ status: number | null; stdout: string; allowed: boolean }>((resolve) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
    const child = spawn(process.execPath, [script], { env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.on('close', (status) => resolve({ status, stdout, allowed: stdout.includes('"permissionDecision":"allow"') }));
    child.stdin.end(opts.raw ?? JSON.stringify({ tool_name: tool, tool_input: input, cwd: opts.cwd ?? path.join(dir, 'brainhome') }));
  });
}
const ask = (r: { status: number | null; stdout: string }) => {
  // Never a block: no output and exit 0 is Claude Code's normal prompt.
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
};

describe.skipIf(!POSIX)('the read gate script', () => {
  it('allows a Read inside a root main names, asking main on its own client lane', async () => {
    await startMain();
    const r = await gate('Read', { file_path: path.join(repo, 'math.js') });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: expect.objectContaining({ hookEventName: 'PreToolUse', permissionDecision: 'allow' }) });
    expect(requests).toEqual([expect.objectContaining({ method: 'deck.moaReadRoots', token: 'tok', clientName: 'wmux-read-gate' })]);
  });

  it('no main, a main that does not answer, or no token: ask', async () => {
    ask(await gate('Read', { file_path: path.join(repo, 'math.js') }));
    await startMain('silent');
    ask(await gate('Read', { file_path: path.join(repo, 'math.js') }));
    await new Promise((r) => server!.close(r));
    await startMain();
    fs.rmSync(path.join(home, '.wmux-auth-token'));
    ask(await gate('Read', { file_path: path.join(repo, 'math.js') }));
  });

  it('a poisoned answer (/, $HOME or above it, wmux\'s data, ~/.claude) gives no root', async () => {
    fs.writeFileSync(path.join(home, '.zshrc'), 'x\n');
    fs.mkdirSync(path.join(home, '.wmux'));
    fs.writeFileSync(path.join(home, '.wmux', 'config.json'), '{}\n');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
    await startMain();
    for (const poison of ['/', home, dir, path.join(home, '.wmux'), path.join(home, '.claude')]) {
      mainRoots = [poison];
      ask(await gate('Read', { file_path: path.join(home, '.zshrc') }));
      ask(await gate('Read', { file_path: path.join(home, '.wmux', 'config.json') }));
      ask(await gate('Read', { file_path: path.join(home, '.claude', 'settings.json') }));
    }
  });

  it('asks for a Read outside every root, and for a path that does not exist', async () => {
    await startMain();
    ask(await gate('Read', { file_path: path.join(outside, 'secret.txt') }));
    ask(await gate('Read', { file_path: path.join(repo, 'missing.js') }));
  });

  it('asks for a symlink that leads out of the root, and for a hard-linked file', async () => {
    await startMain();
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'leak.js'));
    ask(await gate('Read', { file_path: path.join(repo, 'leak.js') }));
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(repo, 'hard.txt'));
    ask(await gate('Read', { file_path: path.join(repo, 'hard.txt') }));
  });

  it('asks for anything under .git and for secret files by name, in any letter case', async () => {
    await startMain();
    ask(await gate('Read', { file_path: path.join(repo, '.git', 'config') }));
    const names = ['.env', '.ENV', '.env.local', 'server.pem', 'TLS.KEY', 'id_rsa', 'ID_RSA', 'id_ed25519.pub', 'id_ecdsa', '.git-credentials',
      '.pgpass', 'vault.kdbx', 'app.keystore', 'release.jks', '.npmrc', '.netrc', 'credentials.json', 'Credentials', 'cert.p12', 'x.gpg', 'x.asc', 'K.ASC'];
    for (const name of names) {
      fs.writeFileSync(path.join(repo, name), 'x\n');
      ask(await gate('Read', { file_path: path.join(repo, name) }));
    }
    fs.mkdirSync(path.join(repo, '.docker'));
    fs.writeFileSync(path.join(repo, '.docker', 'config.json'), '{}\n');
    ask(await gate('Read', { file_path: path.join(repo, '.docker', 'config.json') }));
    fs.mkdirSync(path.join(repo, 'gh'));
    fs.writeFileSync(path.join(repo, 'gh', 'hosts.yml'), 'x\n');
    ask(await gate('Read', { file_path: path.join(repo, 'gh', 'hosts.yml') }));
    fs.writeFileSync(path.join(repo, 'config.json'), '{}\n');
    expect((await gate('Read', { file_path: path.join(repo, 'config.json') })).allowed).toBe(true);
  });

  it('Grep: one safe file only; a directory always asks, whatever its glob or type', async () => {
    await startMain();
    fs.writeFileSync(path.join(repo, 'id_rsa'), 'KEY\n');
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(repo, 'a.js'));
    for (const extra of [{}, { type: 'js' }, { glob: '*.js' }, { glob: '**/*.{ts,tsx}' }, { glob: '**/*' }]) {
      ask(await gate('Grep', { pattern: 'KEY', path: repo, ...extra }));
    }
    ask(await gate('Grep', { pattern: 'add' }));
    expect((await gate('Grep', { pattern: 'add', path: path.join(repo, 'math.js') })).allowed).toBe(true);
    ask(await gate('Grep', { pattern: 'TOKEN', path: path.join(repo, 'a.js') }));
    ask(await gate('Grep', { pattern: 'KEY', path: path.join(repo, 'id_rsa') }));
  });

  it('Glob: a relative pattern that cannot match a secret name; never "..", absolute, or a secret-capable wildcard', async () => {
    await startMain();
    expect((await gate('Glob', { pattern: '**/*.ts', path: repo })).allowed).toBe(true);
    expect((await gate('Glob', { pattern: 'src/*.{ts,js}', path: repo })).allowed).toBe(true);
    for (const pattern of ['**/.env*', '.e*', '**/*', '*', '**/id_*', '**/*.pem', '**/*.{js,key}', '**/.git/**', '../outside/*', path.join(outside, '*'), '**/CREDENTIALS*']) {
      ask(await gate('Glob', { pattern, path: repo }));
    }
    ask(await gate('Glob', { pattern: '**/*.ts', path: outside }));
  });

  it('bad stdin, another tool, or a relative Read path: ask', async () => {
    await startMain();
    ask(await gate('Read', {}, { raw: 'garbage' }));
    ask(await gate('Write', { file_path: path.join(repo, 'math.js') }));
    ask(await gate('Bash', { command: 'cat math.js' }));
    ask(await gate('Read', { file_path: 'math.js' }, { cwd: repo }));
  });
});

describe('read roots', () => {
  const now = 1_000_000;
  const accept = () => true;

  it('open hand-offs and open fan-out worktrees stand, re-stamped; ended ones keep a grace only while the job tracks them', () => {
    const roots = computeReadRoots({
      now,
      enabled: true,
      accept,
      handoffs: [
        { repoRoot: '/r/open', taskId: 't1', open: true },
        { repoRoot: '/r/ended-tracked', taskId: 't2', open: false, endedAt: now - 10_000 },
        { repoRoot: '/r/ended-untracked', taskId: 't3', open: false, endedAt: now - 10_000 },
        { repoRoot: '/r/ended-long-ago', taskId: 't4', open: false, endedAt: now - READ_ROOT_GRACE_MS - 1 },
        { repoRoot: '/r/pane-gone', taskId: 't5', open: false, endedAt: now - 1, paneGone: true },
        { taskId: 't6', open: true },
      ],
      liveTaskIds: new Set(['t2', 't4', 't5']),
      fanoutWorktrees: ['/w/task'],
    });
    expect(roots).toEqual([
      { path: '/r/ended-tracked', expiresAt: now - 10_000 + READ_ROOT_GRACE_MS },
      { path: '/r/open', expiresAt: now + READ_ROOT_OPEN_TTL_MS },
      { path: '/w/task', expiresAt: now + READ_ROOT_OPEN_TTL_MS },
    ]);
  });

  it('every root is vetted again, hand-off and fan-out alike; the setting off gives none', () => {
    const roots = computeReadRoots({
      now, enabled: true, accept: (p) => p !== '/' && p !== '/Users/me',
      handoffs: [{ repoRoot: '/', taskId: 't', open: true }, { repoRoot: '/r/ok', taskId: 'u', open: true }],
      liveTaskIds: new Set(), fanoutWorktrees: ['/Users/me'],
    });
    expect(roots.map((r) => r.path)).toEqual(['/r/ok']);
    expect(computeReadRoots({ now, enabled: false, accept, handoffs: [{ repoRoot: '/r', taskId: 't', open: true }], liveTaskIds: new Set(), fanoutWorktrees: ['/w'] })).toEqual([]);
  });

  it('main answers the gate from memory: unexpired and re-vetted only', () => {
    setMoaReadRoots([{ path: '/r/a', expiresAt: now + 1 }, { path: '/r/old', expiresAt: now - 1 }, { path: '/', expiresAt: now + 1 }]);
    expect(currentMoaReadRoots(now, (p) => p !== '/')).toEqual(['/r/a']);
    setMoaReadRoots([]);
    expect(currentMoaReadRoots(now, () => true)).toEqual([]);
  });

  it('never the filesystem root, $HOME or above it, or a blocked dir', () => {
    const h = path.join(dir, 'home');
    fs.mkdirSync(path.join(h, 'proj'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'wmux'), { recursive: true });
    const blocked = [path.join(dir, 'wmux')];
    expect(isAcceptableReadRoot(path.join(h, 'proj'), { home: h, blocked })).toBe(true);
    expect(isAcceptableReadRoot(h, { home: h, blocked })).toBe(false);
    expect(isAcceptableReadRoot(dir, { home: h, blocked })).toBe(false);
    expect(isAcceptableReadRoot(path.parse(dir).root, { home: h, blocked })).toBe(false);
    expect(isAcceptableReadRoot(path.join(dir, 'wmux'), { home: h, blocked })).toBe(false);
    expect(isAcceptableReadRoot(path.join(dir, 'missing'), { home: h, blocked })).toBe(false);
  });

  it('a forged cwd (OSC 7 pointing at ~/.ssh) gives no root: only a successful git toplevel counts', async () => {
    const h = path.join(dir, 'home');
    fs.mkdirSync(path.join(h, '.ssh'), { recursive: true });
    expect(await resolveRepoRoot(path.join(h, '.ssh'), { accept: () => true })).toBeNull();
    expect(await resolveRepoRoot(undefined)).toBeNull();
    expect(await resolveRepoRoot('relative/dir')).toBeNull();
    expect(await resolveRepoRoot(h, { run: async () => h, accept: (r) => isAcceptableReadRoot(r, { home: h, blocked: [] }) })).toBeNull();
    expect(await resolveRepoRoot(repo, { run: async () => repo, accept: () => true })).toBe(repo);
  });
});
