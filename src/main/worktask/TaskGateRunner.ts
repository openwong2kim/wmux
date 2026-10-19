// ─── TaskGateRunner — the completion gate a task must pass, run by the daemon ─
//
// Before this, "did the task's work actually build?" was something only a human
// could answer: the brain could type `npm test` into a pane and then read a
// terminal screen. Screens are not receipts. This runner executes a FIXED,
// allow-listed command set inside the task's own worktree and writes one
// structured verdict into the task ledger, so `completed` means a gate passed
// rather than a worker having said so.
//
// The caller supplies no command. The only argv arrays this file will ever
// spawn are `allowedGateArgv()`, chosen by the runner from what the project
// itself declares:
//
//   1. `scripts/verify.sh` — ONLY when the project's `wmux.json` is currently
//      TRUSTED (ProjectConfigStore verdict, i.e. the user approved these exact
//      bytes) and declares the well-known command id `verify`. The declared
//      command STRING is not executed: it is compared against the allow-list,
//      and anything else is a refusal rather than a fallback, so a project that
//      believes it declared its own gate is never silently graded by another.
//   2. otherwise `npm run lint`, then `npm test` — each only if package.json
//      actually declares that script. Sequential, first failure stops.
//
// ── WHAT THIS IS NOT: A SANDBOX ─────────────────────────────────────────────
//
// The allow-list constrains WHICH script runs. It does not constrain what that
// script DOES, and it cannot: `scripts/verify.sh` and the `lint`/`test` entries
// in package.json are files inside the task worktree, which is exactly the tree
// the worker has been editing. Running the gate therefore executes code the
// worker controls, in a daemon-spawned process, with the daemon's own user,
// environment and filesystem access — the same privileges any pane agent
// already has, but reached without a pane and without a permission prompt.
//
// Two consequences that must not be forgotten by anyone reading this file:
//   * A gate run is not a safe way to inspect an untrusted worktree. Do not
//     expose it on a surface where the caller is less trusted than the person
//     who could have typed `npm test` in that directory themselves.
//   * The `command` recorded in the ledger names the script, not its content,
//     and the `tail` is whatever that script printed. Both are untrusted.
//
// The trust check on `wmux.json` is therefore about which of two GATES the
// project picked, never about whether the code being graded is safe to run.
//
// ── LINT FROM A BASE REF: ONLY WHAT THE TASK CHANGED ───────────────────────
//
// With a base ref, a base `lint` script that is a plain eslint run (`eslint`,
// an `--ext` list and directories, nothing else, and no prelint/postlint) is
// not run whole. A repository whose default branch already fails its own
// lint (wmux's does: its CI lints a few named files, never `npm run lint`)
// would fail every task on errors no task made. Instead the base's eslint
// runs on the files the task changed (`git diff` from the newest of the
// dispatch base and `merge-base <ref> HEAD` that HEAD contains, to the
// working tree, untracked files included), and on each file with errors the
// base's version of it is linted too (`--stdin`). The step fails on an error
// the file has that its base version did not (matched by rule and message,
// not by line, so moved code is not new), and the result names them. With a
// file removed, `import/` errors are never matched (the base text is linted
// among HEAD's files). An eslint that does not answer with a JSON report on
// the files it was given, agreeing with its exit code (exit 2, a crash, no
// output), fails the step: that is not a lint pass.
//
// `node_modules` missing (or a symlink, which is how worktrees in this repo get
// a false `npm test` failure) is reported as `skipped: 'deps_missing'`, never as
// a failing gate: "the gate did not run" and "the code is broken" are different
// facts and a brain that cannot tell them apart will close a healthy task as
// failed. One exception: a project whose package.json declares no dependencies
// of any kind has nothing to install — `npm ci` refuses without a lockfile and
// `npm install` creates no node_modules — so a missing node_modules there is
// the installed state and the gate runs (see nothingToInstall). A symlink is
// always a skip.
//
// NO GATE IS NOT A FAILED GATE. A project that declares neither a verify script
// nor npm lint/test scripts has nothing to fail, but the ledger refuses
// `completed` without a system-recorded pass — so such a repository could never
// reach `completed` except by `force`, which is how a live brain got stuck. The
// `no_gate_command` skip therefore RECORDS a system gate (`exitCode: 0`,
// `command: 'none'`, `skipped: 'no_gate_command'`, the detail text as its tail):
// the verdict is honest about having run nothing, and `completed` is reachable.
// `deps_missing` and `gate_unavailable` stay unrecorded — there a gate existed
// and the environment stopped it, which is exactly the case a human should see.
//
// ── WHO GETS TO SAY THERE IS NO GATE ────────────────────────────────────────
//
// Not the task worktree. That tree is what the WORKER has been editing, so
// deciding "no gate exists" from its own package.json would let a worker delete
// its `lint` and `test` scripts and be handed a system-signed passing verdict
// for it — a forged pass, in the one record `completed` trusts. So the waiver
// needs the PARENT repository's agreement: when the parent root declares npm
// lint/test scripts and the worktree does not, the worktree dropped them, and
// that is a FAILING gate (`exitCode: 1`, `command: 'none'`, a tail that names
// the missing scripts), never a waiver. Only when the parent declares no gate
// either is `no_gate_command` recorded. The verify-script branch was already
// parent-anchored: `wmux.json` is read at `projectRoot`, and a project that
// declares `verify` while the worktree lacks the file is refused, not waived.
//
// A package.json that EXISTS but cannot be read or parsed is a third thing
// again: neither "no gate" nor "a gate that failed", but a gate whose existence
// is unknown. That answers `gate_unavailable` (unrecorded) rather than guessing.
//
// ── GATE FROM A BASE REF (opt-in) ───────────────────────────────────────────
//
// A caller may name a base ref (`gateBaseRef`, e.g. the PR's base branch). The
// gate is then chosen from that ref, not from the worktree: package.json's
// lint/test scripts are read with `git show <ref>:package.json`, and the
// worktree must declare exactly the same ones and carry the ref's `.npmrc`
// (npm reads it when it runs them); a declared verify script must be the same
// blob at the ref as in the worktree. Any difference is a refusal, so the
// steps that run are the base's own. Which gate a trusted wmux.json
// picks is still read at the parent root, as above. Off by default.
//
// ── THE HEAD A GATE RAN ON ──────────────────────────────────────────────────
//
// The worktree's HEAD is read before the gate and again before the result is
// recorded, each time only if the tree is clean (no tracked change, no
// untracked file outside .gitignore); the result carries `headSha` only when
// both reads agree, so a recorded gate names the commit it graded or none.
//
// Ledger writes go through LedgerPort (see ledgerPort.ts) as a `system` actor —
// the daemon ran the gate, not the worker whose code it graded — and a ledger
// that is unreachable does not fail the gate: the run happened, only its receipt
// is missing, and the result is returned to the caller either way.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { getExecEnv } from '../../shared/execEnv';
import { getWmuxHomeDir } from '../../shared/constants';
import { LEDGER_GATE_TAIL_MAX_BYTES, type LedgerGateResult } from '../../shared/ledger';
import { runWorkerGitRead as git } from './workerGit';
import { DubiousOwnershipError, dubiousOwnership, dubiousOwnershipMessage } from '../git/dubiousOwnership';
import type { LedgerPort } from './ledgerPort';

/** 15 minutes. A gate is a lint+test run, not a build farm; past this the
 *  process group is killed and the result is a signal death (exitCode null),
 *  which the ledger contract already defines as a failure. */
export const GATE_TIMEOUT_MS = 15 * 60 * 1000;

/** How many trailing lines of combined output the verdict carries. Bounded
 *  again in BYTES by LEDGER_GATE_TAIL_MAX_BYTES — 40 lines of minified output
 *  can be megabytes. */
export const GATE_TAIL_LINES = 40;

