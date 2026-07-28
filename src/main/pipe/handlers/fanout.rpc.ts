// ─── task.fanout.start — fan-out on the pipe / MCP surface ─────────────────
//
// J1 fan-out (one prompt → N isolated worktree tasks) was renderer-only: the
// GUI modal invoked `fanout:start` over ipcMain and the pipe RpcRouter had no
// registration, so an MCP client could not run one. This handler is that
// registration — but it is NOT "the IPC handler with a router line". The IPC
// path trusts every field because a human typed it into the modal; the wire
// does not. So this handler builds a FanOutRequest from a STRICT SUBSET of
// caller input plus server-derived values, and shares the IPC path's
// FanOutService instance (idempotency is an instance property).
//
// The gates, in order:
//
//   R4 origin allowlist — `ctx.origin === 'local'` or reject. Verbatim from the
//      a2a execute precedent (a2a.rpc.ts): fan-out spawns N processes and
//      mutates a git repository, so remote/undefined/unknown fail closed.
//   R2 identity — verifiedWorkspaceId is RESOLVED from senderPtyId via the
//      renderer (the D5 anchor a2a.channel.* mutations use), never read from
//      params. An unresolvable caller gets nothing. `memberId` is likewise not
//      a wire field: it is the caller's coordinate in the mission-channel
//      roster, and accepting it without the reserved-identity guards would let
//      a caller stamp its missions under someone else's name.
//   R3 repo confinement — the fan-out repo is the git toplevel of the CALLER's
//      own workspace cwd, realpath'd. `repoPath` is NOT a wire field: a
//      caller-supplied one is REJECTED, not ignored, because silently ignoring
//      it would let a caller believe it fanned out over repo B when it actually
//      fanned out over repo A.
//   R1 agentCmd — never read from the wire. FanOutService.buildInitialCommand
//      interpolates it UNQUOTED into `<agentCmd> "$(cat '<path>')"` and writes
//      that to a PTY, so a wire value is plain shell injection. Forced to
//      FANOUT_WIRE_AGENT_CMD. (The prompt body itself never reaches the shell
//      parser: it goes to prompt.md, read back through a single-quoted path.)
//   R5/R6 caps — N ≤ FANOUT_MAX_TASKS, effective prompt ≤
//      FANOUT_PROMPT_MAX_BYTES, title ≤ CHANNEL_TOPIC_MAX, checked here (not
//      only inside the service) so the wire gets a wire-shaped rejection and an
//      oversized array is bounded before any per-element work.
//   R7 approval — see below.
//
// Asynchrony is forced, not chosen: the MCP client's RPC deadline is 10s
// (wmux-client.ts) and one task's renderer spawn alone is allowed 30s. So the
// call is accept-then-poll — re-send the same idempotencyKey to get
// awaiting_approval / running / completed / denied. The poll answer comes from
// FanOutService's existing G1 bookkeeping plus the gate map below.
//
// R7 — fan-out DOES ask the user, and the ask is NOT the a2a execute gate:
//
//   * It reuses the execute approval queue and dialog (one inbox, one timer),
//     but it goes through requestFanOutApproval, which does NOT consult
//     `a2aAutoApproveExecute`. That toggle is consent for A2A background
//     execution; it is not consent for creating N git worktrees and branches,
//     and letting it cover fan-out would silently widen a setting the user
//     agreed to for a different action.
//   * Because the call is async, the prompt no longer blocks the caller — so
//     the 30s auto-deny costs nothing except the fan-out. But it must not cost
//     it SILENTLY: an unattended fleet learns via the poll, which reports
//     `status: 'denied'` with the reason (declined / timeout / unavailable)
//     rather than letting the key go quiet.
//
// Residual: `senderPtyId` arrives in params, not from the connection peer PID,
// so a same-user process can forge it — the #113 ceiling documented at length
// in a2a.channel.rpc.ts. Attribution here is advisory in exactly the same way;
// this handler is no weaker and no stronger than the channel surface it mirrors.

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { HUMAN_WORKSPACE_ID, CHANNEL_TOPIC_MAX } from '../../../shared/channels';
import {
  FANOUT_MAX_TASKS,
  FANOUT_PROMPT_MAX_BYTES,
  WORKTASK_IDEMPOTENCY_CAP,
} from '../../../shared/workTask';
import { sendToRenderer } from './_bridge';
import { git as runGit } from '../../git/git';
import type { FanOutRequest, FanOutService } from '../../worktask/FanOutService';

