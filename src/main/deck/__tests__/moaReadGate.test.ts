import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  READ_ROOT_GRACE_MS,
  READ_ROOT_OPEN_TTL_MS,
  buildReadGateScript,
  computeReadRoots,
  isAcceptableReadRoot,
  resolveRepoRoot,
  writeReadRoots,
} from '../moaReadGate';

// The real generated script, run with node against a temp tree: what it
// prints and how it exits are the whole contract with Claude Code.
let dir: string;
let repo: string;
let outside: string;
let script: string;
let rootsFile: string;

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moa-read-gate-')));
  repo = path.join(dir, 'repo');
  outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(repo, 'math.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(repo, 'src', 'x.ts'), 'export {};\n');
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote]\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOKEN=x\n');
  script = path.join(dir, 'read-gate.cjs');
  fs.writeFileSync(script, buildReadGateScript());
  rootsFile = path.join(dir, 'moa-read-roots.json');
  writeReadRoots(rootsFile, [{ path: repo, expiresAt: Date.now() + 60_000 }]);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function gate(tool: string, input: Record<string, unknown>, opts: { cwd?: string; raw?: string; roots?: string } = {}) {
  const res = spawnSync(process.execPath, [script, opts.roots ?? rootsFile], {
    input: opts.raw ?? JSON.stringify({ tool_name: tool, tool_input: input, cwd: opts.cwd ?? path.join(dir, 'home') }),
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, allowed: res.stdout.includes('"permissionDecision":"allow"') };
}
const ask = (r: ReturnType<typeof gate>) => {
  // Never a block: no output and exit 0 is Claude Code's normal prompt.
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
};

describe('the read gate script', () => {
  it('allows a Read inside a root, as a PreToolUse allow', () => {
    const r = gate('Read', { file_path: path.join(repo, 'math.js') });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: expect.objectContaining({ hookEventName: 'PreToolUse', permissionDecision: 'allow' }) });
  });

  it('asks for a Read outside every root, and for a path that does not exist', () => {
    ask(gate('Read', { file_path: path.join(outside, 'secret.txt') }));
    ask(gate('Read', { file_path: path.join(repo, 'missing.js') }));
  });

  it('asks for a symlink that leads out of the root', () => {
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'leak.js'));
    } catch {
      return; // no symlink rights (Windows CI): nothing to test
    }
    ask(gate('Read', { file_path: path.join(repo, 'leak.js') }));
  });

  it('asks for a hard-linked file', () => {
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(repo, 'hard.txt'));
    ask(gate('Read', { file_path: path.join(repo, 'hard.txt') }));
  });

  it('asks for anything under .git, and for secret files by name', () => {
    ask(gate('Read', { file_path: path.join(repo, '.git', 'config') }));
    ask(gate('Grep', { pattern: 'x', path: path.join(repo, '.git') }));
    const names = ['.env', '.env.local', 'server.pem', 'tls.key', 'id_rsa', 'id_ed25519.pub', 'id_ecdsa', '.git-credentials',
      '.pgpass', 'vault.kdbx', 'app.keystore', 'release.jks', '.npmrc', '.netrc', 'credentials.json', 'cert.p12'];
    for (const name of names) {
      fs.writeFileSync(path.join(repo, name), 'x\n');
      ask(gate('Read', { file_path: path.join(repo, name) }));
    }
    fs.mkdirSync(path.join(repo, '.docker'));
    fs.writeFileSync(path.join(repo, '.docker', 'config.json'), '{}\n');
    ask(gate('Read', { file_path: path.join(repo, '.docker', 'config.json') }));
    fs.mkdirSync(path.join(repo, 'gh'));
    fs.writeFileSync(path.join(repo, 'gh', 'hosts.yml'), 'x\n');
    ask(gate('Read', { file_path: path.join(repo, 'gh', 'hosts.yml') }));
    // Ordinary names with the same parts are not secrets.
    fs.writeFileSync(path.join(repo, 'config.json'), '{}\n');
    expect(gate('Read', { file_path: path.join(repo, 'config.json') }).allowed).toBe(true);
  });

  it('Grep on a directory: no glob or a type is allowed; a glob that would include hidden files asks', () => {
    expect(gate('Grep', { pattern: 'add', path: repo }).allowed).toBe(true);
    expect(gate('Grep', { pattern: 'add', path: repo, type: 'js' }).allowed).toBe(true);
    expect(gate('Grep', { pattern: 'add', path: repo, glob: '*.js' }).allowed).toBe(true);
    expect(gate('Grep', { pattern: 'add', path: repo, glob: '**/*.{ts,tsx}' }).allowed).toBe(true);
    for (const glob of ['**/*', '*', '.env', '*.env', '**/*.pem', '.*', 'src/**', '*.{js,key}']) {
      ask(gate('Grep', { pattern: 'TOKEN', path: repo, glob }));
    }
    // No path: the brain's own home, never a root.
    ask(gate('Grep', { pattern: 'add' }));
    // A file: the Read rules.
    expect(gate('Grep', { pattern: 'add', path: path.join(repo, 'math.js') }).allowed).toBe(true);
  });

  it('Glob: a directory in a root with a relative pattern; never ".." or an absolute pattern', () => {
    expect(gate('Glob', { pattern: '**/*.ts', path: repo }).allowed).toBe(true);
    ask(gate('Glob', { pattern: '../outside/*', path: repo }));
    ask(gate('Glob', { pattern: path.join(outside, '*'), path: repo }));
    ask(gate('Glob', { pattern: '**/*', path: outside }));
  });

  it('an expired root, a missing or broken roots file, bad stdin, or another tool: ask', () => {
    writeReadRoots(rootsFile, [{ path: repo, expiresAt: Date.now() - 1 }]);
    ask(gate('Read', { file_path: path.join(repo, 'math.js') }));
    ask(gate('Read', { file_path: path.join(repo, 'math.js') }, { roots: path.join(dir, 'nope.json') }));
    fs.writeFileSync(rootsFile, '{ not json');
    ask(gate('Read', { file_path: path.join(repo, 'math.js') }));
    writeReadRoots(rootsFile, [{ path: repo, expiresAt: Date.now() + 60_000 }]);
    ask(gate('Read', {}, { raw: 'garbage' }));
    ask(gate('Write', { file_path: path.join(repo, 'math.js') }));
    ask(gate('Bash', { command: 'cat math.js' }));
  });

  it('a relative Read path is never resolved against the brain home into a root', () => {
    ask(gate('Read', { file_path: 'math.js' }, { cwd: repo }));
  });
});

