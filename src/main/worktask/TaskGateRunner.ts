// ─── TaskGateRunner — the completion gate a task must pass, run by the daemon ─
//
// Before this, "did the task's work actually build?" was something only a human
// could answer: the brain could type `npm test` into a pane and then read a
// terminal screen. Screens are not receipts. This runner executes a FIXED,
// allow-listed command set inside the task's own worktree and writes one
// structured verdict into the task ledger, so `completed` means a gate passed
// rather than a worker having said so.
//
// What it is NOT: a shell. There is no caller-supplied command anywhere in this
// file. The only three argv arrays it will ever spawn are ALLOWED_GATE_ARGV
// below, chosen by the runner from what the project itself declares:
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
// `node_modules` missing (or a symlink, which is how worktrees in this repo get
// a false `npm test` failure) is reported as `skipped: 'deps_missing'`, never as
// a failing gate: "the gate did not run" and "the code is broken" are different
// facts and a brain that cannot tell them apart will close a healthy task as
// failed.
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

/** A running child, reduced to what the runner needs. The default
 *  implementation wraps `child_process.spawn`; tests inject a fake. */
export interface GateProcess {
  /** Combined stdout+stderr, chunk by chunk. */
  onOutput(cb: (chunk: string) => void): void;
  /** Resolves with the exit code, or `null` when the child died on a signal. */
  wait(): Promise<number | null>;
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
  /** Injected for tests; defaults to reading `<worktree>/package.json`. */
  readPackageScripts?: (worktreePath: string) => Record<string, string>;
  /** Injected for tests; defaults to an lstat of `<worktree>/node_modules`. */
  depsState?: (worktreePath: string) => 'ok' | 'missing' | 'symlink';
  /** Injected for tests; defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
}

// ── Results ──────────────────────────────────────────────────────────────────

export type GateSkipReason = 'deps_missing' | 'no_gate_command';

export type GateRunResult =
  /** The gate ran to a verdict. `result.exitCode === 0` is the only pass. */
  | { ok: true; status: 'completed'; taskId: string; result: LedgerGateResult; recorded: boolean }
  /** Nothing ran, and that is not a failure. */
  | { ok: true; status: 'skipped'; taskId: string; skipped: GateSkipReason; detail: string }
  /** A gate for this task is already running. */
  | { ok: false; status: 'busy'; taskId: string }
  /** The project declared a gate this runner will not execute. */
  | { ok: false; status: 'refused'; taskId: string; error: string };

export interface GateRunInput {
  taskId: string;
  worktreePath: string;
  /** The daemon's own workspace id — the gate is a `system` write. */
  systemWorkspaceId: string;
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    onOutput(cb) {
      child.stdout?.on('data', (d: Buffer) => cb(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => cb(d.toString('utf8')));
    },
    wait() {
      return new Promise<number | null>((resolve) => {
        child.once('error', () => resolve(null));
        child.once('close', (code: number | null) => resolve(code));
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

function defaultReadPackageScripts(worktreePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.scripts ?? {})) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
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
  private readonly readPackageScripts: (worktreePath: string) => Record<string, string>;
  private readonly depsState: (worktreePath: string) => 'ok' | 'missing' | 'symlink';
  private readonly fileExists: (p: string) => boolean;
  /** One gate per task — the second concurrent call is `busy`, not a second
   *  npm install fighting the first over the same node_modules. */
  private readonly active = new Map<string, ActiveGate>();

  constructor(opts: TaskGateRunnerOptions) {
    this.ledger = opts.ledger;
    this.project = opts.project;
    this.spawn = opts.spawn ?? defaultSpawn;
    this.timeoutMs = opts.timeoutMs ?? GATE_TIMEOUT_MS;
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
  ): Promise<{ steps: GateStep[] } | { refused: string }> {
    const declared = await this.declaredVerifyCommand(worktreePath);
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
    const steps: GateStep[] = [];
    if (typeof scripts['lint'] === 'string') steps.push(step([npmBin(), 'run', 'lint']));
    if (typeof scripts['test'] === 'string') steps.push(step([npmBin(), 'test']));
    return { steps };
  }

  /** The trusted project's `verify` command string, or null when there is none
   *  (no config, not trusted, or no such command). */
  private async declaredVerifyCommand(worktreePath: string): Promise<string | null> {
    if (!this.project) return null;
    let state: { trust?: string; config?: { commands?: { id: string; command: string }[] } };
    try {
      state = await this.project.getState(worktreePath);
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
    if (this.active.has(taskId)) return { ok: false, status: 'busy', taskId };

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

    const resolved = await this.resolveSteps(worktreePath);
    if ('refused' in resolved) return { ok: false, status: 'refused', taskId, error: resolved.refused };
    if (resolved.steps.length === 0) {
      return {
        ok: true,
        status: 'skipped',
        taskId,
        skipped: 'no_gate_command',
        detail: 'this project declares no verify script and no npm lint/test scripts, so there is no gate to run',
      };
    }

    // Claimed synchronously with respect to the awaits above: everything that
    // could reject has already run, so from here a concurrent call is `busy`.
    let cancelled = false;
    let current: GateProcess | null = null;
    const cancel = (): void => {
      cancelled = true;
      current?.kill();
    };
    this.active.set(taskId, { cancel });

    try {
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

      for (const s of resolved.steps) {
        if (cancelled) {
          exitCode = null;
          label = s.label;
          break;
        }
        label = s.label;
        const [cmd, ...args] = s.argv;
        const proc = this.spawn(cmd as string, args, { cwd: worktreePath });
        current = proc;
        proc.onOutput(append);

        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        if (this.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            proc.kill();
          }, this.timeoutMs);
        }
        try {
          exitCode = await proc.wait();
        } finally {
          if (timer) clearTimeout(timer);
          current = null;
        }
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
      this.active.delete(taskId);
    }
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
