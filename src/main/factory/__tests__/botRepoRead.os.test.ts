// A repository-reading bot's Read / Grep / Glob calls, as main decides them:
// paths resolve (symlinks followed) inside the repository root, protected
// files are refused, path-less searches land on the root, escaping globs and
// every other tool are refused, and a Grep result naming a protected file is
// withheld.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BOT_REPO_READ_TOOLS,
  BOT_REPO_SECRET_PATTERNS,
  botRepoReadDenyRules,
  botRepoReadRoot,
  evaluateBotRepoRead,
  grepOutputNamesProtected,
  protectedPatternOf,
} from '../botRepoRead';
import { type BotEngine, type BotProfile, type BotRole } from '../../../shared/bot';

let base = '';
let root = '';
let outside = '';

beforeEach(() => {
  // The native realpath, as the product resolves (it expands Windows 8.3 short names).
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reporead-')));
  root = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'src', 'answer.ts'), 'export function answer() { return 42; }\n');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=dummy\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const decide = (tool: string, input: Record<string, unknown>) => evaluateBotRepoRead(tool, input, root);

describe('evaluateBotRepoRead', () => {
  it('Read inside the repository is allowed, with the resolved absolute path', () => {
    expect(decide('Read', { file_path: path.join(root, 'src', 'answer.ts') })).toEqual({
      ok: true, input: { file_path: path.join(root, 'src', 'answer.ts') },
    });
    // A relative path resolves against the repository root, not the session cwd.
    expect(decide('Read', { file_path: 'src/answer.ts', limit: 5 })).toEqual({
      ok: true, input: { file_path: path.join(root, 'src', 'answer.ts'), limit: 5 },
    });
  });

  it('Read outside the repository is refused, by absolute path and by ../', () => {
    expect(decide('Read', { file_path: path.join(outside, 'secret.txt') })).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the repository/) });
    expect(decide('Read', { file_path: '../outside/secret.txt' })).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the repository/) });
    expect(decide('Read', { file_path: path.join(root, 'src', '..', '..', 'outside', 'secret.txt') })).toMatchObject({ ok: false });
  });

  // Creating symlinks needs a privilege on Windows.
  const symlinks = it.skipIf(process.platform === 'win32');

  symlinks('a symlink inside the repository that points outside is refused', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'src', 'link.txt'));
    fs.symlinkSync(outside, path.join(root, 'linked-dir'));
    expect(decide('Read', { file_path: path.join(root, 'src', 'link.txt') })).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) });
    expect(decide('Grep', { pattern: 'x', path: path.join(root, 'linked-dir') })).toMatchObject({ ok: false, reason: expect.stringMatching(/outside/) });
    expect(decide('Glob', { pattern: '*', path: 'linked-dir' })).toMatchObject({ ok: false });
  });

  symlinks('a symlink with an innocent name that points at a protected file is refused', () => {
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'src', 'notes.txt'));
    expect(decide('Read', { file_path: path.join(root, 'src', 'notes.txt') })).toMatchObject({ ok: false, reason: expect.stringMatching(/protected file \(\.env\)/) });
  });

  it('a missing path and an unreadable root fail closed', () => {
    expect(decide('Read', { file_path: path.join(root, 'nope.ts') })).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) });
    expect(evaluateBotRepoRead('Read', { file_path: 'a' }, path.join(base, 'gone'))).toMatchObject({ ok: false, reason: expect.stringMatching(/not readable/) });
    expect(decide('Read', {})).toMatchObject({ ok: false });
    expect(decide('Read', { file_path: 42 })).toMatchObject({ ok: false });
    expect(decide('Grep', { pattern: 'x', path: '' })).toMatchObject({ ok: false });
  });

  it('Grep and Glob with no path search the repository root', () => {
    expect(decide('Grep', { pattern: 'answer', output_mode: 'content' })).toEqual({ ok: true, input: { pattern: 'answer', output_mode: 'content', path: root } });
    expect(decide('Glob', { pattern: '**/*.ts' })).toEqual({ ok: true, input: { pattern: '**/*.ts', path: root } });
    expect(decide('Grep', { pattern: 'answer', path: 'src', glob: '*.{ts,tsx}' })).toEqual({ ok: true, input: { pattern: 'answer', path: path.join(root, 'src'), glob: '*.{ts,tsx}' } });
  });

  it('Glob patterns and Grep globs that leave the searched folder are refused', () => {
    for (const pattern of ['/etc/*', '../*', 'src/../../outside/*', '{..,src}/*', '~/x', '!../x']) {
      expect({ pattern, d: decide('Glob', { pattern }) }).toMatchObject({ pattern, d: { ok: false } });
    }
    for (const glob of ['/etc/*', '../*.ts', '*.ts ../x', '*.ts,../x']) {
      expect({ glob, d: decide('Grep', { pattern: 'x', glob }) }).toMatchObject({ glob, d: { ok: false } });
    }
    expect(decide('Glob', {})).toMatchObject({ ok: false });
    expect(decide('Grep', { pattern: 'x', path: '/etc' })).toMatchObject({ ok: false });
  });

  it('protected files and folders are refused for every read tool', () => {
    expect(decide('Read', { file_path: '.env' })).toMatchObject({ ok: false, reason: expect.stringMatching(/\.env/) });
    expect(decide('Read', { file_path: path.join(root, '.git', 'config') })).toMatchObject({ ok: false, reason: expect.stringMatching(/\.git/) });
    expect(decide('Grep', { pattern: 'x', path: '.git' })).toMatchObject({ ok: false });
    expect(decide('Glob', { pattern: '*', path: path.join(root, '.git') })).toMatchObject({ ok: false });
    // Refused before the file is looked up: a missing protected file reads the same.
    expect(decide('Read', { file_path: 'config/credentials.json' })).toMatchObject({ ok: false, reason: expect.stringMatching(/protected/) });
  });

  it('every other tool is refused: write tools, shell, web, subagents and unknown names', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'read', 'mcp__other__x']) {
      expect({ tool, d: decide(tool, { file_path: path.join(root, 'src', 'answer.ts') }) }).toMatchObject({ tool, d: { ok: false } });
    }
    expect(BOT_REPO_READ_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
  });
});

