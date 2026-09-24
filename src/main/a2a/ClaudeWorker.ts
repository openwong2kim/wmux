import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
  receiverWorkspaceId: string;
  lineBuffer: string;
  sessionId: string | null;
  /** Fails a run that has gone quiet (WORKER_IDLE_TIMEOUT_MS). */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Fails a run that has gone on too long in total (WORKER_HARD_TIMEOUT_MS). */
  hardTimer?: ReturnType<typeof setTimeout>;
  /** Settles a run whose process exited but whose stdout has not closed. */
  drainTimer?: ReturnType<typeof setTimeout>;
}

const MAX_CONCURRENT = 4;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

// A worker that hangs must not leave its task in `working` forever (#1472).
// Two limits, so a long job that keeps streaming is not cut off by the clock:
/** No stdout at all for this long ends the run. Reset by every chunk. */
export const WORKER_IDLE_TIMEOUT_MS = 10 * 60_000;
/** No run lasts longer than this, output or not. */
export const WORKER_HARD_TIMEOUT_MS = 2 * 60 * 60_000;
/** After the process exits, how long its stdout gets to deliver a final
 *  result line before the run is settled on the exit alone. */
export const WORKER_EXIT_DRAIN_MS = 2_000;
/** SIGTERM to SIGKILL. */
export const WORKER_KILL_GRACE_MS = 5_000;

/**
 * Every process group in a worker's tree: its own, plus the groups of all its
 * descendants. A bypassPermissions run starts its own children (shell tools,
 * builds, MCP servers), and Claude Code runs each tool command in a process
 * group of its own — so signalling only the worker's group left them running,
 * reparented to init, after the task was already marked failed. Found by
 * walking parentage, which only works while the worker is still their parent.
 */
function processGroupsOf(pid: number): number[] {
  const groups = new Set<number>([pid]);
  let table: string;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2000 });
  } catch {
    return [...groups];
  }
  const children = new Map<number, Array<{ pid: number; pgid: number }>>();
  for (const line of table.split('\n')) {
    const [cpid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (!cpid || !ppid || !pgid) continue;
    const list = children.get(ppid) ?? [];
    list.push({ pid: cpid, pgid });
    children.set(ppid, list);
  }
  const queue = [pid];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      groups.add(child.pgid);
    }
  }
  // Never our own group, and never init's.
  groups.delete(process.pid);
  for (const g of groups) if (g <= 1) groups.delete(g);
  return [...groups];
}

function signalGroups(groups: number[], signal: NodeJS.Signals): void {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, signal);
    } catch {
      /* that group is already gone */
    }
  }
}

/**
 * Send a signal to a worker's whole process tree (see processGroupsOf). The
 * worker leads its own group on POSIX (spawned detached). Windows has no
 * groups to signal, so `taskkill /T` walks the tree (and /F, as there is no
 * SIGTERM). Returns the groups it signalled.
 */
export function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): number[] {
  const pid = proc.pid;
  if (!pid) {
    proc.kill(signal);
    return [];
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      .on('error', (err) => console.warn(`[ClaudeWorker] taskkill ${pid} failed: ${err.message}`));
    return [];
  }
  const groups = processGroupsOf(pid);
  signalGroups(groups, signal);
  return groups;
}

/**
 * SIGTERM a worker's tree, then SIGKILL what is left after `graceMs`.
 *
 * The fallback reuses the groups found at SIGTERM time: once the worker dies
 * its children are reparented and can no longer be found through it. It
 * decides by group, not by looking a pid up again — a pid a process released
 * can belong to someone else by then, but a pid is not handed out while a
 * process group with that id still has members, so a group that is still
 * alive is still the one we signalled.
 */