describe('read roots', () => {
  const now = 1_000_000;

  it('open hand-offs and open fan-out worktrees stand, re-stamped; ended ones keep a grace only while the job tracks them', () => {
    const roots = computeReadRoots({
      now,
      enabled: true,
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

  it('the setting off writes no roots', () => {
    expect(computeReadRoots({ now, enabled: false, handoffs: [{ repoRoot: '/r', taskId: 't', open: true }], liveTaskIds: new Set(), fanoutWorktrees: ['/w'] })).toEqual([]);
  });

  it('never the filesystem root, $HOME or above it, or a blocked dir', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'wmux'), { recursive: true });
    const blocked = [path.join(dir, 'wmux')];
    expect(isAcceptableReadRoot(path.join(home, 'proj'), { home, blocked })).toBe(true);
    expect(isAcceptableReadRoot(home, { home, blocked })).toBe(false);
    expect(isAcceptableReadRoot(dir, { home, blocked })).toBe(false);
    expect(isAcceptableReadRoot(path.parse(dir).root, { home, blocked })).toBe(false);
    expect(isAcceptableReadRoot(path.join(dir, 'wmux'), { home, blocked })).toBe(false);
    expect(isAcceptableReadRoot(path.join(dir, 'missing'), { home, blocked })).toBe(false);
  });

  it('a forged cwd (OSC 7 pointing at ~/.ssh) gives no root: only a successful git toplevel counts', async () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    // Real git: ~/.ssh is not a repository, so nothing is added.
    expect(await resolveRepoRoot(path.join(home, '.ssh'), { accept: () => true })).toBeNull();
    expect(await resolveRepoRoot(undefined)).toBeNull();
    expect(await resolveRepoRoot('relative/dir')).toBeNull();
    // A toplevel that is $HOME itself is refused.
    expect(await resolveRepoRoot(home, { run: async () => home, accept: (r) => isAcceptableReadRoot(r, { home, blocked: [] }) })).toBeNull();
    expect(await resolveRepoRoot(repo, { run: async () => repo, accept: () => true })).toBe(repo);
  });

  it('writes the file atomically and owner-only', () => {
    writeReadRoots(rootsFile, [{ path: repo, expiresAt: 5 }]);
    expect(JSON.parse(fs.readFileSync(rootsFile, 'utf8'))).toEqual({ version: 1, roots: [{ path: repo, expiresAt: 5 }] });
    if (process.platform !== 'win32') expect(fs.statSync(rootsFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