describe('BOT_REPO_SECRET_PATTERNS', () => {
  const samples: Record<string, string[]> = {
    '.env': ['.env', 'app/.ENV'],
    '.env.*': ['.env.local', 'pkg/.env.production'],
    '*.pem': ['server.pem', 'certs/ca.PEM'],
    '*.key': ['tls.key', 'a/b/private.key'],
    '*.p12': ['cert.p12'],
    '*.pfx': ['cert.pfx'],
    'id_rsa*': ['id_rsa', 'keys/id_rsa.pub'],
    'id_dsa*': ['id_dsa'],
    'id_ecdsa*': ['id_ecdsa'],
    'id_ed25519*': ['deploy/id_ed25519'],
    '.npmrc': ['.npmrc', 'packages/x/.npmrc'],
    '.netrc': ['.netrc'],
    '.pypirc': ['.pypirc'],
    'credentials*': ['credentials', 'config/credentials.json'],
    '.git': ['.git', '.git/config', 'vendor/lib/.git/HEAD'],
    '.ssh': ['.ssh/known_hosts', 'home/.ssh/config'],
  };

  it('has a sample per entry', () => {
    expect(Object.keys(samples).sort()).toEqual([...BOT_REPO_SECRET_PATTERNS].sort());
  });

  for (const pattern of BOT_REPO_SECRET_PATTERNS) {
    it(`protects ${pattern}`, () => {
      for (const rel of samples[pattern]) expect({ rel, hit: protectedPatternOf(rel) }).toEqual({ rel, hit: pattern });
      // ...and Read is refused for it, whether or not the file exists.
      expect(decide('Read', { file_path: samples[pattern][0] })).toMatchObject({ ok: false });
    });
  }

  it('leaves ordinary source files alone', () => {
    for (const rel of ['src/env.ts', 'docs/keys.md', 'environment.ts', 'src/gitignore.ts', '.github/workflows/ci.yml', 'monkey.ts', 'pem/README.md']) {
      expect({ rel, hit: protectedPatternOf(rel) }).toEqual({ rel, hit: null });
    }
  });

  it('turns into Read deny rules under the root, POSIX and Windows', () => {
    const rules = botRepoReadDenyRules('/work/app', 'darwin');
    expect(rules).toContain('Read(//work/app/**/.env)');
    expect(rules).toContain('Read(//work/app/**/.git/**)');
    expect(rules).toHaveLength(BOT_REPO_SECRET_PATTERNS.length * 2);
    expect(botRepoReadDenyRules('C:\\work\\app', 'win32')).toContain('Read(//c/work/app/**/*.pem)');
    // Pattern characters in the root are literal.
    expect(botRepoReadDenyRules('/work/repo[1]{x}*?', 'darwin')).toContain('Read(//work/repo\\[1\\]\\{x\\}\\*\\?/**/.env)');
  });
});

