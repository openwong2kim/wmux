import { spawn, type ChildProcess } from 'node:child_process';
import type { BrowserWindow } from 'electron';
import { getAccountStore } from '../account/accountStore';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import type { CompletionEvidence } from '../../shared/types';

type GetWindow = () => BrowserWindow | null;

/** Minimal RPC surface needed for daemon commit (satisfied by DaemonClient — easy test injection). */
export interface DaemonRpcLike {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
type GetDaemonClient = () => DaemonRpcLike | null;

interface WorkerSession {
  proc: ChildProcess;
  taskId: string;
  lineBuffer: string;
  sessionId: string | null;
}

const MAX_CONCURRENT = 4;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Background Claude Code worker — spawns CLI in stream-json mode
 * to execute A2A tasks without touching the PTY terminal.
 */
export class ClaudeWorker {
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly getWindow: GetWindow;
  private readonly getDaemonClient: GetDaemonClient;

  constructor(getWindow: GetWindow, getDaemonClient?: GetDaemonClient) {
    this.getWindow = getWindow;
    // envelope PR4 C12: transition canonical form is daemon log — if not injected (legacy wiring/test),
    // only renderer direct fallback remains (preserves current behavior).
    this.getDaemonClient = getDaemonClient ?? (() => null);
  }

  get isFull(): boolean {
    return this.sessions.size >= MAX_CONCURRENT;
  }

  /**
   * Execute a task in the background via Claude CLI.
   * Fire-and-forget: updates task status via sendToRenderer when done.
   */
  async execute(
    taskId: string,
    receiverWorkspaceId: string,
    message: string,
    cwd?: string,
  ): Promise<void> {
    if (this.isFull) {
      const reason = 'Worker at capacity';
      await this.updateTaskStatus(taskId, receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
      return;
    }

    // Mark task as working
    await this.updateTaskStatus(taskId, receiverWorkspaceId, 'working');

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ];

    // Multi-account (M0): this background claude spawn bypasses the PTY path, so
    // it must honor the receiving workspace's claude account binding too — else
    // it silently runs on the default account (Codex 3-way review P1). Missing
    // bound dir → default-credential fallback + warn.
    const accountEnv = getAccountStore().resolveAccountEnv(receiverWorkspaceId, 'claude', (acc) =>
      console.warn(
        `[account] a2a worker ws ${receiverWorkspaceId}: bound account "${acc.name}" configDir missing ` +
        `(${acc.configDir}) — falling back to the default credential.`,
      ),
    );
    const proc = spawn('claude', args, {
      cwd: cwd || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...accountEnv },
    });

    const session: WorkerSession = {
      proc,
      taskId,
      lineBuffer: '',
      sessionId: null,
    };
    this.sessions.set(taskId, session);