export function terminateProcessTree(proc: ChildProcess, graceMs = WORKER_KILL_GRACE_MS): void {
  const groups = signalProcessTree(proc, 'SIGTERM');
  // taskkill /F is already final, and a pid-less process has no group.
  if (groups.length === 0) return;
  const fallback = setTimeout(() => {
    signalGroups(groups.filter(processGroupAlive), 'SIGKILL');
  }, graceMs);
  fallback.unref?.();
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Background Claude Code worker — spawns CLI in stream-json mode
 * to execute A2A tasks without touching the PTY terminal.
 */
export class ClaudeWorker {
  private readonly sessions = new Map<string, WorkerSession>();
  /** Tasks between the capacity check and their session being registered. */
  private readonly reserved = new Set<string>();
  private readonly getWindow: GetWindow;
  private readonly getDaemonClient: GetDaemonClient;

  constructor(getWindow: GetWindow, getDaemonClient?: GetDaemonClient) {
    this.getWindow = getWindow;
    // envelope PR4 C12: 전이 정본은 데몬 로그 — 미주입(구 배선/테스트)이면 렌더러
    // 직행 폴백만 남는다(현행 동작 보존).
    this.getDaemonClient = getDaemonClient ?? (() => null);
  }

  get isFull(): boolean {
    return this.sessions.size + this.reserved.size >= MAX_CONCURRENT;
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
    // One run per task: a second execute would overwrite the session and leave
    // the first process running with nothing tracking it.
    if (this.sessions.has(taskId) || this.reserved.has(taskId)) {
      console.warn(`[ClaudeWorker] task=${taskId} is already running; ignoring a second execute`);
      return;
    }
    if (this.isFull) {
      const reason = 'Worker at capacity';
      await this.updateTaskStatus(taskId, receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
      return;
    }

    // Hold the slot across the await below. Checked-then-registered-later, a
    // burst of approvals all passed the capacity check before any of them
    // registered, and more than MAX_CONCURRENT ran.
    this.reserved.add(taskId);
    let proc: ChildProcess;
    let session: WorkerSession;
    try {
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
      proc = spawn('claude', args, {
        cwd: cwd || undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...accountEnv },
        // Its own process group, so the whole tree can be stopped (see
        // signalProcessTree). Not on Windows, where it means a new console.
        detached: process.platform !== 'win32',
      });

      session = {
        proc,
        taskId,
        receiverWorkspaceId,
        lineBuffer: '',
        sessionId: null,
      };
      this.sessions.set(taskId, session);
    } catch (err) {
      const reason = `Spawn error: ${err instanceof Error ? err.message : String(err)}`;
      await this.updateTaskStatus(taskId, receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
      return;
    } finally {
      this.reserved.delete(taskId);
    }

    // Every path below settles the task at most once: whichever gets here first
    // takes the session out of the map, and the rest see it gone.
    const isCurrent = () => this.sessions.get(taskId) === session;
    const fail = (reason: string) => {
      this.endSession(session);
      this.updateTaskStatus(taskId, receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
    };
    const stopRun = (reason: string) => {
      if (!isCurrent()) return;
      fail(reason);
      terminateProcessTree(proc);
    };
    const armIdleTimer = () => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(
        () => stopRun(`Worker produced no output for ${WORKER_IDLE_TIMEOUT_MS / 60_000} min and was stopped`),
        WORKER_IDLE_TIMEOUT_MS,
      );
      session.idleTimer.unref?.();
    };
    armIdleTimer();
    session.hardTimer = setTimeout(
      () => stopRun(`Worker ran past the ${WORKER_HARD_TIMEOUT_MS / 3_600_000} h limit and was stopped`),
      WORKER_HARD_TIMEOUT_MS,
    );
    session.hardTimer.unref?.();

    // A worker that dies before reading its input turns the write into EPIPE on
    // this stream; without a listener that is an uncaught error in main. The
    // exit itself is reported by the exit/close handlers below.
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
      // A run already settled (timed out, cancelled) can still flush a result
      // line as it dies; that must not become a second transition.
      if (!isCurrent()) return;
      armIdleTimer();
      session.lineBuffer += chunk.toString();

      if (session.lineBuffer.length > MAX_BUFFER_BYTES) {
        console.error(`[ClaudeWorker] Buffer overflow for task ${taskId}, destroying`);
        stopRun('Worker output exceeded 10 MB and was stopped');
        return;
      }

      let newlineIndex: number;
      while (isCurrent() && (newlineIndex = session.lineBuffer.indexOf('\n')) !== -1) {
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
      if (!isCurrent()) return;
      fail(`Spawn error: ${err.message}`);
    });

    // Still current at exit means no result line arrived. A clean exit without
    // one is a failure too — reporting nothing left the task in `working`.
    const settleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!isCurrent()) return;
      fail(code === 0
        ? 'Worker exited without a result'
        : `Process exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
    };
    proc.on('exit', (code, signal) => {
      if (!isCurrent()) return;
      // 'close' waits for stdout to close, and a child that inherited it can
      // hold it open long after claude is gone. Give it a moment to deliver a
      // final result line, then settle on the exit and stop what is left.
      session.drainTimer = setTimeout(() => {
        if (!isCurrent()) return;
        settleExit(code, signal);
        terminateProcessTree(proc);
      }, WORKER_EXIT_DRAIN_MS);
      session.drainTimer.unref?.();
    });
    proc.on('close', (code, signal) => settleExit(code, signal));
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
    terminateProcessTree(session.proc);

    return true;
  }

  /** Drop a session and its timers. */
  private endSession(session: WorkerSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.hardTimer) clearTimeout(session.hardTimer);
    if (session.drainTimer) clearTimeout(session.drainTimer);
    if (this.sessions.get(session.taskId) === session) this.sessions.delete(session.taskId);
  }

  /**
   * Stop all running tasks (graceful shutdown).
   */
  stop(): void {
    // Called on quit, synchronously, just before the process exits: a delayed
    // SIGKILL fallback would never fire, and a worker group runs detached, so
    // anything a SIGTERM did not end would outlive wmux. Kill outright — the
    // results have nowhere left to go — and fail the tasks rather than leave
    // them in `working` (best effort; the daemon may still record it).
    for (const session of [...this.sessions.values()]) {
      console.log(`[ClaudeWorker] Stopping task ${session.taskId}`);
      this.endSession(session);
      signalProcessTree(session.proc, 'SIGKILL');
      const reason = 'wmux quit while the worker was running';
      void this.updateTaskStatus(session.taskId, session.receiverWorkspaceId, 'failed', reason, { summary: reason, items: [] });
    }
  }
}