describe('grepOutputNamesProtected', () => {
  it('flags a result naming a protected file, in every output mode', () => {
    const env = path.join(root, '.env');
    expect(grepOutputNamesProtected({ mode: 'files_with_matches', filenames: [env] }, root)).toBe(true);
    expect(grepOutputNamesProtected({ mode: 'content', filenames: [], content: `${env}:1:TOKEN=dummy` }, root)).toBe(true);
    expect(grepOutputNamesProtected({ mode: 'content', filenames: [], content: `${env}-1-TOKEN=dummy` }, root)).toBe(true);
    expect(grepOutputNamesProtected({ mode: 'count', filenames: [], content: `${env}:1` }, root)).toBe(true);
  });

  it('flags a protected file that no longer exists (deleted or renamed after the search)', () => {
    const gone = path.join(root, 'config', '.env.local');
    expect(grepOutputNamesProtected({ mode: 'content', content: `${gone}:3:TOKEN=dummy` }, root)).toBe(true);
    expect(grepOutputNamesProtected({ mode: 'content', content: `${gone}-4-TOKEN=dummy` }, root)).toBe(true);
    expect(grepOutputNamesProtected({ mode: 'content', content: `${gone}-TOKEN=dummy` }, root)).toBe(true);
    expect(grepOutputNamesProtected({ mode: 'count', content: `${gone}:2` }, root)).toBe(true);
  });

  it('passes ordinary results, including text that mentions a protected name', () => {
    const src = path.join(root, 'src', 'answer.ts');
    expect(grepOutputNamesProtected({ mode: 'files_with_matches', filenames: [src] }, root)).toBe(false);
    expect(grepOutputNamesProtected({ mode: 'content', content: `${src}:1:load('../.env') // see .git/config` }, root)).toBe(false);
    expect(grepOutputNamesProtected({ mode: 'content', content: `${src}-2-x\n--\n${src}:3:y` }, root)).toBe(false);
    expect(grepOutputNamesProtected(null, root)).toBe(false);
  });
});

describe('botRepoReadRoot', () => {
  const profile = (role: BotRole, engine: BotEngine, repo?: BotProfile['repo']): Pick<BotProfile, 'role' | 'engine' | 'repo'> => ({ role, engine, ...(repo ? { repo } : {}) });
  const repo = { repoKey: 'github.com/acme/app', repoPath: '/work/app' };

  it('any claude-sdk bot with a repository reads it, a coordinator (Moa) included', () => {
    for (const role of ['lead', 'triage', 'verifier', 'maintainer', 'moa'] as const) {
      expect(botRepoReadRoot(profile(role, { kind: 'claude-sdk' }, repo))).toBe('/work/app');
    }
  });

  it('a bot without a repository, and other engines, do not', () => {
    expect(botRepoReadRoot(profile('lead', { kind: 'claude-sdk' }))).toBeUndefined();
    expect(botRepoReadRoot(profile('lead', { kind: 'acp', command: 'hermes', args: [] }, repo))).toBeUndefined();
    expect(botRepoReadRoot(profile('lead', { kind: 'claude-pty' }, repo))).toBeUndefined();
    expect(botRepoReadRoot(profile('lead', { kind: 'claude-sdk' }, { repoKey: 'k', repoPath: 'relative' }))).toBeUndefined();
  });
});