/** Gates that run at once across every task. A gate is a lint + typecheck +
 *  test run, the heaviest thing wmux starts by itself; several at once on one
 *  machine swap it to a standstill. Later gates (and fan-out setup hooks, see
 *  withPermit) wait their turn, first come first served; a task's own gate is
 *  still one at a time (`busy`). */
export const GATE_MAX_CONCURRENT = 1;

/** The well-known `wmux.json` command id that opts a project into its own gate.
 *  Fixed on purpose: a project declares THAT it has a verify script, it does not
 *  get to say what runs. */
export const GATE_PROJECT_COMMAND_ID = 'verify';

/** Path, relative to the worktree root, of the only project-declared gate this
 *  runner will execute. */
export const GATE_VERIFY_SCRIPT = 'scripts/verify.sh';

/** The package.json scripts that make up the fallback gate, in run order. A
 *  worktree declaring neither has no npm gate — but a PARENT repository
 *  declaring either has a gate its worktree does not get to waive by deleting
 *  the script. */
export const GATE_NPM_SCRIPTS = ['lint', 'test'] as const;

/** The spellings of GATE_VERIFY_SCRIPT a wmux.json may use for its `verify`
 *  command. Compared literally; anything else is refused. */
const VERIFY_COMMAND_SPELLINGS: readonly string[] = [
  'scripts/verify.sh',
  './scripts/verify.sh',
  'bash scripts/verify.sh',
  'bash ./scripts/verify.sh',
  'sh scripts/verify.sh',
  'sh ./scripts/verify.sh',
];

/** One allow-listed step: a program plus a fixed argv. Never assembled from
 *  caller input, never passed through a shell. */
export interface GateStep {
  readonly argv: readonly string[];
  /** Human/ledger label — exactly the argv, joined. */
  readonly label: string;
  /** The base's lint script is this eslint run: lint only what the task
   *  changed (see LINT FROM A BASE REF). `argv` is then the eslint program;
   *  the runner adds fixed flags and the changed files after `--`. */
  readonly eslint?: EslintScript;
}

/** A plain eslint lint script: its `--ext` list and the directories it
 *  lints, normalized (`''` is the root). */
export interface EslintScript {
  readonly ext: readonly string[];
  readonly paths: readonly string[];
}

const npmBin = (): string => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

function step(argv: string[]): GateStep {
  return { argv, label: argv.join(' ') };
}

/** The eslint program in a worktree, run with node (no npm, no shell). */
function eslintArgv(worktreePath: string): string[] {
  return ['node', path.join(worktreePath, 'node_modules', 'eslint', 'bin', 'eslint.js')];
}

/** Every argv shape this runner may ever spawn, as a function of the worktree.
 *  Exported so a test can assert the set has not grown. The eslint program
 *  is followed by fixed flags and, after `--`, paths from `git diff`. */
export function allowedGateArgv(worktreePath: string): readonly (readonly string[])[] {
  return [
    ['bash', path.join(worktreePath, GATE_VERIFY_SCRIPT)],
    [npmBin(), 'run', 'lint'],
    [npmBin(), 'test'],
    eslintArgv(worktreePath),
  ];
}

/**
 * `script` as an EslintScript when it is exactly `eslint`, an `--ext` list
 * and one or more paths (no other flag, no shell syntax); else null, and the
 * gate runs `npm run lint` whole. Pure.
 */