type GetWindow = () => BrowserWindow | null;

/**
 * R1 — the agent command wire callers get, always. NEVER read from params:
 * FanOutService.buildInitialCommand interpolates this verbatim into
 * `${agentCmd} "$(cat '<path>')"` and writes it to a PTY, so a caller-supplied
 * value is arbitrary command execution. This matches the value the GUI modal
 * pre-fills, so wire and GUI fan-outs launch the same agent.
 */
export const FANOUT_WIRE_AGENT_CMD = 'claude';

/** The renderer prompt auto-denies at 30s. The wire call no longer waits on the
 *  verdict (accept-then-poll), so this deadline only bounds how long the
 *  detached approval hop may hang before we record the fan-out as denied. */
const APPROVAL_TIMEOUT_MS = 45_000;

/** Why a fan-out never started. Reported on the poll so an unattended fleet
 *  learns WHY instead of watching a key go quiet. */
export type FanOutDenyReason = 'declined' | 'timeout' | 'unavailable';

const DENY_MESSAGE: Record<FanOutDenyReason, string> = {
  declined: 'the user denied the fan-out approval prompt',
  timeout: 'the fan-out approval prompt expired with no answer (no one was at the keyboard)',
  unavailable: 'the fan-out approval prompt could not be shown (the wmux window is unavailable)',
};

/**
 * Pre-start half of the poll contract. FanOutService owns the post-start half
 * (running / done); everything before `start()` is called lives here:
 *
 *   awaiting — accepted, approval prompt is up
 *   denied   — terminal, never started, carries the reason
 *   started  — start() was called; the service is the authority from here on.
 *              Kept so that a poll arriving AFTER the service's result LRU has
 *              evicted the key answers "expired" instead of restarting a
 *              fan-out that already spawned tasks.
 */
type GateState =
  | { phase: 'awaiting' }
  | { phase: 'denied'; reason: FanOutDenyReason }
  | { phase: 'started' };

/** Typed wire error, shaped like the a2a.channel.* / task.mission.* envelope so
 *  MCP tools can branch on `error.code` instead of parsing a message. */
function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

/** Reject obviously hostile path input before it reaches `git` as a cwd.
 *  Belt-and-braces: the path is passed as a child-process cwd, never as an
 *  argv element, so this is not the load-bearing defence (R3's toplevel
 *  comparison is) — it just keeps control characters and flag-looking strings
 *  out of the process table and the logs. */
function normalizeRepoInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('-')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return path.resolve(trimmed);
}

/**
 * git toplevel of `dir`, realpath'd, or null. `--show-toplevel` so any
 * subdirectory of the caller's repo normalises to the same answer, and realpath
 * so a symlinked worktree cannot alias a different repository.
 */
async function repoRootOf(dir: string): Promise<string | null> {
  const res = await runGit(['rev-parse', '--show-toplevel'], dir);
  if (res.code !== 0) return null;
  const top = res.stdout.trim();
  if (top.length === 0) return null;
  try {
    return fs.realpathSync(top);
  } catch {
    return top;
  }
}

/**
 * R2 — resolve the caller's workspace from a verified senderPtyId. Identical
 * anchor + resolution to a2a.channel.rpc.ts (the renderer answers which
 * workspace owns that pty RIGHT NOW). '' when unresolvable.
 */
async function resolveCallerWorkspace(
  getWindow: GetWindow,
  params: Record<string, unknown>,
): Promise<string> {
  const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'].trim() : '';
  if (!senderPtyId) return '';
  try {
    const owner = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId: senderPtyId });
    const wsId =
      owner && typeof owner === 'object' && 'workspaceId' in owner
        ? (owner as Record<string, unknown>)['workspaceId']
        : null;
    return typeof wsId === 'string' && wsId ? wsId : '';
  } catch {
    // Renderer unavailable (early boot / reload) — unresolvable, fail closed.
    return '';
  }
}

/** The caller workspace's cwd, from the same renderer projection the GUI modal
 *  reads its default repo from (`workspace.list` → metadata.cwd). */
