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
// `node_modules` missing (or a symlink, which is how worktrees in this repo get
// a false `npm test` failure) is reported as `skipped: 'deps_missing'`, never as
// a failing gate: "the gate did not run" and "the code is broken" are different
// facts and a brain that cannot tell them apart will close a healthy task as
// failed.
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
// Ledger writes go through LedgerPort (see ledgerPort.ts) as a `system` actor —
// the daemon ran the gate, not the worker whose code it graded — and a ledger
// that is unreachable does not fail the gate: the run happened, only its receipt
// is missing, and the result is returned to the caller either way.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { getExecEnv } from '../../shared/execEnv';
import { LEDGER_GATE_TAIL_MAX_BYTES, type LedgerGateResult } from '../../shared/ledger';
import type { LedgerPort } from './ledgerPort';

/** 15 minutes. A gate is a lint+test run, not a build farm; past this the
 *  process group is killed and the result is a signal death (exitCode null),
 *  which the ledger contract already defines as a failure. */
export const GATE_TIMEOUT_MS = 15 * 60 * 1000;

/** How many trailing lines of combined output the verdict carries. Bounded
 *  again in BYTES by LEDGER_GATE_TAIL_MAX_BYTES — 40 lines of minified output
 *  can be megabytes. */
export const GATE_TAIL_LINES = 40;

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
}

const npmBin = (): string => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

function step(argv: string[]): GateStep {
  return { argv, label: argv.join(' ') };
}

/** Every argv shape this runner may ever spawn, as a function of the worktree.
 *  Exported so a test can assert the set has not grown. */
export function allowedGateArgv(worktreePath: string): readonly (readonly string[])[] {
  return [
    ['bash', path.join(worktreePath, GATE_VERIFY_SCRIPT)],
    [npmBin(), 'run', 'lint'],
    [npmBin(), 'test'],
  ];
}

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
  /** How the step ended — see GateExit. */
  wait(): Promise<GateExit>;
  /** Kill the whole process group (a test runner spawns children of its own). */
  kill(): void;
}