export function parseEslintScript(script: string | undefined): EslintScript | null {
  // Spaces only between words: a newline or a tab is shell syntax too.
  if (typeof script !== 'string' || !/^[A-Za-z0-9_.@/,= -]+$/.test(script)) return null;
  const words = script.trim().split(/ +/);
  if (words.shift() !== 'eslint') return null;
  let ext: string[] | null = null;
  const paths: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    let list: string | undefined;
    if (w === '--ext') list = words[++i];
    else if (w.startsWith('--ext=')) list = w.slice('--ext='.length);
    else if (/^[A-Za-z0-9_.@/-]+$/.test(w) && !w.startsWith('-')) {
      // A directory, as git spells paths: a named file is linted whatever
      // its extension, which the changed-file filter does not model.
      const dir = path.posix.normalize(w).replace(/\/+$/, '');
      const last = dir.split('/').pop() ?? '';
      if (dir.startsWith('..') || (last !== '.' && last.includes('.'))) return null;
      paths.push(dir === '.' ? '' : dir.replace(/^\.\//, ''));
      continue;
    } else return null;
    if (ext !== null || !list || !/^\.[A-Za-z0-9]+(,\.[A-Za-z0-9]+)*$/.test(list)) return null;
    ext = list.split(',');
  }
  return ext && paths.length > 0 ? { ext, paths } : null;
}

/** One eslint problem, as its JSON report gives it. */
export interface LintProblem {
  line: number;
  column: number;
  ruleId: string | null;
  message: string;
}

/** A file's errors (severity 2) in an eslint JSON report, keyed by the path
 *  relative to the first of `roots` it is under, with `/`; null when the
 *  text is not such a report. */
export function parseEslintReport(text: string, roots: readonly string[]): Map<string, LintProblem[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = new Map<string, LintProblem[]>();
  for (const r of parsed as unknown[]) {
    const f = r as { filePath?: unknown; messages?: unknown };
    if (!f || typeof f.filePath !== 'string' || !Array.isArray(f.messages)) return null;
    const rel = relativeTo(f.filePath, roots);
    const errors: LintProblem[] = out.get(rel) ?? [];
    for (const m of f.messages as Array<Record<string, unknown>>) {
      if (!m || typeof m !== 'object' || typeof m['severity'] !== 'number' || typeof m['message'] !== 'string') return null;
      if (m['severity'] !== 2) continue;
      errors.push({
        line: typeof m['line'] === 'number' ? m['line'] : 0,
        column: typeof m['column'] === 'number' ? m['column'] : 0,
        ruleId: typeof m['ruleId'] === 'string' ? m['ruleId'] : null,
        message: typeof m['message'] === 'string' ? m['message'] : '',
      });
    }
    out.set(rel, errors);
  }
  return out;
}

function relativeTo(filePath: string, roots: readonly string[]): string {
  for (const root of roots) {
    const rel = path.relative(root, filePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return filePath.split(path.sep).join('/');
}

/**
 * The errors `head` has that `base` (the same file at the base, null when
 * the task added it) does not: matched by rule and message, one for one, so
 * an error that only moved is not new. Pure.
 */
export function newLintProblems(head: readonly LintProblem[], base: readonly LintProblem[] | null): LintProblem[] {
  const left = new Map<string, number>();
  for (const p of base ?? []) {
    const k = `${p.ruleId ?? ''}\u0000${p.message}`;
    left.set(k, (left.get(k) ?? 0) + 1);
  }
  const added: LintProblem[] = [];
  for (const p of head) {
    const k = `${p.ruleId ?? ''}\u0000${p.message}`;
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else added.push(p);
  }
  return added;
}

/** One line naming a lint error, for the tail and the card: control
 *  characters and backticks dropped, bounded. */
export function lintErrorLine(file: string, p: LintProblem): string {
  // eslint-disable-next-line no-control-regex
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f`]/g, ' ');
  return clean(`${file}:${p.line}:${p.column} ${p.ruleId ?? 'parse error'}: ${p.message}`).slice(0, 240);
}

/** What a gate card adds for a failed eslint step: the errors the task
 *  added, one per line; '' when there are none. */
export function newLintErrorsText(errors: readonly string[] | undefined): string {
  if (!errors || errors.length === 0) return '';
  return `\n\nLint errors this task adds (pre-existing ones in the repository do not count):\n${errors.map((l) => `- ${l}`).join('\n')}`;
}

/** A file the task changed: its path at HEAD and at the base (a rename
 *  moved it; null when the task added it). */
export interface ChangedFile {
  path: string;
  basePath: string | null;
}

/** The changes eslint step reads: from `base`, the files there now, and
 *  whether the task removed a path (a deleted or renamed file). */
export interface ChangedFiles {
  base: string;
  files: ChangedFile[];
  removed?: boolean;
}

/** Changed files linted per eslint run (keeps argv short on Windows). */
export const GATE_LINT_BATCH = 100;
/** Files with errors whose base version is linted to tell old errors from
 *  new; past this many, each one's errors all count as new. */
export const GATE_LINT_BASE_MAX = 60;
/** Bytes of eslint JSON one run may print; past it the step fails. */
export const GATE_LINT_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
/** New errors the result names (the tail and the card). */
export const GATE_LINT_NAMED_MAX = 20;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// ── Injected seams ───────────────────────────────────────────────────────────

/**
 * How a gate step ended. `exited` carries the process's own exit code (`null`
 * when a signal killed it); `unavailable` means the process never started at
 * all — ENOENT, EACCES — which is a SKIP, not a failure.
 */
export type GateExit = { kind: 'exited'; code: number | null } | { kind: 'unavailable'; message: string };

/** A running child, reduced to what the runner needs. The default
 *  implementation wraps `child_process.spawn`; tests inject a fake. */
export interface GateProcess {
  /** Combined stdout+stderr, chunk by chunk. */
  onOutput(cb: (chunk: string) => void): void;
  /** stdout and stderr apart, instead of onOutput (the eslint step reads its
   *  JSON report from stdout). */
  onStdio?(out: (chunk: string) => void, err: (chunk: string) => void): void;
  /** How the step ended — see GateExit. */
  wait(): Promise<GateExit>;
  /** Kill the whole process group (a test runner spawns children of its own). */
  kill(): void;
}

/** `stdin`: written to the process and closed (else it reads nothing). */
export type GateSpawn = (cmd: string, args: readonly string[], opts: { cwd: string; stdin?: string }) => GateProcess;

/** How the runner runs one process of a step (run()'s own, shared by the
 *  eslint step's several processes). */
type GateExec = (
  argv: readonly string[],
  budgetMs: number,
  io?: { stdin?: string; stdout: (chunk: string) => void },
) => Promise<{ exit: GateExit; timedOut: boolean }>;

/** The `wmux.json` facts the runner needs: is it trusted, and does it declare
 *  the well-known verify command. Structurally satisfied by
 *  `ProjectConfigStore.getState`. */
export interface ProjectGatePort {
  getState(cwd: string): Promise<{
    trust?: string;
    config?: { commands?: { id: string; command: string }[] };
  }>;
}

export interface TaskGateRunnerOptions {
  ledger: LedgerPort;
  /** Absent = no project config consulted; the runner then uses npm only. */
  project?: ProjectGatePort;
  spawn?: GateSpawn;
  timeoutMs?: number;
  /** Gates that run at once (GATE_MAX_CONCURRENT); clamped to at least 1. */
  maxConcurrent?: number;
  now?: () => number;
  /** Injected for tests; defaults to reading `<root>/package.json`. `null` means
   *  the file is there and could not be read or parsed — see
   *  defaultReadPackageScripts. An absent package.json is `{}`. */
  readPackageScripts?: (root: string) => Record<string, string> | null;
  /** Injected for tests; defaults to an lstat of `<worktree>/node_modules`. */
  depsState?: (worktreePath: string) => 'ok' | 'missing' | 'symlink';
  /** Injected for tests; defaults to reading `<root>/package.json`. Null when
   *  there is none; throws when it is there and cannot be read. */
  readPackageJson?: (root: string) => string | null;
  /** Injected for tests; defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
  /** Injected for tests; defaults to `git rev-parse HEAD` in the worktree
   *  when `git status --porcelain` is empty. Null when it cannot be read or
   *  the tree has changes of its own. */
  readHead?: (worktreePath: string) => Promise<string | null>;
  /** Injected for tests; defaults to `git show <ref>:<file>` in the worktree.
   *  Null when the ref has no such file; throws when the ref cannot be read. */
  readBaseFile?: (worktreePath: string, ref: string, file: string) => Promise<string | null>;
  /** Injected for tests; defaults to comparing `git hash-object <file>` with
   *  the ref's blob. False when either side is missing or unreadable. */
  sameAsBase?: (worktreePath: string, ref: string, file: string) => Promise<boolean>;
  /** Injected for tests; defaults to git in the worktree: the base a task's
   *  changes are read from (the newest of `diffBase` and `merge-base <ref>
   *  HEAD` that HEAD contains) and the files changed from it in the working
   *  tree (untracked ones included). An error string when that cannot be
   *  read. */
  changedFiles?: (worktreePath: string, ref: string, diffBase?: string) => Promise<ChangedFiles | { error: string }>;
}

// ── Results ──────────────────────────────────────────────────────────────────

/** `no_changes` is never this runner's: the bot task gate (factory/taskGate.ts)
 *  answers it without running anything, for a task with no commits beyond
 *  its base. */
export type GateSkipReason = 'deps_missing' | 'no_gate_command' | 'gate_unavailable' | 'no_changes';

export type GateRunResult =
  /** The gate ran to a verdict. `result.exitCode === 0` is the only pass.
   *  `newLintErrors`: the errors the task added, when the eslint step failed
   *  on them (lintErrorLine each, at most GATE_LINT_NAMED_MAX). */
  | { ok: true; status: 'completed'; taskId: string; result: LedgerGateResult; recorded: boolean; newLintErrors?: string[] }
  /** Nothing ran, and that is not a failure. `recorded` is present only for
   *  `no_gate_command`, the one skip that still writes a verdict (a passing
   *  system gate, so a project without a gate can reach `completed`); its
   *  absence on the other two says the ledger was deliberately left untouched. */
  | {
      ok: true;
      status: 'skipped';
      taskId: string;
      skipped: GateSkipReason;
      detail: string;
      recorded?: boolean;
    }
  /** A gate for this task is already running. */
  | { ok: false; status: 'busy'; taskId: string }
  /** The project declared a gate this runner will not execute. `code`
   *  `no_base_gate`: the base ref has none of the npm gate scripts the task
   *  worktree adds (a new repository), so there is no gate to run yet. */
  | { ok: false; status: 'refused'; taskId: string; error: string; code?: 'no_base_gate' };

export interface GateRunInput {
  taskId: string;
  worktreePath: string;
  /** The daemon's own workspace id — the gate is a `system` write. */
  systemWorkspaceId: string;
  /**
   * The PARENT repository root, for the wmux.json trust lookup.
   *
   * Trust records are keyed by the path the user approved, which is the repo
   * they opened — never a `wtask/…` worktree the daemon created minutes ago and
   * that no dialog has ever named. Looking the verdict up under the worktree
   * path therefore always answered `untrusted`, which made the entire
   * project-verify branch dead code. The config is READ from the parent root;
   * the script still RUNS in the worktree.
   *
   * Omitted (tests, an unresolvable parent) ⇒ the worktree path, i.e. the old
   * behaviour: no verdict, npm only.
   */
  projectRoot?: string;
  /** Choose the gate from this ref (e.g. `origin/main`) instead of the
   *  worktree; see GATE FROM A BASE REF above. Omitted = the worktree. */
  gateBaseRef?: string;
  /** The commit the task started from (main's dispatch record), for the
   *  eslint step's diff; used when HEAD contains it and it is newer than
   *  `merge-base <gateBaseRef> HEAD`. */
  diffBase?: string;
}

/** A ref this runner passes to git: a plain ref name, never an option. */
const BASE_REF_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

// ── Tail bounding ────────────────────────────────────────────────────────────

/**
 * Last GATE_TAIL_LINES lines, then bounded to LEDGER_GATE_TAIL_MAX_BYTES by
 * dropping from the FRONT — the end of a failing run is the part that says why.
 * The result is untrusted text (see the ledger constant): it is whatever the
 * gate printed, and the gate runs code a worker wrote.
 */
export function boundTail(raw: string): string {
  const lines = raw.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - GATE_TAIL_LINES)).join('\n');
  const buf = Buffer.from(tail, 'utf8');
  if (buf.byteLength <= LEDGER_GATE_TAIL_MAX_BYTES) return tail;
  let cut = buf.subarray(buf.byteLength - LEDGER_GATE_TAIL_MAX_BYTES).toString('utf8');
  // A front cut can land mid-codepoint; drop the replacement char rather than
  // start the tail with a corrupted character.
  if (cut.startsWith('�')) cut = cut.slice(1);
  return cut;
}

// ── Default seam implementations ─────────────────────────────────────────────

const defaultSpawn: GateSpawn = (cmd, args, opts) => {
  const child = nodeSpawn(cmd, [...args], {
    cwd: opts.cwd,
    env: getExecEnv(),
    windowsHide: true,
    // Own process group so a cancel/timeout kills the test runner's children
    // too, not just the npm wrapper that would otherwise be orphaned.
    detached: process.platform !== 'win32',
    // win32 only: `npm.cmd` is a batch file, and current Node refuses to spawn
    // one without a shell (EINVAL, the CVE-2024-27980 fix). The argv stays an
    // ARRAY — Node quotes each element for cmd.exe — and every element here is
    // a constant from allowedGateArgv() plus a server-derived path, so there is
    // still no caller string being interpolated into a command line. Only a
    // batch file gets a shell: the eslint step passes paths from `git diff`,
    // which must never reach cmd.exe.
    ...(process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd) ? { shell: true } : {}),
    stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (opts.stdin !== undefined) {
    // A child that exits before reading all of it is not an error here.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.stdin);
  }
  return {
    onOutput(cb) {
      child.stdout?.on('data', (d: Buffer) => cb(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => cb(d.toString('utf8')));
    },
    onStdio(out, err) {
      child.stdout?.on('data', (d: Buffer) => out(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => err(d.toString('utf8')));
    },
    wait() {
      return new Promise<GateExit>((resolve) => {
        // An `error` event is the process never having RUN — npm not on PATH,
        // the script not executable. That is not a failing gate, and reporting
        // it as one (exitCode null) had a brain mark a healthy task failed
        // because the daemon's PATH was short.
        child.once('error', (err: NodeJS.ErrnoException) =>
          resolve({ kind: 'unavailable', message: err.message }),
        );
        child.once('close', (code: number | null) => resolve({ kind: 'exited', code }));
      });
    },
    kill() {
      try {
        if (process.platform !== 'win32' && typeof child.pid === 'number') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Already gone.
      }
    },
  };
};

async function defaultReadHead(worktreePath: string): Promise<string | null> {
  const [r, status] = await Promise.all([
    git(['rev-parse', 'HEAD'], worktreePath),
    git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all'], worktreePath),
  ]);
  const sha = r.stdout.trim();
  // A tree with changes of its own is not the commit: name none.
  if (status.code !== 0 || status.stdout.trim() !== '') return null;
  return r.code === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
}

/** wmux's task worktree root when `worktreePath` is under it, else undefined. */
function taskFolderRootOf(worktreePath: string): string | undefined {
  const root = path.join(getWmuxHomeDir(), 'worktrees');
  const rel = path.relative(root, path.resolve(worktreePath));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? root : undefined;
}

async function defaultReadBaseFile(worktreePath: string, ref: string, file: string): Promise<string | null> {
  const commit = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], worktreePath);
  if (commit.code !== 0) {
    // A worktree whose gitdir another user owns (a repository inside WSL, for
    // Git for Windows): say so, with the command, not "cannot be read".
    const untrusted = dubiousOwnership(commit.stderr, worktreePath);
    if (untrusted) throw new DubiousOwnershipError(dubiousOwnershipMessage(worktreePath, untrusted.command, taskFolderRootOf(worktreePath)));
    throw new Error(`the base ref ${ref} cannot be read`);
  }
  const exists = await git(['cat-file', '-e', `${ref}:${file}`], worktreePath);
  if (exists.code !== 0) return null;
  const r = await git(['show', `${ref}:${file}`], worktreePath);
  if (r.code !== 0) throw new Error(`${ref}:${file} cannot be read`);
  return r.stdout;
}

async function defaultSameAsBase(worktreePath: string, ref: string, file: string): Promise<boolean> {
  // Blob ids, not bytes: hash-object applies the same clean filters (line
  // endings) the ref's blob went through.
  const [base, here] = await Promise.all([
    git(['rev-parse', '--verify', '--quiet', `${ref}:${file}`], worktreePath),
    git(['hash-object', '--', file], worktreePath),
  ]);
  return base.code === 0 && here.code === 0 && base.stdout.trim() !== '' && base.stdout.trim() === here.stdout.trim();
}

/** The paths in `git diff --name-status -z` output: the files there now
 *  (added, copied, modified, renamed, type changed) and whether any path was
 *  removed (deleted, or renamed away); null when it is not that. Pure. */
export function parseNameStatus(raw: string): { files: ChangedFile[]; removed: boolean } | null {
  const parts = raw.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  const files: ChangedFile[] = [];
  let removed = false;
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i] as string;
    if (/^[AMTD]$/.test(status)) {
      const p = parts[++i];
      if (!p) return null;
      if (status === 'D') removed = true;
      else files.push({ path: p, basePath: status === 'A' ? null : p });
    } else if (/^[RC]\d*$/.test(status)) {
      const from = parts[++i];
      const to = parts[++i];
      if (!from || !to) return null;
      if (status.startsWith('R')) removed = true;
      files.push({ path: to, basePath: from });
    } else {
      return null;
    }
  }
  return { files, removed };
}

async function defaultChangedFiles(worktreePath: string, ref: string, diffBase?: string): Promise<ChangedFiles | { error: string }> {
  const mb = await git(['merge-base', ref, 'HEAD'], worktreePath);
  let base = mb.stdout.trim();
  if (mb.code !== 0 || !SHA_RE.test(base)) return { error: `the commit the task started from could not be read (git merge-base ${ref} HEAD)` };
  // The dispatch base, when HEAD holds it and it is newer than the merge-base
  // (a task started from a commit origin does not have yet). A task that
  // merged or rebased onto a newer base keeps the merge-base: the default
  // branch's own changes since are not the task's.
  if (diffBase && SHA_RE.test(diffBase) && diffBase !== base) {
    const [newer, held] = await Promise.all([
      git(['merge-base', '--is-ancestor', base, diffBase], worktreePath),
      git(['merge-base', '--is-ancestor', diffBase, 'HEAD'], worktreePath),
    ]);
    if (newer.code === 0 && held.code === 0) base = diffBase;
  }
  // To the working tree, not HEAD (eslint reads the files on disk), and the
  // untracked files outside .gitignore, which the whole lint reads too.
  const [d, others] = await Promise.all([
    git(['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '-M', base, '--'], worktreePath),
    git(['ls-files', '-z', '--others', '--exclude-standard'], worktreePath),
  ]);
  const parsed = d.code === 0 && others.code === 0 ? parseNameStatus(d.stdout) : null;
  if (!parsed) return { error: `the files the task changed since ${base} could not be read` };
  const known = new Set(parsed.files.map((f) => f.path));
  for (const p of others.stdout.split('\0')) if (p && !known.has(p)) parsed.files.push({ path: p, basePath: null });
  return { base, ...parsed };
}

/** package.json text → its string scripts; null when it is not JSON. */
function scriptsOf(raw: string): Record<string, string> | null {
  let parsed: { scripts?: Record<string, unknown> } | null;
  try {
    parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> } | null;
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed?.scripts ?? {})) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/**
 * Whether package.json text declares nothing to install: every dependency
 * field absent or an empty object, and no `workspaces` (whose packages may
 * declare their own). Only a package.json that says so counts: none at all
 * (null), text that is not JSON, or a field of any other shape answers
 * false — the gate then waits for node_modules as before.
 */
export function declaresNoDependencies(raw: string | null): boolean {
  if (raw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const pkg = parsed as Record<string, unknown>;
  if (pkg['workspaces'] !== undefined) return false;
  return DEPENDENCY_FIELDS.every((f) => {
    const v = pkg[f];
    if (v === undefined) return true;
    return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
  });
}

function defaultReadPackageJson(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function defaultDepsState(worktreePath: string): 'ok' | 'missing' | 'symlink' {
  try {
    const st = fs.lstatSync(path.join(worktreePath, 'node_modules'));
    return st.isSymbolicLink() ? 'symlink' : 'ok';
  } catch {
    return 'missing';
  }
}

/**
 * `<root>/package.json`'s scripts, or `null` when the file is there and this
 * process cannot make sense of it.
 *
 * The distinction is the whole point: one `catch {} → {}` used to fold three
 * unrelated facts together. "There is no package.json" is a legitimate no-gate
 * (a repository that is not a Node project). "There is one and it is
 * unreadable" (EACCES, EISDIR, an I/O error) or "there is one and it is not
 * JSON" is NOT evidence that no gate exists — treating it as such waives the
 * gate for a corrupt tree, and the waiver writes a passing system record.
 */
function defaultReadPackageScripts(root: string): Record<string, string> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
  }
  return scriptsOf(raw);
}

/** Whether eslint step `s` lints `file` (a path from git, `/`-separated):
 *  one of its extensions, under one of its paths (`''`: the root). */
function lintable(file: string, s: EslintScript): boolean {
  if (!s.ext.includes(path.posix.extname(file))) return false;
  return s.paths.some((dir) => dir === '' || file === dir || file.startsWith(`${dir}/`));
}

/** What a `deps_missing` skip for a linked node_modules tells the owner to do. */
function linkedDepsDetail(worktreePath: string): string {
  let target = '';
  try {
    // The link's own text (a worker wrote it): bounded, no control characters.
    // eslint-disable-next-line no-control-regex
    target = fs.readlinkSync(path.join(worktreePath, 'node_modules')).replace(/[\u0000-\u001f\u007f`]/g, ' ').slice(0, 200);
  } catch {
    target = '';
  }
  return `node_modules in the task worktree is a symbolic link${target ? ` (to ${target})` : ''}, and the gate does not run on a linked install: `
    + 'one shared from another checkout is not what this task\'s package-lock.json installs, so tests that read installed files fail for reasons that are not the task\'s. '
    + `To run the gate: in ${worktreePath}, remove the link (only the link, not the folder it points to) and run npm ci `
    + '(if it fails with ENOSPC, free disk space first), then send the task back so its worker reports again.';
}

