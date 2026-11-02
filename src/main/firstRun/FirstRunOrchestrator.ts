/**
 * FirstRunOrchestrator (T4) — wizard centerpiece for the main process.
 * Manages `.first-run` marker, surfaces ClaudeDetector, wraps MCP register
 * (D10 envelope), adapts daemon/local PTY data into a `PtyDataSource`, and
 * drives SampleTaskRunner. Single-flight: one runner at a time; dismiss /
 * re-start aborts the prior one. Reopen ignores the marker (D9).
 * See: progress.md (T4), decisions.md (D7/D9/D10).
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants';
import { sanitizePtyText } from '../../shared/types';
import { ClaudeDetector } from './ClaudeDetector';
import { AgentSetupDetector } from './AgentSetupDetector';
import { SampleTaskRunner, type PtyDataSource } from './SampleTaskRunner';
import type { PTYManager } from '../pty/PTYManager';
import type { PTYBridge } from '../pty/PTYBridge';
import type { DaemonClient } from '../DaemonClient';
import type { McpRegistrar } from '../mcp/McpRegistrar';
import { externalRegistrationSkipReason } from '../../shared/mcpTargets';
import type {
  FirstRunCheckResult,
  RegisterMcpResult,
  SampleTaskOutcome,
} from '../../shared/firstRun';
import { AGENT_IDS, type AgentId, type AgentSetupStatus } from '../../shared/agentSetup';
import {
  agentExecutableNames,
  agentInstallMethods,
  agentLoginCommand,
  shellSyntax,
  type AgentSetupPlan,
  type SetAgentPathResult,
} from '../../shared/agentInstall';
import { isExecutableFile, liveResolveEnv, programOnPath } from '../claude/resolveClaudeExecutable';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';

const MARKER_FILENAME = '.first-run';
/** A skipped first run's marker body starts with this; a completed one is the
 *  bare ISO timestamp (the only body older builds wrote, so those read as
 *  completed). Either body counts as "first run shown". */
const SKIPPED_PREFIX = 'skipped ';
/** Paths the user typed in an agent card ("installed but not found"). */
const AGENT_PATHS_FILENAME = 'agent-paths.json';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const NOOP = (chunk: string): void => { void chunk; };

/** Daemon-mode PtyDataSource adapter (production default). */
function buildDaemonSource(dc: DaemonClient, ptyId: string): PtyDataSource {
  let handlerRef: (chunk: string) => void = NOOP;
  const listener = (...args: unknown[]): void => {
    const payload = args[0] as { sessionId?: string; data?: Buffer | string } | undefined;
    if (!payload || payload.sessionId !== ptyId) return;
    const data = payload.data;
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : (typeof data === 'string' ? data : '');
    if (text.length > 0) handlerRef(text);
  };
  return {
    onData(handler) {
      handlerRef = handler;
      dc.on('session:data', listener);
      return () => { dc.removeListener('session:data', listener); handlerRef = NOOP; };
    },
    // Through the daemon's control channel, not the pane's session pipe: the
    // pane's own attach replaces that pipe (pty:reconnect, forceFresh) just
    // after the pane is created, and a write in between was dropped while
    // the wizard reported success. daemon.writeIfUnchanged compares the pane
    // with a fresh read and writes in one step, and answers whether it wrote.
    // Second layer, bounded by SAMPLE_WRITE_WINDOW_MS: output that lands
    // between the read and the write (the grid's resize redraws the prompt)
    // refuses it, and a prompt still being drawn is waited for
    // (samplePromptVerdict), so the pane is read and tried again. The compare
    // makes a retry safe: a line already typed has moved the pane, so it is
    // never typed twice. Skip or dismiss (the signal) stops the loop.
    async write(data, signal) {
      const line = sanitizePtyText(data);
      const startedAt = Date.now();
      let baseline: PromptBaseline | null = null;
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) {
          if (Date.now() - startedAt >= SAMPLE_WRITE_WINDOW_MS) return false;
          await new Promise((r) => setTimeout(r, SAMPLE_WRITE_RETRY_MS));
        }
        if (signal?.aborted) return false;
        let read: PromptRead | null;
        try {
          read = await dc.rpc('daemon.readPromptEvents', { sessionId: ptyId, limit: 1 }) as PromptRead | null;
        } catch {
          return false; // nothing was written since the last answer
        }
        if (!read) return false;
        baseline ??= { keyInputRevision: read.keyInputRevision, incarnationId: read.incarnationId };
        const verdict = samplePromptVerdict(read, baseline, Date.now() - startedAt >= SAMPLE_PROMPT_END_GRACE_MS);
        if (verdict === 'refuse') return false;
        if (verdict === 'wait') continue;
        if (signal?.aborted) return false;
        const last = read.events?.at(-1);
        let res: { written?: boolean } | null;
        try {
          res = await dc.rpc('daemon.writeIfUnchanged', {
            sessionId: ptyId,
            data: line,
            // The person running the first-run wizard asked for this line.
            origin: 'human',
            expect: {
              ...(typeof read.keyInputRevision === 'number' ? { keyInputRevision: read.keyInputRevision } : {}),
              ...(typeof read.incarnationId === 'string' && read.incarnationId ? { incarnationId: read.incarnationId } : {}),
              // A prompt that never drew its end has no empty-prompt verdict:
              // its key revision, still 0, stands in for it.
              ...(verdict === 'write' ? { requireEmptyShellPrompt: true as const } : {}),
              outputBytes: read.totalBytesWritten ?? 0,
              markerCount: read.eventCount ?? read.events?.length ?? 0,
              lastPromptMarker: last && typeof last.byteOffset === 'number' ? { type: last.type, byteOffset: last.byteOffset } : null,
            },
          }) as { written?: boolean } | null;
        } catch {
          // The reply was lost; the write may still have happened. The
          // daemon moves the key revision when it types the line, so one
          // read tells: moved means written, unchanged means not (try again).
          const after = await (dc.rpc('daemon.readPromptEvents', { sessionId: ptyId, limit: 1 }) as Promise<PromptRead | null>)
            .catch(() => null);
          const wrote = writeLanded(read, after);
          if (wrote === null) return 'unknown';
          if (wrote) return true;
          continue;
        }
        if (res?.written === true) return true;
      }
    },
    // The daemon logs each OSC 133 marker before it forwards the bytes, so
    // its prompt log holds every prompt this listener could have missed.
    async atPrompt() {
      const res = await dc.rpc('daemon.readPromptEvents', { sessionId: ptyId, limit: 1 });
      return shellAtEmptyPrompt(res as PromptRead | null);
    },
  };
}