export type GateSpawn = (cmd: string, args: readonly string[], opts: { cwd: string }) => GateProcess;

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
  now?: () => number;
  /** Injected for tests; defaults to reading `<root>/package.json`. `null` means
   *  the file is there and could not be read or parsed — see
   *  defaultReadPackageScripts. An absent package.json is `{}`. */
  readPackageScripts?: (root: string) => Record<string, string> | null;
  /** Injected for tests; defaults to an lstat of `<worktree>/node_modules`. */
  depsState?: (worktreePath: string) => 'ok' | 'missing' | 'symlink';
  /** Injected for tests; defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
}

// ── Results ──────────────────────────────────────────────────────────────────

export type GateSkipReason = 'deps_missing' | 'no_gate_command' | 'gate_unavailable';

export type GateRunResult =
  /** The gate ran to a verdict. `result.exitCode === 0` is the only pass. */
  | { ok: true; status: 'completed'; taskId: string; result: LedgerGateResult; recorded: boolean }
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
  /** The project declared a gate this runner will not execute. */
  | { ok: false; status: 'refused'; taskId: string; error: string };

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
}

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
    // still no caller string being interpolated into a command line.
    ...(process.platform === 'win32' ? { shell: true } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    onOutput(cb) {
      child.stdout?.on('data', (d: Buffer) => cb(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => cb(d.toString('utf8')));
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

// ── The runner ───────────────────────────────────────────────────────────────

interface ActiveGate {
  cancel: () => void;
}

export class TaskGateRunner {
  private readonly ledger: LedgerPort;
  private readonly project: ProjectGatePort | undefined;
  private readonly spawn: GateSpawn;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly readPackageScripts: (root: string) => Record<string, string> | null;
  private readonly depsState: (worktreePath: string) => 'ok' | 'missing' | 'symlink';
  private readonly fileExists: (p: string) => boolean;
  /** One gate per task — the second concurrent call is `busy`, not a second
   *  npm install fighting the first over the same node_modules. */
  private readonly active = new Map<string, ActiveGate>();

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
    this.readPackageScripts = opts.readPackageScripts ?? defaultReadPackageScripts;
    this.depsState = opts.depsState ?? defaultDepsState;
    this.fileExists = opts.fileExists ?? ((p) => fs.existsSync(p));
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
   * package.json actually has.
   */
  async resolveSteps(
    worktreePath: string,
    configRoot: string = worktreePath,
  ): Promise<{ steps: GateStep[] } | { refused: string } | { unavailable: string }> {
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
      if (this.fileExists(scriptPath)) return { steps: [step(['bash', scriptPath])] };
      // Declared and trusted, but this worktree does not have the file. Falling
      // through to npm would grade the task by a gate the project did not
      // choose, so say so instead.
      return {
        refused: `this project declares ${GATE_VERIFY_SCRIPT} as its gate, but that file is not in the task worktree`,
      };
    }

    const scripts = this.readPackageScripts(worktreePath);
    if (scripts === null) {
      return {
        unavailable: `the package.json in ${worktreePath} could not be read or parsed, so whether this project has a gate is unknown`,
      };
    }
    const steps: GateStep[] = [];
    if (typeof scripts['lint'] === 'string') steps.push(step([npmBin(), 'run', 'lint']));
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
    const token: ActiveGate = {
      cancel: (): void => {
        cancelled = true;
        current?.kill();
      },
    };
    this.active.set(taskId, token);
    const release = (): void => {
      if (this.active.get(taskId) === token) this.active.delete(taskId);
    };

    try {
      // WHICH steps first, THEN whether the environment can run them. The other
      // order asked `node_modules` about a repository that may not be a Node
      // project at all: a task in a Go or Rust checkout has no node_modules, so
      // every gate answered `deps_missing` — unrecorded — and the task could
      // never reach `completed`. That is the exact blockage the no-gate record
      // exists to remove, reintroduced one step earlier.
      const resolved = await this.resolveSteps(worktreePath, input.projectRoot ?? worktreePath);
      if ('refused' in resolved) return { ok: false, status: 'refused', taskId, error: resolved.refused };
      if ('unavailable' in resolved) {
        return { ok: true, status: 'skipped', taskId, skipped: 'gate_unavailable', detail: resolved.unavailable };
      }
      if (resolved.steps.length === 0) return this.noGateVerdict(input);

      const deps = this.depsState(worktreePath);
      if (deps !== 'ok') {
        return {
          ok: true,
          status: 'skipped',
          taskId,
          skipped: 'deps_missing',
          detail:
            deps === 'missing'
              ? 'node_modules is missing in the task worktree — run npm ci there, then re-run the gate'
              : 'node_modules in the task worktree is a symlink, which makes lint/test results meaningless — run a real npm ci there',
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

      for (const step of resolved.steps) {
        if (cancelled) {
          exitCode = null;
          label = step.label;
          break;
        }
        label = step.label;
        const [cmd, ...args] = step.argv;
        const proc = this.spawn(cmd as string, args, { cwd: worktreePath });
        current = proc;
        proc.onOutput(append);

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, this.timeoutMs);
        let exit: GateExit;
        try {
          exit = await proc.wait();
        } finally {
          clearTimeout(timer);
          current = null;
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

      const result: LedgerGateResult = {
        exitCode,
        tail: boundTail(output),
        at: this.now(),
        command: label,
      };
      const recorded = await this.record(taskId, input.systemWorkspaceId, result);
      return { ok: true, status: 'completed', taskId, result, recorded };
    } finally {
      release();
    }
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
  private async noGateVerdict(input: GateRunInput): Promise<GateRunResult> {
    const { taskId, worktreePath } = input;
    const parentRoot = input.projectRoot ?? worktreePath;
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
        const result: LedgerGateResult = { exitCode: 1, tail: detail, at: this.now(), command: 'none' };
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
    });
    return { ok: true, status: 'skipped', taskId, skipped: 'no_gate_command', detail, recorded };
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