// ── The runner ───────────────────────────────────────────────────────────────

interface ActiveGate {
  cancel: () => void;
}

/** A place in the line for a gate permit. */
interface GatePermit {
  /** Resolves when the permit is granted. */
  granted: Promise<void>;
  isGranted: () => boolean;
}

export class TaskGateRunner {
  private readonly ledger: LedgerPort;
  private readonly project: ProjectGatePort | undefined;
  private readonly spawn: GateSpawn;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly readPackageScripts: (root: string) => Record<string, string> | null;
  private readonly depsState: (worktreePath: string) => 'ok' | 'missing' | 'symlink';
  private readonly readPackageJson: (root: string) => string | null;
  private readonly fileExists: (p: string) => boolean;
  private readonly readHead: (worktreePath: string) => Promise<string | null>;
  private readonly readBaseFile: (worktreePath: string, ref: string, file: string) => Promise<string | null>;
  private readonly sameAsBase: (worktreePath: string, ref: string, file: string) => Promise<boolean>;
  private readonly changedFiles: NonNullable<TaskGateRunnerOptions['changedFiles']>;
  /** One gate per task — the second concurrent call is `busy`, not a second
   *  npm install fighting the first over the same node_modules. */
  private readonly active = new Map<string, ActiveGate>();
  private readonly maxConcurrent: number;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(opts: TaskGateRunnerOptions) {
    this.ledger = opts.ledger;
    this.project = opts.project;
    this.spawn = opts.spawn ?? defaultSpawn;
    // Clamped, never disabled. A `0` (or a negative) used to mean "no timer",
    // which is indistinguishable from "hangs forever holding this task's gate
    // slot" — and the slot is exclusive, so one wedged gate would make every
    // later run on that task answer `busy` until the daemon restarts. Tests
    // that want a short deadline pass a small positive number.
    this.timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : GATE_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.maxConcurrent = typeof opts.maxConcurrent === 'number' && opts.maxConcurrent >= 1 ? Math.floor(opts.maxConcurrent) : GATE_MAX_CONCURRENT;
    this.readPackageScripts = opts.readPackageScripts ?? defaultReadPackageScripts;
    this.depsState = opts.depsState ?? defaultDepsState;
    this.readPackageJson = opts.readPackageJson ?? defaultReadPackageJson;
    this.fileExists = opts.fileExists ?? ((p) => fs.existsSync(p));
    this.readHead = opts.readHead ?? defaultReadHead;
    this.readBaseFile = opts.readBaseFile ?? defaultReadBaseFile;
    this.sameAsBase = opts.sameAsBase ?? defaultSameAsBase;
    this.changedFiles = opts.changedFiles ?? defaultChangedFiles;
  }

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /** Kill a running gate's process group. Returns false when nothing was
   *  running — cancelling twice is not an error. */
  cancel(taskId: string): boolean {
    const gate = this.active.get(taskId);
    if (!gate) return false;
    gate.cancel();
    return true;
  }