/**
 * How long the sample command's conditional write keeps trying (see
 * buildDaemonSource): the runner's own handshake bound, OSC133_TIMEOUT_MS.
 */
export const SAMPLE_WRITE_WINDOW_MS = 5000;
export const SAMPLE_WRITE_RETRY_MS = 150;
/**
 * How long a prompt's start (133;A) may stand without its end (133;B) before
 * the write goes ahead without it. bash runs the user's PROMPT_COMMAND
 * between the two, often 50-500 ms; a prompt framework that rebuilds PS1 on
 * every prompt drops the B append and never draws it.
 */
export const SAMPLE_PROMPT_END_GRACE_MS = 1500;

interface PromptBaseline {
  keyInputRevision?: number;
  incarnationId?: string;
}

/**
 * What the sample command's write does with one read of the pane:
 * - `refuse` on hard evidence that the prompt is not a fresh, empty one: a key
 *   since the first read, another shell incarnation, a command started, or a
 *   drawn prompt the daemon does not vouch for as empty;
 * - `write` at a drawn prompt (133;B) the daemon vouches for as empty;
 * - `write-unended` at a prompt start (133;A) whose end did not come within
 *   the grace, on a pane no key has ever reached (key revision 0);
 * - `wait` otherwise: the prompt is still being drawn, or there is none yet.
 */
export function samplePromptVerdict(
  read: PromptRead,
  baseline: PromptBaseline,
  graceOver: boolean,
): 'refuse' | 'write' | 'write-unended' | 'wait' {
  if (read.sessionFound !== true) return 'refuse';
  if (baseline.incarnationId !== undefined && read.incarnationId !== baseline.incarnationId) return 'refuse';
  if (baseline.keyInputRevision !== undefined && read.keyInputRevision !== baseline.keyInputRevision) return 'refuse';
  const last = read.events?.at(-1)?.type;
  if (last === 'command_start') return 'refuse';
  if (last === 'prompt_end') return shellAtEmptyPrompt(read) ? 'write' : 'refuse';
  if (last === 'prompt_start' && graceOver && read.keyInputRevision === 0) return 'write-unended';
  return 'wait';
}

/**
 * Whether a conditional write whose reply was lost had typed the line:
 * the daemon moves the key revision when it does. Null when the pane cannot
 * be read again, or the reads cannot tell.
 */
function writeLanded(before: PromptRead, after: PromptRead | null): boolean | null {
  if (!after || after.sessionFound !== true) return null;
  if (typeof before.keyInputRevision !== 'number' || typeof after.keyInputRevision !== 'number') return null;
  if (after.incarnationId !== before.incarnationId) return null;
  return after.keyInputRevision > before.keyInputRevision;
}