async function resolveWorkspaceCwd(getWindow: GetWindow, workspaceId: string): Promise<string> {
  let list: unknown;
  try {
    list = await sendToRenderer(getWindow, 'workspace.list');
  } catch {
    return '';
  }
  if (!Array.isArray(list)) return '';
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; metadata?: { cwd?: unknown } };
    if (e.id !== workspaceId) continue;
    const cwd = e.metadata?.cwd;
    return typeof cwd === 'string' ? cwd.trim() : '';
  }
  return '';
}

/** Parsed + capped task list. `titles[k]` pairs with `taskPrompts[k]`. */
interface ParsedTasks {
  titles: string[];
  taskPrompts: string[];
}

/**
 * R5/R6 — validate the task list against the SAME caps the GUI enforces.
 * Pairing happens before filtering so a non-string title cannot shift a task's
 * prompt onto its neighbour (the regression fanout.handler's normalizeRequest
 * fixed on the IPC side).
 */
function parseTasks(
  params: Record<string, unknown>,
  sharedPrompt: string,
): ParsedTasks | { error: string } {
  const rawTitles = params['titles'];
  if (!Array.isArray(rawTitles)) return { error: 'titles must be an array of task titles' };
  // Bound the RAW length before any per-element work — an oversized array is
  // rejected on length, not after N trims.
  if (rawTitles.length > FANOUT_MAX_TASKS) {
    return { error: `task count ${rawTitles.length} exceeds the cap of ${FANOUT_MAX_TASKS}` };
  }
  if (params['taskPrompts'] !== undefined && !Array.isArray(params['taskPrompts'])) {
    return { error: 'taskPrompts must be an array of strings when provided' };
  }
  const rawPrompts = Array.isArray(params['taskPrompts']) ? (params['taskPrompts'] as unknown[]) : [];
  if (rawPrompts.length > FANOUT_MAX_TASKS) {
    return { error: `taskPrompts length ${rawPrompts.length} exceeds the cap of ${FANOUT_MAX_TASKS}` };
  }

  const paired = rawTitles
    .map((t, k) => ({
      title: typeof t === 'string' ? t.trim() : '',
      taskPrompt: typeof rawPrompts[k] === 'string' ? (rawPrompts[k] as string).trim() : '',
    }))
    .filter((e) => e.title.length > 0);

  if (paired.length === 0) return { error: 'at least one non-empty task title is required' };

  for (const [k, e] of paired.entries()) {
    if (e.title.length > CHANNEL_TOPIC_MAX) {
      return { error: `task ${k + 1} title exceeds ${CHANNEL_TOPIC_MAX} characters` };
    }
    // The EFFECTIVE prompt is what FanOutService will actually write to disk
    // and interpolate: shared + per-task, empty side dropped.
    const combined = [sharedPrompt, e.taskPrompt].filter((p) => p.length > 0).join('\n\n');
    if (Buffer.byteLength(combined, 'utf8') > FANOUT_PROMPT_MAX_BYTES) {
      return {
        error: `task ${k + 1} prompt exceeds ${FANOUT_PROMPT_MAX_BYTES} bytes; shorten it and reference details from a file path`,
      };
    }
  }

  return {
    titles: paired.map((e) => e.title),
    taskPrompts: paired.map((e) => e.taskPrompt),
  };
}

/**
 * Register `task.fanout.start`. `service` MUST be the same instance the
 * renderer IPC handler uses — see worktask/createFanOutService.ts.
 */