    // Send the user message as first stdin input
    proc.stdin!.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    }) + '\n');

    // Process NDJSON stdout
    proc.stdout!.on('data', (chunk: Buffer) => {
      session.lineBuffer += chunk.toString();

      if (session.lineBuffer.length > MAX_BUFFER_BYTES) {
        console.error(`[ClaudeWorker] Buffer overflow for task ${taskId}, destroying`);
        proc.kill('SIGTERM');
        return;
      }

      let newlineIndex: number;
      while ((newlineIndex = session.lineBuffer.indexOf('\n')) !== -1) {
        const line = session.lineBuffer.slice(0, newlineIndex).trim();
        session.lineBuffer = session.lineBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          this.processLine(session, receiverWorkspaceId, line);
        }
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().slice(0, 500);
      console.warn(`[ClaudeWorker] task=${taskId} stderr: ${text}`);
    });

    proc.on('error', (err) => {
      console.error(`[ClaudeWorker] spawn error for task ${taskId}:`, err);
      this.sessions.delete(taskId);
      const reason = `Spawn error: ${err.message}`;
      this.updateTaskStatus(taskId, receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
    });

    proc.on('close', (code) => {
      const sess = this.sessions.get(taskId);
      if (!sess) return; // already handled via processLine 'result'
      this.sessions.delete(taskId);
      if (code !== 0) {
        const reason = `Process exited with code ${code}`;
        this.updateTaskStatus(taskId, receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
      }
    });
  }

  /**
   * Process a single NDJSON line from Claude CLI stdout.
   */
  private processLine(session: WorkerSession, receiverWorkspaceId: string, line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // skip non-JSON lines
    }

    const type = parsed.type as string;

    if (type === 'system' && parsed.subtype === 'init') {
      session.sessionId = parsed.session_id as string;
    } else if (type === 'result') {
      const resultText = (parsed.result as string) ?? '';
      const isError = parsed.is_error as boolean;
      const costUsd = parsed.total_cost_usd as number;

      this.sessions.delete(session.taskId);

      const status = isError ? 'failed' : 'completed';
      const statusMessage = isError
        ? `Error: ${resultText}`
        : resultText;

      // (A′) Honest evidence: report run result as unverified self-report only — CLI reported
      // success itself, we did not verify independently, so never promote to command/passed (verified)
      // (design §⑥ CL1: run-success laundering must not corrupt P2 dependency predicates).
      const evidence: CompletionEvidence = isError
        ? {
            summary: `Error: ${resultText.trim() || 'agent run failed'}`,
            items: [{ kind: 'inspection', status: 'unverified', summary: 'claude CLI run reported error' }],
          }
        : {
            // C7: empty result text must not self-reject with empty summary — supply default.
            summary: resultText.trim() || 'agent run completed (empty result text)',
            items: [{
              kind: 'inspection',
              status: 'unverified',
              summary: 'claude CLI run exited success (self-reported; no independent verification)',
              location: 'claude -p (stream-json)',
              output: `session=${session.sessionId ?? '?'} cost=$${costUsd?.toFixed(4) ?? '?'}`,
            }],
          };

      this.updateTaskStatus(session.taskId, receiverWorkspaceId, status, statusMessage, evidence);

      console.log(`[ClaudeWorker] task=${session.taskId} ${status} cost=$${costUsd?.toFixed(4) ?? '?'}`);
    }
  }

  /**
   * Task state transition — **via daemon A2aTaskService (envelope PR4 C12)**.
   *
   * Previously sendToRenderer('a2a.task.update') direct — after a2aSlice demoted to cache,
   * that path alone left executor transitions (working/failed/completed) never reaching
   * daemon log, so canonical form existed nowhere (panel C12). Order:
   *   1) Daemon commit (with evidence, §6.M PR-D′ wiring preserved + idempotencyKey absorbs retries).
   *   2) Renderer cache update — if daemon committed: daemonCommitted marker + committedTask for
   *      verbatim apply (C6); else current validation path unchanged (fallback). Either way,
   *      message delivery and single-funnel event emission stay in renderer handler (cache update guaranteed).
   * Daemon reject/unavailable swallowed with log only as today (renderer fallback re-judges same
   * transition graph — isomorphic gate, no silent success masquerade).
   */
  private async updateTaskStatus(
    taskId: string,
    workspaceId: string,
    status: string,
    message?: string,
    evidence?: CompletionEvidence,
  ): Promise<void> {
    let committedTask: unknown;
    const dc = this.getDaemonClient();
    if (dc) {
      try {
        const res = await dc.rpc('a2a.task.update', {
          taskId,
          workspaceId,
          status,
          ...(evidence ? { evidence } : {}),
          // §4 idempotent: one state transition per task — retries must not double-commit the log.
          idempotencyKey: `claude-worker:${taskId}:${status}`,
        });
        if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === true) {
          committedTask = (res as { task?: unknown }).task;
        } else {
          const errMsg = res && typeof res === 'object' ? (res as { error?: unknown }).error : undefined;
          console.warn(`[ClaudeWorker] daemon transition not committed for ${taskId}:`, errMsg ?? res);
        }
      } catch (err) {
        console.warn(`[ClaudeWorker] daemon transition unavailable for ${taskId}:`, err);
      }
    }
    try {
      await sendToRenderer(this.getWindow, 'a2a.task.update', {
        taskId,
        workspaceId,
        status,
        ...(message ? { message } : {}),
        ...(evidence ? { evidence } : {}),
        ...(committedTask && typeof committedTask === 'object'
          ? { daemonCommitted: true, committedTask }
          : {}),
      });
    } catch (err) {
      console.error(`[ClaudeWorker] Failed to update task ${taskId}:`, err);
    }
  }

  /**
   * Cancel a running task.
   */
  cancel(taskId: string): boolean {
    const session = this.sessions.get(taskId);
    if (!session) return false;

    session.proc.kill('SIGTERM');
    this.sessions.delete(taskId);

    // Fallback SIGKILL after 5s
    const pid = session.proc.pid;
    if (pid) {
      setTimeout(() => {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 5000);
    }

    return true;
  }

  /**
   * Stop all running tasks (graceful shutdown).
   */
  stop(): void {
    for (const [taskId, session] of this.sessions) {
      session.proc.kill('SIGTERM');
      console.log(`[ClaudeWorker] Stopping task ${taskId}`);
    }
    this.sessions.clear();
  }
}