export interface PromptRead {
  events?: Array<{ type: string; byteOffset?: number }>;
  eventCount?: number;
  totalBytesWritten?: number;
  keyInputRevision?: number;
  incarnationId?: string;
  emptyShellPrompt?: boolean;
  sessionFound?: boolean;
}

/**
 * The newest OSC 133 marker ends a prompt (B) and the daemon vouches that the
 * prompt is empty. A marker alone cannot tell a fresh prompt from a stale one
 * under a shell that never reports command-start (bash 3.2, pwsh without
 * PSReadLine); emptyShellPrompt is cleared by any key (not by a terminal's
 * replies or focus reports), so it also keeps the command off a line the user
 * has begun typing (as terminalSession.ts reads it).
 */
export function shellAtEmptyPrompt(res: PromptRead | null): boolean {
  return res?.sessionFound === true
    && res.events?.at(-1)?.type === 'prompt_end'
    && res.emptyShellPrompt === true;
}

/**
 * Non-daemon PtyDataSource. PTYBridge has no removeMiddleware, so we gate via
 * a `disposed` flag. Stack is torn down on PTY dispose anyway → bounded leak.
 */
function buildLocalSource(ptyManager: PTYManager, ptyBridge: PTYBridge, ptyId: string): PtyDataSource {
  return {
    onData(handler) {
      let disposed = false;
      ptyBridge.addMiddleware(ptyId, (data) => { if (!disposed) handler(data); });
      return () => { disposed = true; };
    },
    write(data) { ptyManager.write(ptyId, sanitizePtyText(data)); },
  };
}

export class FirstRunOrchestrator {
  private detector = new ClaudeDetector();
  private agentDetector = new AgentSetupDetector({ override: (agent) => this.readAgentPaths()[agent] ?? null });
  private runner = new SampleTaskRunner();
  private activeAbort: AbortController | null = null;

  constructor(
    private ptyManager: PTYManager,
    private ptyBridge: PTYBridge,
    private getDaemonClient: () => DaemonClient | null,
    private mcpRegistrar: McpRegistrar,
    private getAuthToken: () => string | null,
    private getWindow: () => BrowserWindow | null,
  ) {}

  async check(): Promise<FirstRunCheckResult> {
    const [shown, status, completedAt] = await Promise.all([
      this.markerExists(),
      this.detector.detect(),
      this.readCompletedAt(),
    ]);
    return completedAt !== undefined ? { shown, status, completedAt } : { shown, status };
  }

  /**
   * The agent cards' status. Kept off check()/reopen(): it spawns each agent's
   * --version and sign-in probes, and the wizard must not wait on those to open.
   */
  async agentStatus(): Promise<AgentSetupStatus[]> {
    return this.agentDetector.detectAll();
  }

  /**
   * What the card can offer for one agent: the bundled install line (and any
   * program it needs that is missing here) and, once installed, the sign-in
   * line for the exact executable the card shows.
   */
  async agentPlan(agent: AgentId, paneShell?: string): Promise<AgentSetupPlan> {
    const methods = agentInstallMethods(agent, process.platform);
    const method = methods[0];
    if (!method) throw new Error(`first-run: no install line for ${agent}`);
    const env = this.agentDetector.probeEnvFor(process.execPath);
    const installs = methods.map((m) => ({
      via: m.via,
      command: m.command,
      shell: m.shell,
      officialPage: m.officialPage,
      missing: m.requires.filter((name) => !this.onPath(name, env)),
    }));
    const executable = this.agentDetector.resolveExecutable(agent);
    return {
      agent,
      install: installs[0],
      installs,
      // The sign-in line is typed into the pane's shell, so it is quoted for that
      // shell: PowerShell on Windows; on macOS/Linux the shell the pane spawns
      // (the renderer's explicit choice, else $SHELL, as pty creation does),
      // which may be pwsh too.
      login: executable
        ? { command: agentLoginCommand(executable, method.shell === 'powershell' ? 'powershell' : shellSyntax(paneShell || process.env.SHELL)), shell: method.shell }
        : null,
    };
  }

