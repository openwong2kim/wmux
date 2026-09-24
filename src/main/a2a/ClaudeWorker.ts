import { spawn, type ChildProcess } from 'node:child_process';
import type { BrowserWindow } from 'electron';
import { getAccountStore } from '../account/accountStore';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import type { CompletionEvidence } from '../../shared/types';

type GetWindow = () => BrowserWindow | null;

/** 데몬 커밋에 필요한 최소 RPC 표면(DaemonClient 만족 — 테스트 주입 용이). */
export interface DaemonRpcLike {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
type GetDaemonClient = () => DaemonRpcLike | null;

interface WorkerSession {
  proc: ChildProcess;
  taskId: string;
  lineBuffer: string;
  sessionId: string | null;
  /** Ends a run that never reports a result (see WORKER_RUN_TIMEOUT_MS). */
  runTimer?: ReturnType<typeof setTimeout>;
}

const MAX_CONCURRENT = 4;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * The longest one background run may take before its task is failed and the
 * process killed. Generous — a real task can be long — but finite: a worker that
 * hangs must not leave its task in `working` forever (#1472).
 */
export const WORKER_RUN_TIMEOUT_MS = 30 * 60_000;

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
    // envelope PR4 C12: 전이 정본은 데몬 로그 — 미주입(구 배선/테스트)이면 렌더러
    // 직행 폴백만 남는다(현행 동작 보존).
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
      // The message below is a stream-json user message, not prompt text.
      '--input-format', 'stream-json',
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

    session.runTimer = setTimeout(() => {
      if (this.sessions.get(taskId) !== session) return;
      this.endSession(session);
      this.killWithFallback(proc);
      const reason = `Worker produced no result within ${WORKER_RUN_TIMEOUT_MS / 60_000} min and was stopped`;
      this.updateTaskStatus(taskId, receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
    }, WORKER_RUN_TIMEOUT_MS);
    session.runTimer.unref?.();

    // A worker that dies before reading its input turns the write into EPIPE on
    // this stream; without a listener that is an uncaught error in main. The
    // exit itself is reported by the close handler below.
    proc.stdin!.on('error', (err) => {
      console.warn(`[ClaudeWorker] task=${taskId} stdin error: ${err.message}`);
    });

    // Send the user message, then close stdin: `claude -p` reads its input to
    // EOF before it starts, so an open stdin left the run waiting forever and
    // the task stuck in `working` (#1472).
    proc.stdin!.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    }) + '\n');
    proc.stdin!.end();

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
      if (this.sessions.get(taskId) !== session) return;
      this.endSession(session);
      const reason = `Spawn error: ${err.message}`;
      this.updateTaskStatus(taskId, receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
    });

    proc.on('close', (code, signal) => {
      // Gone from the map: already settled by a result, the timeout, or cancel.
      if (this.sessions.get(taskId) !== session) return;
      this.endSession(session);
      // Still here means no result line arrived. A clean exit without one is a
      // failure too — reporting nothing left the task in `working`.
      const reason = code === 0
        ? 'Worker exited without a result'
        : `Process exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
      this.updateTaskStatus(taskId, receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
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

      this.endSession(session);

      const status = isError ? 'failed' : 'completed';
      const statusMessage = isError
        ? `Error: ${resultText}`
        : resultText;

      // (A′) 정직 증거: run 결과를 unverified 자기보고로만 표기한다 — CLI가 스스로
      // 성공을 보고했을 뿐 우리가 독립 검증한 게 아니므로 절대 command/passed(verified)로
      // 승격하지 않는다(설계 §⑥ CL1: run-success 세탁이 P2 의존성 술어를 오염 못 하게).
      const evidence: CompletionEvidence = isError
        ? {
            summary: `Error: ${resultText.trim() || 'agent run failed'}`,
            items: [{ kind: 'inspection', status: 'unverified', summary: 'claude CLI run reported error' }],
          }
        : {
            // C7: 빈 result 텍스트가 빈 summary 자기거부로 이어지지 않게 기본값을 준다.
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
   * 태스크 상태 전이 — **데몬 A2aTaskService 경유(envelope PR4 C12)**.
   *
   * 종전에는 sendToRenderer('a2a.task.update') 직행이었다 — a2aSlice가 캐시로
   * 강등된 뒤 그 경로만 남으면 실행자 전이(working/failed/completed)가 데몬 로그에
   * 영영 도달하지 않아 정본이 어디에도 없게 된다(패널 C12). 순서:
   *   1) 데몬 커밋(evidence 동반, §6.M PR-D′ 배선 보존 + idempotencyKey 재시도 흡수).
   *   2) 렌더러 캐시 갱신 — 데몬이 커밋했으면 daemonCommitted 마커 + committedTask로
   *      verbatim 적용(C6), 아니면 현행 검증 경로 그대로(폴백). 어느 쪽이든 렌더러의
   *      메시지 배달·단일 퍼널 이벤트 방출은 렌더러 핸들러가 수행한다(캐시 갱신 보장).
   * 데몬 거부/미가용은 현행과 동일하게 삼키고 로그만 남긴다(렌더러 폴백이 같은
   * 전이 그래프로 재판정 — 동형 게이트라 조용한 성공 위장이 없다).
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
          // §4 멱등: 태스크당 상태 전이는 1회 — 재시도가 로그를 이중 커밋하지 않게.
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

    this.endSession(session);
    this.killWithFallback(session.proc);

    return true;
  }

  /** Drop a session and its run timer. */
  private endSession(session: WorkerSession): void {
    if (session.runTimer) clearTimeout(session.runTimer);
    if (this.sessions.get(session.taskId) === session) this.sessions.delete(session.taskId);
  }

  /** SIGTERM, then SIGKILL after 5 s if the process is still there. */
  private killWithFallback(proc: ChildProcess): void {
    proc.kill('SIGTERM');
    const pid = proc.pid;
    if (pid) {
      setTimeout(() => {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 5000);
    }
  }

  /**
   * Stop all running tasks (graceful shutdown).
   */
  stop(): void {
    for (const [taskId, session] of this.sessions) {
      if (session.runTimer) clearTimeout(session.runTimer);
      session.proc.kill('SIGTERM');
      console.log(`[ClaudeWorker] Stopping task ${taskId}`);
    }
    this.sessions.clear();
  }
}
