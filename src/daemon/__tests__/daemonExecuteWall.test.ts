import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariant: the daemon process must NEVER import the execute
// machinery. This is the PRIMARY, strongest layer of "remote A2A messages can
// never reach claudeWorker.execute()" (LanLink C1). The daemon is a separate OS
// process; if it cannot even import ClaudeWorker / RpcRouter / a2a.rpc, then a
// remote LAN listener that lives in the daemon (future LanLink PR) has no code
// path to spawn an agent — no matter how the dispatch logic above it evolves.
//
// This mirrors the repo's established source-invariant pattern (see
// squirrelWiring.test.ts): we assert over source text because importing the
// modules for a runtime check would defeat the "daemon never loads this" point.

const DAEMON_DIR = path.join(__dirname, '..');

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /from\s+['"][^'"]*ClaudeWorker['"]/, label: "import of ClaudeWorker" },
  { pattern: /from\s+['"][^'"]*\/RpcRouter['"]/, label: "import of RpcRouter" },
  { pattern: /from\s+['"][^'"]*a2a\.rpc['"]/, label: "import of a2a.rpc" },
  { pattern: /\bclaudeWorker\.execute\s*\(/, label: "call to claudeWorker.execute()" },
  // LanLink PR-4 (C19): broaden the wall beyond the three named modules so the
  // process boundary does not rest solely on the daemon tsconfig include list. The
  // daemon legitimately imports pure helpers from src/main/pty (OSC/cwd/agent
  // parsing), so a blanket src/main ban is impossible; instead we ban the execute
  // MACHINERY trees — src/main/a2a (ClaudeWorker lives here) and src/main/pipe
  // (RpcRouter + a2a.rpc live here). No daemon file imports from these today, and
  // none ever should: that is exactly where a remote byte could reach execute.
  // Match both a deeper import (.../main/a2a/ClaudeWorker) AND a directory-index
  // import (.../main/a2a) by requiring a2a/pipe to be followed by a slash OR the
  // closing quote.
  { pattern: /from\s+['"][^'"]*\/main\/(a2a|pipe)(\/|['"])/, label: "import of src/main execute machinery (a2a/pipe)" },
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('daemon execute-wall — process-boundary invariant (LanLink C1)', () => {
  const files = collectTsFiles(DAEMON_DIR);

  it('finds daemon source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no daemon source imports ClaudeWorker / RpcRouter / a2a.rpc, nor calls claudeWorker.execute()', () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(src)) {
          violations.push(`${path.relative(DAEMON_DIR, file)} — ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// Every module a source names: static imports (one line or many), side-effect
// imports, re-exports, require() and dynamic import().
function moduleSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[2]);
  return out;
}

const EXECUTE_MODULES: readonly RegExp[] = [/ClaudeWorker$/, /\/RpcRouter$/, /a2a\.rpc$/, /\/main\/(a2a|pipe)(\/|$)/];

describe('daemon execute-wall — every way of naming a module', () => {
  it('no daemon source reaches the execute machinery by require, dynamic import or re-export either', () => {
    const violations: string[] = [];
    for (const file of collectTsFiles(DAEMON_DIR)) {
      for (const spec of moduleSpecifiers(fs.readFileSync(file, 'utf-8'))) {
        if (EXECUTE_MODULES.some((re) => re.test(spec))) violations.push(`${path.relative(DAEMON_DIR, file)} — ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// Headless remote spawn: the daemon starts (and, later, feeds) remote agents
// itself on a host without the app. Under src/daemon/a2aRemote only the
// headless starter and the pane port it is given (headlessSessions.ts) may
// name the pane functions, which index.ts hands them; every other file there
// stays a transport that cannot open a pane or type into one. Owners are
// matched by their path below src/daemon.
const A2A_REMOTE_DIR = path.join(DAEMON_DIR, 'a2aRemote');
const rel = (file: string): string => path.relative(DAEMON_DIR, file).split(path.sep).join('/');
const PANE_OWNERS: ReadonlySet<string> = new Set(['a2aRemote/headlessStarter.ts', 'a2aRemote/headlessSessions.ts']);
const PANE_FUNCTIONS = /\b(createSession\w*|destroySession\w*|createWebPane|deliverPromptToSession\w*|deliverScheduledPrompt|ptyProcess|sessionManager|HeadlessSessionPort)\b|\bsessions\(\)/;
/** What opens, ends or types into a pane, as index.ts names it. */
const PANE_CLOSURES = /\b(createSessionRpc|destroySessionRpc|deliverPromptToSession\w*|deliverScheduledPrompt|createWebPane|sessionLifecycle|headlessSessionsRef|ptyProcess\.write)\b/;

/** The text between the parentheses that open at `open` (strings and comments skipped). */
function argumentsAt(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const eol = src.indexOf('\n', i);
      i = eol < 0 ? src.length : eol;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

describe('daemon execute-wall — headless remote spawn', () => {
  it('only the headless starter under a2aRemote names the pane functions', () => {
    const named = collectTsFiles(A2A_REMOTE_DIR)
      .filter((file) => PANE_FUNCTIONS.test(fs.readFileSync(file, 'utf-8')))
      .map(rel)
      .filter((name) => !PANE_OWNERS.has(name));
    expect(named).toEqual([]);
  });

  it('the pane owners import no pane machinery themselves (it is injected)', () => {
    for (const owner of PANE_OWNERS) {
      const file = path.join(DAEMON_DIR, owner);
      expect(fs.existsSync(file), owner).toBe(true);
      const specs = moduleSpecifiers(fs.readFileSync(file, 'utf-8'));
      expect(specs.filter((s) => /DaemonSessionManager|sessionPromptDelivery|^\.\.\/index$|webPaneEnv|node-pty/.test(s))).toEqual([]);
    }
  });

  it('in index.ts, only the headless starter is handed what opens, ends or types into a pane', () => {
    const src = fs.readFileSync(path.join(DAEMON_DIR, 'index.ts'), 'utf-8');
    // Every value imported from ./a2aRemote/* (multi-line imports included), by the file it comes from.
    const fromA2a = new Map<string, string>();
    const importRe = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]\.\/a2aRemote\/([^'"]+)['"]/g;
    for (let m = importRe.exec(src); m; m = importRe.exec(src)) {
      if (m[1]) continue;
      for (const part of m[2].split(',')) {
        const name = part.trim();
        if (!name || name.startsWith('type ')) continue;
        fromA2a.set(name.split(/\s+as\s+/).pop() as string, `a2aRemote/${m[3]}.ts`);
      }
    }
    expect(fromA2a.size).toBeGreaterThan(10);
    const handed: string[] = [];
    for (const [name, file] of fromA2a) {
      if (PANE_OWNERS.has(file)) continue;
      const callRe = new RegExp(`\\b${name}\\s*\\(`, 'g');
      for (let m = callRe.exec(src); m; m = callRe.exec(src)) {
        if (PANE_CLOSURES.test(argumentsAt(src, m.index + m[0].length - 1))) handed.push(`${name} (${file})`);
      }
    }
    expect(handed).toEqual([]);
    // The starter itself is handed them (the check above would miss it if it were renamed away).
    const starter = src.indexOf('new A2aHeadlessStarter(');
    expect(starter).toBeGreaterThan(-1);
    expect(argumentsAt(src, starter + 'new A2aHeadlessStarter'.length)).toMatch(/headlessSessionsRef/);
  });
});