  /**
   * Remember a path the user typed for an agent wmux did not find, after
   * checking it names that agent and runs (`--version`). `null` forgets it.
   */
  async setAgentPath(agent: AgentId, input: string | null): Promise<SetAgentPathResult> {
    // One save at a time, each merged into what is on disk when it writes, so
    // two cards saving at once never drop each other's path.
    const run = this.agentPathsQueue.then(() => this.applyAgentPath(agent, input));
    this.agentPathsQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private agentPathsQueue: Promise<void> = Promise.resolve();

  private async applyAgentPath(agent: AgentId, input: string | null): Promise<SetAgentPathResult> {
    if (input === null) {
      const paths = this.readAgentPaths();
      delete paths[agent];
      await this.writeAgentPaths(paths);
      return { ok: true };
    }
    const p = input.trim().replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(p)) return { ok: false, reason: 'not-absolute' };
    if (!isExecutableFile(p)) return { ok: false, reason: 'not-found' };
    if (!agentExecutableNames(agent).includes(path.basename(p).toLowerCase())) {
      return { ok: false, reason: 'wrong-program' };
    }
    if ((await this.agentDetector.readVersion(p)) === null) return { ok: false, reason: 'does-not-run' };
    const paths = this.readAgentPaths();
    paths[agent] = p;
    await this.writeAgentPaths(paths);
    return { ok: true };
  }

  private onPath(name: string, env: NodeJS.ProcessEnv): boolean {
    return programOnPath(liveResolveEnv(env), name);
  }

  private agentPathsPath(): string {
    return path.join(app.getPath('userData'), AGENT_PATHS_FILENAME);
  }

  /** Sync and tiny: read on every detect so a change applies at once. */
  private readAgentPaths(): Partial<Record<AgentId, string>> {
    const file = this.agentPathsPath();
    let text: string;
    try {
      text = fsSync.readFileSync(file, 'utf8');
    } catch {
      // The atomic write moves the old file to `.bak` just before putting the
      // new one in place; a read in that moment gets the previous paths.
      try { text = fsSync.readFileSync(`${file}.bak`, 'utf8'); } catch { return {}; }
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      const out: Partial<Record<AgentId, string>> = {};
      for (const agent of AGENT_IDS) {
        const v = raw?.[agent];
        if (typeof v === 'string' && path.isAbsolute(v)) out[agent] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  private async writeAgentPaths(paths: Partial<Record<AgentId, string>>): Promise<void> {
    // Atomic: a detect reading it mid-write must never see half a file.
    await atomicWriteJSON(this.agentPathsPath(), paths);
  }

  async complete(): Promise<void> {
    await this.writeMarker(new Date().toISOString());
  }

  /**
   * Skip, Later, × or Escape. Marks the first run as shown without calling it
   * completed. Closing a reopened wizard leaves the marker as it was, so a
   * completed first run never turns into a skipped one.
   */
  async dismiss(): Promise<void> {
    this.activeAbort?.abort();
    this.activeAbort = null;
    if (await this.markerExists()) return;
    await this.writeMarker(`${SKIPPED_PREFIX}${new Date().toISOString()}`);
  }

  async reopen(): Promise<FirstRunCheckResult> {
    const [status, completedAt] = await Promise.all([
      this.detector.detect(),
      this.readCompletedAt(),
    ]);
    // shown=false instructs the wizard UI to mount even though the marker exists.
    return completedAt !== undefined
      ? { shown: false, status, completedAt }
      : { shown: false, status };
  }

  async registerMcp(): Promise<RegisterMcpResult> {
    // #1151 — register() skips external configs under an isolated instance,
    // so the pre-flight below (which probes the PRODUCTION ~/.claude.json)
    // and the post-register verification would judge a write that never
    // happens: a coincidental ok on machines where production is already
    // registered, a misleading "completed without recording" otherwise.
    // Skipping IS the correct outcome here — report it as success.
    const skipReason = externalRegistrationSkipReason();
    if (skipReason) {
      console.log(`[FirstRun] ${skipReason}`);
      return { ok: true };
    }
    // McpRegistrar.register() swallows its own errors (try/catch +
    // console.error) and never throws — so wrapping it in try/catch only
    // ever surfaces UNKNOWN. To classify EACCES / EPERM / SyntaxError /
    // ENOENT correctly we run pre-flight fs probes against the actual
    // file we're about to mutate (~/.claude.json) before delegating to
    // the registrar. ENOENT is benign here — register() will create the
    // file as long as the parent directory is writable, so we don't bail
    // on missing-file (just on missing-dir / unreadable / unwritable).
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');

    // 1. Parent directory must exist (we don't want to mkdir blindly).
    try {
      await fs.stat(path.dirname(claudeJsonPath));
    } catch (e: unknown) {
      return { ok: false, code: 'IO', message: this.errorMessage(e, 'cannot stat home directory') };
    }

    // 2. If the file exists, it must be readable AND parseable.
    //    ENOENT is fine — register() will create a fresh file.
    try {
      const content = await fs.readFile(claudeJsonPath, 'utf8');
      try {
        JSON.parse(content);
      } catch (e: unknown) {
        return { ok: false, code: 'PARSE', message: this.errorMessage(e, 'malformed ~/.claude.json') };
      }
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Fresh install — fall through to write probe + register().
      } else if (code === 'EACCES' || code === 'EPERM') {
        return { ok: false, code: 'PERM', message: this.errorMessage(e, 'cannot read ~/.claude.json') };
      } else {
        return { ok: false, code: 'IO', message: this.errorMessage(e, 'IO error reading ~/.claude.json') };
      }
    }

    // 3. Write access — either to the existing file or to its parent dir.
    try {
      await fs.access(claudeJsonPath, fs.constants.W_OK).catch(async () => {
        await fs.access(path.dirname(claudeJsonPath), fs.constants.W_OK);
      });
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      return {
        ok: false,
        code: (code === 'EACCES' || code === 'EPERM') ? 'PERM' : 'IO',
        message: this.errorMessage(e, 'cannot write ~/.claude.json'),
      };
    }

    // 4. Pre-flight passed — delegate to McpRegistrar (which catches its
    //    own errors and never throws) and verify via getStatus().
    const token = this.getAuthToken();
    if (!token) {
      return { ok: false, code: 'UNKNOWN', message: 'auth token not ready (pipe server still starting)' };
    }
    // No opts: register() probes broker health itself (RISK 6 self-correction).
    await this.mcpRegistrar.register(token);
    // First-run is the Claude onboarding flow; success is keyed on Claude's
    // target. Codex/Gemini are written opportunistically by register() when
    // installed and their failure must not fail first-run.
    const status = this.mcpRegistrar.getStatus();
    const claude = status.targets.find((t) => t.id === 'claude');
    if (claude?.wmux.registered) return { ok: true };
    return { ok: false, code: 'UNKNOWN', message: 'registration completed without recording wmux entry' };
  }

  private errorMessage(e: unknown, fallback: string): string {
    return e instanceof Error ? e.message : fallback;
  }

  /**
   * Fire FIRST_RUN_SAMPLE_TASK_TIMEOUT to the renderer without going through
   * the runner. Used by the IPC handler (I6) when {@link startSampleTask}
   * itself rejects — without this the wizard hangs in 'awaiting-prompt'
   * because it only listens on the READY / TIMEOUT event channels.
   */
  emitSampleTaskTimeout(): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.FIRST_RUN_SAMPLE_TASK_TIMEOUT);
  }