export function registerFanOutRpc(router: RpcRouter, service: FanOutService, getWindow: GetWindow): void {
  // Gate bookkeeping lives in this closure rather than at module scope: it is
  // per-router state, and a fresh map per registration keeps tests isolated.
  const gates = new Map<string, GateState>();
  /** Insertion-ordered LRU, same cap as the service's own result LRU. */
  const setGate = (key: string, state: GateState): void => {
    gates.delete(key);
    gates.set(key, state);
    while (gates.size > WORKTASK_IDEMPOTENCY_CAP) {
      const oldest = gates.keys().next();
      if (oldest.done) break;
      gates.delete(oldest.value);
    }
  };

  router.register('task.fanout.start', async (params, ctx?: RpcContext) => {
    // ── R4: origin allowlist, fail-closed ────────────────────────────────
    // local + nothing else. `origin` is a REQUIRED RpcContext field, so a
    // future remote transport cannot silently inherit fan-out by forgetting to
    // classify itself. Same lane as the a2a execute spawn.
    if (ctx?.origin !== 'local') {
      return deny('NOT_AUTHORIZED', 'task.fanout.start is local-origin only (remote callers cannot spawn tasks)');
    }

    const callerKey = typeof params['idempotencyKey'] === 'string' ? params['idempotencyKey'].trim() : '';
    if (!callerKey) {
      return deny(
        'INVALID_ARGUMENT',
        'task.fanout.start requires an idempotencyKey — it is also the handle you poll this fan-out with',
      );
    }

    // ── R2: caller identity, server-resolved ─────────────────────────────
    // Resolved BEFORE the poll branch on purpose: the poll answer carries the
    // full FanOutResult (task ids, branches, worktree paths), so it has to be
    // scoped to the workspace that started the fan-out. Keys are caller-chosen
    // strings; without the scoping below, guessing "fanout-1" would read a
    // neighbouring workspace's result.
    const callerWorkspaceId = await resolveCallerWorkspace(getWindow, params);
    if (!callerWorkspaceId) {
      return deny(
        'NOT_AUTHORIZED',
        'task.fanout.start requires a verifiable caller (no resolvable senderPtyId)',
      );
    }
    // Defence in depth: ws-human owns no panes, so no senderPtyId can resolve
    // into it — but the reserved human workspace must never own agent-created
    // tasks, and this stays symmetric with a2a.channel.rpc.ts's guards.
    if (callerWorkspaceId === HUMAN_WORKSPACE_ID) {
      return deny(
        'NOT_AUTHORIZED',
        `'${HUMAN_WORKSPACE_ID}' is the reserved human workspace and cannot fan out from the pipe`,
      );
    }
    /** Per-workspace key space (see above). The GUI mints uuid keys of its own,
     *  so a wire caller also cannot collide with an in-flight GUI fan-out. */
    const key = `${callerWorkspaceId}::${callerKey}`;

    // ── Poll branch ──────────────────────────────────────────────────────
    // A repeat of a key we already know answers from bookkeeping and starts
    // nothing. This is the whole poll protocol.
    const known = service.statusOf(key);
    if (known.state === 'running') {
      return { ok: true as const, status: 'running' as const, idempotencyKey: callerKey };
    }
    if (known.state === 'done') {
      return {
        ok: true as const,
        status: 'completed' as const,
        idempotencyKey: callerKey,
        result: known.result,
      };
    }
    const gate = gates.get(key);
    if (gate?.phase === 'awaiting') {
      return { ok: true as const, status: 'awaiting_approval' as const, idempotencyKey: callerKey };
    }
    if (gate?.phase === 'denied') {
      return {
        ok: false as const,
        status: 'denied' as const,
        idempotencyKey: callerKey,
        reason: gate.reason,
        error: { code: 'NOT_AUTHORIZED', message: `fan-out was not approved: ${DENY_MESSAGE[gate.reason]}` },
      };
    }
    if (gate?.phase === 'started') {
      // Started, and the service's result LRU has since evicted the key. The
      // one thing we must NOT do is treat this as a new request.
      return {
        ok: false as const,
        status: 'expired' as const,
        idempotencyKey: callerKey,
        error: {
          code: 'NOT_FOUND',
          message: 'this fan-out already ran and its result is no longer retained; list your missions instead',
        },
      };
    }

    // ── Fields the renderer may state but a wire caller may not ──────────
    // Rejected loudly rather than dropped: a caller that believes it chose the
    // repository, the agent command or its own member coordinate, and was
    // silently overruled, is a caller acting on a false picture.
    if (params['repoPath'] !== undefined) {
      return deny(
        'INVALID_ARGUMENT',
        "task.fanout.start does not accept repoPath — the repository is derived from the calling workspace's own working directory",
      );
    }
    if (params['agentCmd'] !== undefined) {
      return deny(
        'INVALID_ARGUMENT',
        'task.fanout.start does not accept agentCmd — the pipe surface always uses the default agent command',
      );
    }
    if (params['memberId'] !== undefined) {
      return deny(
        'INVALID_ARGUMENT',
        'task.fanout.start does not accept memberId — your mission-channel coordinate is your resolved workspace',
      );
    }

    // ── R3: repo confinement ─────────────────────────────────────────────
    const callerCwd = await resolveWorkspaceCwd(getWindow, callerWorkspaceId);
    if (!callerCwd) {
      return deny(
        'FAILED_PRECONDITION',
        `workspace ${callerWorkspaceId} has no working directory to fan out from`,
      );
    }
    const callerCwdResolved = normalizeRepoInput(callerCwd);
    if (!callerCwdResolved) {
      return deny('FAILED_PRECONDITION', `workspace ${callerWorkspaceId} has an unusable working directory`);
    }
    const callerRepoRoot = await repoRootOf(callerCwdResolved);
    if (!callerRepoRoot) {
      return deny(
        'FAILED_PRECONDITION',
        `the calling workspace's directory is not inside a git repository: ${callerCwdResolved}`,
      );
    }

    // ── R5/R6: caps ──────────────────────────────────────────────────────
    const sharedPrompt = typeof params['prompt'] === 'string' ? params['prompt'].trim() : '';
    if (Buffer.byteLength(sharedPrompt, 'utf8') > FANOUT_PROMPT_MAX_BYTES) {
      return deny('INVALID_ARGUMENT', `prompt exceeds ${FANOUT_PROMPT_MAX_BYTES} bytes`);
    }
    const parsed = parseTasks(params, sharedPrompt);
    if ('error' in parsed) return deny('INVALID_ARGUMENT', parsed.error);

    // ── Build the request from SERVER-DERIVED values only ────────────────
    // Note what is absent: agentCmd (R1), verifiedWorkspaceId and memberId
    // (R2), repoPath (R3). The request is constructed field by field — params
    // is never spread — so a field added to the wire later cannot leak through
    // by accident.
    const req: FanOutRequest = {
      idempotencyKey: key,
      prompt: sharedPrompt,
      titles: parsed.titles,
      taskPrompts: parsed.taskPrompts,
      repoPath: callerRepoRoot,
      agentCmd: FANOUT_WIRE_AGENT_CMD,
      verifiedWorkspaceId: callerWorkspaceId,
    };

    // ── R7: approval, then the detached run ──────────────────────────────
    // The gate is marked BEFORE returning so a poll that arrives while the
    // prompt is still up answers awaiting_approval instead of raising a second
    // prompt for the same key.
    setGate(key, { phase: 'awaiting' });
    void (async () => {
      let verdict: { approved?: unknown; outcome?: unknown } | null = null;
      try {
        verdict = (await sendToRenderer(
          getWindow,
          'fanout.requestApproval',
          {
            workspaceId: callerWorkspaceId,
            repoPath: callerRepoRoot,
            taskCount: parsed.titles.length,
            promptPreview: [sharedPrompt, ...parsed.titles.map((t) => `- ${t}`)]
              .filter((s) => s.length > 0)
              .join('\n')
              .slice(0, 500),
          },
          { timeoutMs: APPROVAL_TIMEOUT_MS },
        )) as { approved?: unknown; outcome?: unknown } | null;
      } catch {
        // Renderer unavailable / bridge timeout. Fail closed — an unattended
        // spawn is exactly what the gate exists to prevent — but record WHY.
        verdict = null;
      }

      if (!verdict || verdict.approved !== true) {
        const reason: FanOutDenyReason =
          !verdict ? 'unavailable' : verdict.outcome === 'timeout' ? 'timeout' : 'declined';
        setGate(key, { phase: 'denied', reason });
        console.warn(`[fanout.rpc] fan-out ${key} denied (${reason})`);
        return;
      }

      // start() registers the key in-flight synchronously, before its first
      // await, so there is no window in which the gate says 'started' and the
      // service still says 'unknown'.
      setGate(key, { phase: 'started' });
      try {
        await service.start(req);
      } catch (err) {
        // start() records a throw as a failed result rather than releasing the
        // key, so this is belt-and-braces.
        console.error(`[fanout.rpc] fan-out ${key} failed:`, err);
      }
    })();

    return {
      ok: true as const,
      status: 'accepted' as const,
      idempotencyKey: callerKey,
      taskCount: parsed.titles.length,
      repoPath: callerRepoRoot,
      workspaceId: callerWorkspaceId,
    };
  });
}