  /**
   * Resolve the steps for a worktree. Exported behaviour, tested directly:
   * a trusted project declaring the well-known id wins; anything else it
   * declares under that id is a refusal; otherwise npm, filtered by the scripts
   * package.json actually has. With `baseRef`, the steps come from that ref
   * and the worktree must agree with it (see GATE FROM A BASE REF).
   */
  async resolveSteps(
    worktreePath: string,
    configRoot: string = worktreePath,
    baseRef?: string,
  ): Promise<{ steps: GateStep[] } | { refused: string; code?: 'no_base_gate' } | { unavailable: string }> {
    if (baseRef !== undefined && !BASE_REF_RE.test(baseRef)) {
      return { refused: `'${baseRef.slice(0, 80)}' is not a ref name the gate runner reads` };
    }
    // The verdict is read at the PARENT root (that is where the user approved a
    // wmux.json); the script runs in the worktree.
    const declared = await this.declaredVerifyCommand(configRoot);
    if (declared !== null) {
      if (!VERIFY_COMMAND_SPELLINGS.includes(declared)) {
        return {
          refused:
            `this project's wmux.json declares '${GATE_PROJECT_COMMAND_ID}' as a command the gate runner will not execute; ` +
            `the gate runs ${GATE_VERIFY_SCRIPT} or npm run lint + npm test, never an arbitrary command`,
        };
      }
      const scriptPath = path.join(worktreePath, GATE_VERIFY_SCRIPT);
      if (this.fileExists(scriptPath)) {
        if (baseRef !== undefined && !(await this.sameAsBase(worktreePath, baseRef, GATE_VERIFY_SCRIPT).catch(() => false))) {
          return { refused: `${GATE_VERIFY_SCRIPT} in the task worktree is not the one on ${baseRef}; the gate runs the base's own script` };
        }
        return { steps: [step(['bash', scriptPath])] };
      }
      // Declared and trusted, but this worktree does not have the file. Falling
      // through to npm would grade the task by a gate the project did not
      // choose, so say so instead.
      return {
        refused: `this project declares ${GATE_VERIFY_SCRIPT} as its gate, but that file is not in the task worktree`,
      };
    }

    let scripts = this.readPackageScripts(worktreePath);
    if (scripts === null) {
      return {
        unavailable: `the package.json in ${worktreePath} could not be read or parsed, so whether this project has a gate is unknown`,
      };
    }
    if (baseRef !== undefined) {
      let raw: string | null;
      try {
        raw = await this.readBaseFile(worktreePath, baseRef, 'package.json');
      } catch (err) {
        // Git refusing the folder over ownership is the whole story: it leads.
        if (err instanceof DubiousOwnershipError) return { unavailable: err.message };
        return { unavailable: `package.json on ${baseRef} could not be read (${err instanceof Error ? err.message : String(err)})` };
      }
      const base = raw === null ? {} : scriptsOf(raw);
      if (base === null) return { unavailable: `package.json on ${baseRef} could not be parsed, so whether this project has a gate is unknown` };
      const differs = GATE_NPM_SCRIPTS.filter((s) => base[s] !== scripts?.[s]);
      // The base has none of the scripts the worktree differs on: the task
      // adds the gate itself (a repository with no test script yet). Still
      // refused: the worktree's own script is never what grades the task.
      if (differs.length > 0 && differs.every((s) => typeof base[s] !== 'string')) {
        return {
          refused: `${baseRef} has no npm ${differs.join(' or ')} script yet and the task worktree adds ${differs.length > 1 ? 'them' : 'one'}; `
            + `the gate runs only the scripts already on ${baseRef} (a task never brings the check that grades it), so there is no gate to run on this task`,
          code: 'no_base_gate',
        };
      }
      if (differs.length > 0) {
        return { refused: `the task worktree's npm ${differs.join(' and ')} ${differs.length > 1 ? 'scripts differ' : 'script differs'} from ${baseRef}'s; the gate runs the base's own` };
      }
      if (GATE_NPM_SCRIPTS.some((s) => typeof base[s] === 'string')) {
        let npmrc: string | null;
        try {
          npmrc = await this.readBaseFile(worktreePath, baseRef, '.npmrc');
        } catch (err) {
          if (err instanceof DubiousOwnershipError) return { unavailable: err.message };
          return { unavailable: `.npmrc on ${baseRef} could not be read (${err instanceof Error ? err.message : String(err)})` };
        }
        const here = this.fileExists(path.join(worktreePath, '.npmrc'));
        const same = npmrc === null ? !here : here && (await this.sameAsBase(worktreePath, baseRef, '.npmrc').catch(() => false));
        if (!same) return { refused: `.npmrc in the task worktree is not the one on ${baseRef}; npm reads it when it runs the gate` };
      }
      scripts = base;
    }
    const steps: GateStep[] = [];
    // From a base ref, a plain eslint script lints only what the task changed.
    // `npm run lint` also runs a prelint or postlint script: not a plain eslint run.
    const hooked = typeof scripts['prelint'] === 'string' || typeof scripts['postlint'] === 'string';
    const eslint = baseRef !== undefined && !hooked ? parseEslintScript(scripts['lint']) : null;
    if (eslint) steps.push({ argv: eslintArgv(worktreePath), label: 'eslint on the files the task changed', eslint });
    else if (typeof scripts['lint'] === 'string') steps.push(step([npmBin(), 'run', 'lint']));
    if (typeof scripts['test'] === 'string') steps.push(step([npmBin(), 'test']));
    return { steps };
  }