  async startSampleTask(ptyId: string): Promise<SampleTaskOutcome> {
    // Single-flight: cancel any prior runner before starting a new one.
    this.activeAbort?.abort();
    const ctrl = new AbortController();
    this.activeAbort = ctrl;

    const dc = this.getDaemonClient();
    const source: PtyDataSource = dc !== null && dc.isConnected
      ? buildDaemonSource(dc, ptyId)
      : buildLocalSource(this.ptyManager, this.ptyBridge, ptyId);

    const { outcome } = await this.runner.run(source, ctrl.signal);

    // Only clear if we're still the active runner (defensive against re-entry).
    if (this.activeAbort === ctrl) this.activeAbort = null;

    const win = this.getWindow();
    if (!win || win.isDestroyed()) return outcome;
    if (outcome === 'ok') win.webContents.send(IPC.FIRST_RUN_SAMPLE_TASK_READY);
    else if (outcome === 'timeout') win.webContents.send(IPC.FIRST_RUN_SAMPLE_TASK_TIMEOUT);
    // 'aborted' → no event; dismiss/restart already handled the UX.
    // 'undelivered' → no event; the start invoke rejects (firstRun/index.ts).
    return outcome;
  }

  // ── private ────────────────────────────────────────────────────────────────

  private markerPath(): string {
    return path.join(app.getPath('userData'), MARKER_FILENAME);
  }

  private async markerExists(): Promise<boolean> {
    try {
      await fs.stat(this.markerPath());
      return true;
    } catch {
      return false;
    }
  }

  private async writeMarker(body: string): Promise<void> {
    try {
      await fs.writeFile(this.markerPath(), body, 'utf8');
    } catch (err) {
      console.error('[FirstRunOrchestrator] writeMarker failed:', err);
    }
  }

  private async readCompletedAt(): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(this.markerPath(), 'utf8');
      const trimmed = raw.trim();
      // A skipped first run has no completion date to report.
      if (trimmed.startsWith(SKIPPED_PREFIX)) return undefined;
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }
}