  /** The trusted project's `verify` command string, or null when there is none
   *  (no config, not trusted, or no such command). */
  private async declaredVerifyCommand(configRoot: string): Promise<string | null> {
    if (!this.project) return null;
    let state: { trust?: string; config?: { commands?: { id: string; command: string }[] } };
    try {
      state = await this.project.getState(configRoot);
    } catch {
      return null;
    }
    // 'untrusted' / 'stale' / 'denied' all mean the user has not approved THESE
    // bytes, and an unapproved wmux.json chooses nothing.
    if (state?.trust !== 'trusted') return null;
    const cmd = (state.config?.commands ?? []).find((c) => c.id === GATE_PROJECT_COMMAND_ID);
    return cmd ? cmd.command.trim() : null;
  }

  /** Join the line for a permit (granted at once when one is free). */
  private takePermit(): GatePermit & { leave: () => void } {
    let granted = false;
    let left = false;
    let grant: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      grant = () => {
        granted = true;
        this.running++;
        resolve();
      };
    });
    if (this.running < this.maxConcurrent) grant();
    else this.waiting.push(grant);
    return {
      granted: promise,
      isGranted: () => granted && !left,
      // Leaving the line: a granted permit is handed on, a waiting one is
      // dropped. Once only: a second call does nothing.
      leave: () => {
        if (left) return;
        left = true;
        if (granted) {
          this.running--;
          this.waiting.shift()?.();
          return;
        }
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
      },
    };
  }

  /** Run other heavy work (a fan-out worktree's setup hook: `npm ci`) under
   *  the same permit, so it never overlaps a gate. Waits its turn first. */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const permit = this.takePermit();
    await permit.granted;
    try {
      return await fn();
    } finally {
      permit.leave();
    }
  }

  /** Gates running and waiting for a permit now. */
  load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  async run(input: GateRunInput): Promise<GateRunResult> {
    const { taskId, worktreePath } = input;

    // ── Claim the slot in the SAME TICK the check happens ────────────────
    // The check used to sit before two awaits (depsState, resolveSteps) and the
    // claim after them, so two concurrent runs both saw an empty map, both
    // spawned, the second overwrote the first's cancel closure — leaving one
    // gate uncancellable — and the first to finish deleted the OTHER one's
    // entry, after which a third call started a third npm on the same
    // node_modules. A placeholder token closes that window: it is inserted
    // synchronously, removed on every early-return path, and `finally` deletes
    // it only if the entry is still the token this call inserted.
    if (this.active.has(taskId)) return { ok: false, status: 'busy', taskId };
    let cancelled = false;
    let current: GateProcess | null = null;
    let stopWaiting: () => void = () => undefined;
    const cancelSignal = new Promise<void>((resolve) => { stopWaiting = resolve; });
    const token: ActiveGate = {
      cancel: (): void => {
        cancelled = true;
        current?.kill();
        stopWaiting();
      },
    };
    this.active.set(taskId, token);
    const permit = this.takePermit();
    let waitedMs: number | null = null;
    const release = (): void => {
      if (permit.isGranted()) permit.leave();
      if (this.active.get(taskId) === token) this.active.delete(taskId);
    };

    try {
      // WHICH steps first, THEN whether the environment can run them. The other
      // order asked `node_modules` about a repository that may not be a Node
      // project at all: a task in a Go or Rust checkout has no node_modules, so
      // every gate answered `deps_missing` — unrecorded — and the task could
      // never reach `completed`. That is the exact blockage the no-gate record
      // exists to remove, reintroduced one step earlier.
      //
      // The machine-wide permit comes before all of it: what is checked (the
      // steps, the base's scripts, the HEAD a verdict pins) and what runs are
      // the same tree, never one read before a wait and run after it. The
      // step timeout starts after the wait.
      const waitedFrom = this.now();
      if (!permit.isGranted()) {
        await Promise.race([permit.granted, cancelSignal]);
        waitedMs = this.now() - waitedFrom;
      }
      if (!permit.isGranted()) permit.leave();
      const before = await this.readHead(worktreePath).catch(() => null);
      const resolved = await this.resolveSteps(worktreePath, input.projectRoot ?? worktreePath, input.gateBaseRef);
      if ('refused' in resolved) return { ok: false, status: 'refused', taskId, error: resolved.refused, ...(resolved.code ? { code: resolved.code } : {}) };
      if ('unavailable' in resolved) {
        return { ok: true, status: 'skipped', taskId, skipped: 'gate_unavailable', detail: resolved.unavailable };
      }
      if (resolved.steps.length === 0) return this.noGateVerdict(input, before);

      const deps = this.depsState(worktreePath);
      if (deps !== 'ok' && !(deps === 'missing' && (await this.nothingToInstall(worktreePath, input.gateBaseRef)))) {
        return {
          ok: true,
          status: 'skipped',
          taskId,
          skipped: 'deps_missing',
          detail:
            deps === 'missing'
              ? 'node_modules is missing in the task worktree — run npm ci there, then re-run the gate'
              : linkedDepsDetail(worktreePath),
        };
      }

      let output = '';
      const append = (chunk: string): void => {
        output += chunk;
        // Keep the in-memory buffer bounded: a runaway test can print gigabytes
        // and only the tail ever reaches the ledger.
        const cap = LEDGER_GATE_TAIL_MAX_BYTES * 4;
        if (output.length > cap) output = output.slice(output.length - cap);
      };

      let exitCode: number | null = 0;
      let label = resolved.steps[resolved.steps.length - 1]?.label ?? '';
      let newLintErrors: string[] | undefined;

      if (waitedMs !== null) append(`[gate] waited ${Math.round(waitedMs / 1000)}s for another gate to finish\n`);

      /** Run one process to its end, killed after `budgetMs`. With `stdout`,
       *  its stdout goes there and only stderr to the tail. */
      const exec: GateExec = async (argv, budgetMs, io) => {
        const [cmd, ...args] = argv;
        const proc = this.spawn(cmd as string, args, { cwd: worktreePath, ...(io?.stdin !== undefined ? { stdin: io.stdin } : {}) });
        current = proc;
        if (!io) proc.onOutput(append);
        else if (proc.onStdio) proc.onStdio(io.stdout, append);
        else proc.onOutput(io.stdout);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, Math.max(1, budgetMs));
        try {
          const exit = await proc.wait();
          return { exit, timedOut };
        } finally {
          clearTimeout(timer);
          current = null;
        }
      };

      for (const step of resolved.steps) {
        if (cancelled) {
          exitCode = null;
          label = step.label;
          break;
        }
        label = step.label;
        let exit: GateExit;
        let timedOut: boolean;
        if (step.eslint) {
          const lint = await this.lintChanged(step, step.eslint, input, exec, append, () => cancelled);
          if ('skip' in lint) return { ok: true, status: 'skipped', taskId, skipped: 'gate_unavailable', detail: lint.skip };
          ({ exit, timedOut, label } = lint);
          if (lint.named && lint.named.length > 0) newLintErrors = lint.named;
        } else {
          ({ exit, timedOut } = await exec(step.argv, this.timeoutMs));
        }

        // The process never ran (ENOENT: npm is not on the daemon's PATH;
        // EACCES: verify.sh is not executable). Nothing was graded, so this is
        // a SKIP — reporting it as exitCode null would have a brain close a
        // healthy task as failed because of the daemon's environment.
        if (exit.kind === 'unavailable') {
          return {
            ok: true,
            status: 'skipped',
            taskId,
            skipped: 'gate_unavailable',
            detail: `the gate command could not be started (${step.label}): ${exit.message}`,
          };
        }
        exitCode = exit.code;

        if (timedOut || cancelled) {
          // A killed gate reports `null` whatever the platform turned the signal
          // into — the ledger's rule is that only an explicit 0 passes.
          exitCode = null;
          append(
            timedOut
              ? `\n[gate] timed out after ${Math.round(this.timeoutMs / 1000)}s and was killed\n`
              : '\n[gate] cancelled\n',
          );
          break;
        }
        // First failure stops: `npm test` after a failing lint tells nobody
        // anything they did not already know.
        if (exitCode !== 0) break;
      }

      const headSha = await this.pinnedHead(worktreePath, before);
      const result: LedgerGateResult = {
        exitCode,
        tail: boundTail(output),
        at: this.now(),
        command: label,
        ...(headSha ? { headSha } : {}),
      };
      const recorded = await this.record(taskId, input.systemWorkspaceId, result);
      return { ok: true, status: 'completed', taskId, result, recorded, ...(newLintErrors && exitCode !== 0 ? { newLintErrors } : {}) };
    } finally {
      release();
    }
  }

  /**
   * Whether a missing node_modules is simply the installed state: no
   * package.json the gate runs under declares a dependency. Both are asked,
   * the way the steps are chosen — npm resolves modules from the worktree's
   * package.json where the steps run, and with a base ref the steps were the
   * base's own, so the base's package.json must agree too. Anything that
   * cannot be read answers false and the gate stays a `deps_missing` skip.
   */
  private async nothingToInstall(worktreePath: string, baseRef: string | undefined): Promise<boolean> {
    try {
      if (!declaresNoDependencies(this.readPackageJson(worktreePath))) return false;
      if (baseRef === undefined) return true;
      return declaresNoDependencies(await this.readBaseFile(worktreePath, baseRef, 'package.json'));
    } catch {
      return false;
    }
  }

  /**
   * The eslint step (see LINT FROM A BASE REF): eslint on the files changed
   * from the task's base to HEAD, then the base's version of each one with
   * errors, and a pass unless HEAD adds one. `skip` when the base or the
   * changed files cannot be read (the gate did not run). Bounded: the step's
   * processes share one timeout, at most GATE_LINT_BASE_MAX base versions
   * are linted, and each report is at most GATE_LINT_OUTPUT_MAX_BYTES.
   */
  private async lintChanged(
    s: GateStep,
    eslint: EslintScript,
    input: GateRunInput,
    exec: GateExec,
    append: (chunk: string) => void,
    cancelled: () => boolean,
  ): Promise<{ exit: GateExit; timedOut: boolean; label: string; named?: string[] } | { skip: string }> {
    const wt = input.worktreePath;
    const changed = await this.changedFiles(wt, input.gateBaseRef ?? '', input.diffBase).catch((err: unknown) => ({ error: String(err) }));
    if ('error' in changed) return { skip: `${changed.error}, so there is nothing to lint the task's changes against` };
    const files = changed.files.filter((f) => lintable(f.path, eslint) && this.fileExists(path.join(wt, f.path)));
    const label = `eslint on ${files.length} file${files.length === 1 ? '' : 's'} changed since ${changed.base.slice(0, 12)}`;
    const killed = { exit: { kind: 'exited', code: null } as GateExit, timedOut: false, label };
    if (files.length === 0) {
      append(`[gate] ${label}: nothing to lint\n`);
      return { exit: { kind: 'exited', code: 0 }, timedOut: false, label };
    }
    const roots = [wt];
    try {
      roots.push(fs.realpathSync(wt));
    } catch {
      /* the path as given */
    }
    const deadline = Date.now() + this.timeoutMs;
    // The script's own --ext: it also picks which code blocks a processor
    // hands eslint.
    const flags = ['--ext', eslint.ext.join(','), '--format', 'json', '--quiet'];
    /** One eslint run's errors per file (each one of `expected`), or how it
     *  ended when it gave no such report. */
    const report = async (args: string[], expected: ReadonlySet<string>, stdin?: string): Promise<Map<string, LintProblem[]> | { exit: GateExit; timedOut: boolean; label: string }> => {
      const budget = deadline - Date.now();
      if (budget <= 0) return { ...killed, timedOut: true };
      if (cancelled()) return killed;
      const chunks: string[] = [];
      let bytes = 0;
      const r = await exec([...s.argv, ...flags, ...args], budget, {
        ...(stdin !== undefined ? { stdin } : {}),
        stdout: (c) => {
          if (bytes > GATE_LINT_OUTPUT_MAX_BYTES) return;
          bytes += Buffer.byteLength(c, 'utf8');
          if (bytes > GATE_LINT_OUTPUT_MAX_BYTES) chunks.length = 0;
          else chunks.push(c);
        },
      });
      if (r.exit.kind === 'unavailable' || r.timedOut || cancelled()) return { ...r, label };
      const over = bytes > GATE_LINT_OUTPUT_MAX_BYTES;
      // eslint exits 0 (no errors) or 1 (errors) with its report on exactly
      // the files it was given; anything else (2: a config or crash, a report
      // that disagrees with its exit code or names other files) is no lint
      // result, so the step fails.
      const code = r.exit.code;
      const parsed = !over && (code === 0 || code === 1) ? parseEslintReport(chunks.join(''), roots) : null;
      const errors = parsed ? [...parsed.values()].reduce((n, e) => n + e.length, 0) : 0;
      if (parsed && [...parsed.keys()].every((k) => expected.has(k)) && (errors > 0) === (code === 1)) return parsed;
      const why = over ? 'printed more than the gate reads' : code === 0 || code === 1 ? 'gave no report on the files it was given' : `exited ${String(code)}`;
      append(`\n[gate] eslint ${why}; the lint step fails\n`);
      return { exit: { kind: 'exited', code: code === 0 || code === 1 || code === null ? 2 : code }, timedOut: false, label };
    };

    const head = new Map<string, LintProblem[]>();
    for (let i = 0; i < files.length; i += GATE_LINT_BATCH) {
      const batch = files.slice(i, i + GATE_LINT_BATCH).map((f) => f.path);
      const r = await report(['--', ...batch], new Set(batch));
      if (!(r instanceof Map)) return r;
      for (const [file, errors] of r) head.set(file, [...(head.get(file) ?? []), ...errors]);
    }
    const added: string[] = [];
    let total = 0;
    let compared = 0;
    for (const f of files) {
      const errors = head.get(f.path) ?? [];
      if (errors.length === 0) continue;
      total += errors.length;
      let base: LintProblem[] | null = null;
      // Past the cap a file has no base to compare with: its errors all count.
      if (f.basePath && compared < GATE_LINT_BASE_MAX) {
        compared++;
        let text: string | null;
        try {
          text = await this.readBaseFile(wt, changed.base, f.basePath);
        } catch (err) {
          return { skip: `${f.basePath} at ${changed.base} could not be read (${err instanceof Error ? err.message : String(err)})` };
        }
        if (text !== null) {
          const r = await report(['--stdin', `--stdin-filename=${f.path}`], new Set([f.path]), text);
          if (!(r instanceof Map)) return r;
          base = r.get(f.path) ?? [];
          // The base text is linted among HEAD's files: with a file removed,
          // an import error there may be the task's, so none is old.
          if (changed.removed) base = base.filter((p) => !p.ruleId?.startsWith('import/'));
        }
      }
      for (const p of newLintProblems(errors, base)) added.push(lintErrorLine(f.path, p));
    }
    append(`[gate] ${label}: ${total} error${total === 1 ? '' : 's'} in them, ${added.length} new\n`);
    const named = added.slice(0, GATE_LINT_NAMED_MAX);
    for (const line of named) append(`  ${line}\n`);
    if (added.length > named.length) append(`  and ${added.length - named.length} more\n`);
    return { exit: { kind: 'exited', code: added.length > 0 ? 1 : 0 }, timedOut: false, label, named };
  }

  /**
   * The worktree resolved to zero steps. That is either a project with no gate
   * — recorded as a passing system verdict, because otherwise `completed` is
   * unreachable — or a worktree that DROPPED the gate its parent declares,
   * which is a failure and must never be recorded as a pass.
   *
   * The parent root is the daemon's own derivation of the repository the task
   * was fanned out from (`git rev-parse --show-toplevel` of the worktree's
   * git-common-dir), not anything the worker can write. When it is absent or is
   * the worktree itself, there is no second opinion to ask and the worktree
   * answers alone — that is the task-runs-in-the-main-checkout case, where the
   * two trees are the same tree.
   */
  private async noGateVerdict(input: GateRunInput, before: string | null): Promise<GateRunResult> {
    const { taskId, worktreePath } = input;
    const parentRoot = input.projectRoot ?? worktreePath;
    const headSha = await this.pinnedHead(worktreePath, before);
    const pinned = headSha ? { headSha } : {};
    if (path.resolve(parentRoot) !== path.resolve(worktreePath)) {
      const parentScripts = this.readPackageScripts(parentRoot);
      if (parentScripts === null) {
        return {
          ok: true,
          status: 'skipped',
          taskId,
          skipped: 'gate_unavailable',
          detail: `the package.json in ${parentRoot} could not be read or parsed, so whether this project has a gate is unknown`,
        };
      }
      const declared = GATE_NPM_SCRIPTS.filter((s) => typeof parentScripts[s] === 'string');
      if (declared.length > 0) {
        const detail =
          `the parent repository declares npm ${declared.join(' and ')} ` +
          `${declared.length > 1 ? 'scripts' : 'script'}, and the task worktree's package.json declares neither — ` +
          'the gate is missing from the tree it was supposed to grade, which is a failed gate and not a waiver';
        const result: LedgerGateResult = { exitCode: 1, tail: detail, at: this.now(), command: 'none', ...pinned };
        const recorded = await this.record(taskId, input.systemWorkspaceId, result);
        return { ok: true, status: 'completed', taskId, result, recorded };
      }
    }
    const detail =
      'this project declares no verify script and no npm lint/test scripts, so there is no gate to run';
    // Recorded, unlike the other two skips: nothing failed here, and an
    // unrecorded skip left `completed` unreachable without `force` for every
    // repository that declares no gate. The verdict says what it is —
    // `command: 'none'` and `skipped: 'no_gate_command'` — so nobody reads it as
    // a suite that passed.
    const recorded = await this.record(taskId, input.systemWorkspaceId, {
      exitCode: 0,
      tail: detail,
      at: this.now(),
      command: 'none',
      skipped: 'no_gate_command',
      ...pinned,
    });
    return { ok: true, status: 'skipped', taskId, skipped: 'no_gate_command', detail, recorded };
  }

  /** `before` when HEAD reads the same again now; else undefined (the gate
   *  graded no single commit, or HEAD could not be read). */
  private async pinnedHead(worktreePath: string, before: string | null): Promise<string | undefined> {
    if (!before) return undefined;
    const after = await this.readHead(worktreePath).catch(() => null);
    return after === before ? before : undefined;
  }

  /** Compare-and-swap write of the verdict. A ledger that is missing or
   *  unreachable is reported (`recorded: false`) and never turned into a gate
   *  failure — the gate ran; only its receipt is missing. */
  private async record(taskId: string, systemWorkspaceId: string, gate: LedgerGateResult): Promise<boolean> {
    const snapshot = await this.ledger.read(taskId);
    if (!snapshot) return false;
    const res = await this.ledger.writeGate({
      taskId,
      expectedRev: snapshot.rev,
      actor: { kind: 'system', workspaceId: systemWorkspaceId },
      gate,
    });
    if (res.ok) return true;
    if (res.reason !== 'conflict') return false;
    // One retry on a lost race: re-read and write against the revision that
    // won. A second conflict means the entry is genuinely contended and the
    // caller still gets the verdict in the response.
    const again = await this.ledger.read(taskId);
    if (!again) return false;
    const retry = await this.ledger.writeGate({
      taskId,
      expectedRev: again.rev,
      actor: { kind: 'system', workspaceId: systemWorkspaceId },
      gate,
    });
    return retry.ok;
  }
}

// The one runner main creates for the task pipe (index.ts), shared with the
// factory's verifier bot (factory/roles) so its gates and a task's gates take
// the same per-task slot (a second concurrent run is `busy`, never a second npm).
let shared: TaskGateRunner | null = null;

export function setSharedTaskGateRunner(r: TaskGateRunner | null): void {
  shared = r;
}

export function getSharedTaskGateRunner(): TaskGateRunner | null {
  return shared;
}
