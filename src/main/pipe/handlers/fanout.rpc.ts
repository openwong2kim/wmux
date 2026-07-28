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
//      params — sending one is REJECTED, on the same reasoning as repoPath
//      below. An unresolvable caller gets nothing. `memberId` is likewise not
//      a wire field: it is the caller's coordinate in the mission-channel
//      roster, and accepting it without the reserved-identity guards would let
//      a caller stamp its missions under someone else's name.
//   R3 repo confinement — the fan-out repo is the git toplevel of the cwd of
//      the CALLER'S OWN SURFACE (the pane whose ptyId === senderPtyId),
//      realpath'd, and re-derived once more after the approval so the repo the
//      user saw is the repo that gets mutated. `repoPath` is NOT a wire field:
//      a caller-supplied one is REJECTED, not ignored, because silently
//      ignoring it would let a caller believe it fanned out over repo B when it
//      actually fanned out over repo A.
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
//     `status: 'denied'` with the reason (declined / timeout / unavailable /
//     repo-moved) rather than letting the key go quiet.
//   * The prompt shows the EFFECTIVE prompt of every task — shared + per-task,
//     exactly what each agent is handed — and says so in bytes when it has to
//     cut. A preview built from the shared prompt alone can be filled with 500
//     benign characters while the real instructions ride in `taskPrompts`, and
//     an approval given to a preview that does not contain the instructions is
//     not consent (see buildFanOutPreview).
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

/**
 * Upper bound on a caller-chosen idempotency key. The key is retained in the
 * gate maps below AND captured by every detached approval closure, so an
 * unbounded one is a memory amplifier that also lands verbatim in the daemon
 * log. 128 bytes fits every uuid/ulid shape a caller would legitimately mint.
 */
export const FANOUT_IDEMPOTENCY_KEY_MAX_BYTES = 128;

/** How many TERMINAL keys are remembered. Body-free, so it is set far above the
 *  result LRU — see the tombstone note in registerFanOutRpc. */
export const FANOUT_TOMBSTONE_CAP = 10_000;

/** Total byte budget for the approval preview, split evenly across tasks so no
 *  single task's prompt can crowd the others out of the dialog. */
export const FANOUT_PREVIEW_MAX_BYTES = 4096;
/** …but never below this per task, so a max-size fan-out still shows each
 *  task's opening instructions rather than a line of ellipses. */
const FANOUT_PREVIEW_MIN_TASK_BYTES = 256;

/** Why a fan-out never started. Reported on the poll so an unattended fleet
 *  learns WHY instead of watching a key go quiet. */
export type FanOutDenyReason = 'declined' | 'timeout' | 'unavailable' | 'repo-moved';

const DENY_MESSAGE: Record<FanOutDenyReason, string> = {
  declined: 'the user denied the fan-out approval prompt',
  timeout: 'the fan-out approval prompt expired with no answer (no one was at the keyboard)',
  unavailable: 'the fan-out approval prompt could not be shown (the wmux window is unavailable)',
  'repo-moved':
    "the calling terminal's repository changed between the request and the approval, so the approved repository is no longer the one that would be modified",
};

/**
 * Cut `s` to `maxBytes` of UTF-8 and SAY SO. The byte count is the point: a
 * preview that just stops is indistinguishable from a prompt that ended, which
 * is precisely how a truncated preview launders instructions past the user.
 */
function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  // Slicing mid-codepoint yields a trailing U+FFFD — drop it rather than show
  // the user a corrupted last character.
  let head = buf.subarray(0, maxBytes).toString('utf8');
  if (head.endsWith('�')) head = head.slice(0, -1);
  const dropped = buf.byteLength - Buffer.byteLength(head, 'utf8');
  return `${head}\n…(${dropped} bytes truncated)`;
}

/**
 * The approval preview: one block per task carrying that task's EFFECTIVE
 * prompt — shared + its own, joined exactly as FanOutService will join them.
 *
 * The predecessor built this from `[sharedPrompt, ...titles]`, which omitted
 * `taskPrompts` entirely. Since each task's prompt may be FANOUT_PROMPT_MAX_BYTES
 * (8 KB) on its own, that let a caller park 500 harmless characters in the
 * shared prompt and put the real instructions in the per-task ones: the user
 * approved N autonomous agents without seeing a character of what they were
 * told. Titles alone are not instructions, and a preview is not consent unless
 * it contains what is actually injected.
 */
export function buildFanOutPreview(sharedPrompt: string, titles: string[], taskPrompts: string[]): string {
  const perTask = Math.max(
    FANOUT_PREVIEW_MIN_TASK_BYTES,
    Math.floor(FANOUT_PREVIEW_MAX_BYTES / Math.max(1, titles.length)),
  );
  return titles
    .map((title, k) => {
      const own = typeof taskPrompts[k] === 'string' ? taskPrompts[k] : '';
      const effective = [sharedPrompt, own].filter((p) => p.length > 0).join('\n\n');
      const body =
        effective.length > 0
          ? truncateUtf8(effective, perTask)
          : '(no prompt — this task opens an agent pane with nothing typed into it)';
      return `── task ${k + 1}/${titles.length}: ${title}\n${body}`;
    })
    .join('\n\n');
}

/**
 * Pre-start half of the poll contract. FanOutService owns the post-start half
 * (running / done); everything before `start()` is called lives here:
 *
 *   awaiting — accepted, approval prompt is up. Evictable: it holds nothing a
 *              re-request cannot rebuild, and a double spawn is still blocked
 *              by FanOutService's own in-flight/result idempotency.
 *   denied   — TERMINAL, never started, carries the reason
 *   started  — TERMINAL, start() was called; the service is the authority from
 *              here on. Kept so that a poll arriving AFTER the service's result
 *              LRU has evicted the key answers "expired" instead of restarting
 *              a fan-out that already spawned tasks.
 */
type GateState = { phase: 'awaiting' };
type Tombstone = { phase: 'denied'; reason: FanOutDenyReason } | { phase: 'started' };

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
async function resolveCallerWorkspace(getWindow: GetWindow, senderPtyId: string): Promise<string> {
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

/**
 * R3 — the cwd of the CALLER'S OWN SURFACE: the pane whose ptyId is the
 * senderPtyId we just verified, and that surface's live cwd (OSC 7 / prompt
 * scrape), via `surface.list`.
 *
 * NOT `workspace.list` → `metadata.cwd`. That value is workspace-scoped and
 * tracks whichever surface last changed directory, so reading it would let a
 * SIBLING pane in the caller's workspace choose the repository that the caller
 * fans out over — a target the caller never touched. Per-surface is also what
 * the dialog's `repo:` line then describes: the directory of the terminal that
 * asked.
 *
 * Residual (the renderer's, not this handler's): `surface.list` reports
 * `s.cwd || workspace.metadata.cwd`, so a surface that has never emitted a cwd
 * at all still reads the workspace-level value. A caller in that state is a
 * caller whose own shell reports no directory; narrowing it further belongs in
 * the surface projection, not here.
 */
async function resolveSenderSurfaceCwd(
  getWindow: GetWindow,
  workspaceId: string,
  senderPtyId: string,
): Promise<string> {
  let surfaces: unknown;
  try {
    surfaces = await sendToRenderer(getWindow, 'surface.list', { workspaceId });
  } catch {
    return '';
  }
  if (!Array.isArray(surfaces)) return '';
  for (const entry of surfaces) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (row['ptyId'] !== senderPtyId) continue;
    return typeof row['cwd'] === 'string' ? row['cwd'].trim() : '';
  }
  return '';
}

/** R3, end to end: caller's surface → cwd → git toplevel. Returns the root, or
 *  the wire error to answer with. One function because the SAME derivation runs
 *  twice — once before the prompt and once after the approval — and a second
 *  copy would be a second thing to keep in step. */
async function deriveCallerRepoRoot(
  getWindow: GetWindow,
  workspaceId: string,
  senderPtyId: string,
): Promise<{ root: string } | { code: string; message: string }> {
  const cwd = await resolveSenderSurfaceCwd(getWindow, workspaceId, senderPtyId);
  if (!cwd) {
    return {
      code: 'FAILED_PRECONDITION',
      message:
        "task.fanout.start could not determine the calling terminal's working directory — run the caller inside a pane whose cwd is a git repository",
    };
  }
  const resolved = normalizeRepoInput(cwd);
  if (!resolved) {
    return { code: 'FAILED_PRECONDITION', message: `the calling terminal has an unusable working directory` };
  }
  const root = await repoRootOf(resolved);
  if (!root) {
    return {
      code: 'FAILED_PRECONDITION',
      message: `the calling terminal's directory is not inside a git repository: ${resolved}`,
    };
  }
  return { root };
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
  //
  // TWO maps, not one, and that split is the whole point. A single LRU evicted
  // its oldest entry regardless of phase, so a `started` or `denied` key could
  // fall out of BOTH this map and FanOutService's result LRU — after which
  // `statusOf` said `unknown`, the poll fell through as a NEW request, and the
  // caller got a fresh approval prompt and a full re-execution of tasks that
  // had already spawned. Terminal states therefore live in a separate map that
  // holds no result body (a phase and at most a reason), so retaining far more
  // of them costs almost nothing.
  const pending = new Map<string, GateState>();
  const terminal = new Map<string, Tombstone>();

  /** Insertion-ordered LRU over the AWAITING keys only. */
  const claim = (key: string): void => {
    pending.delete(key);
    pending.set(key, { phase: 'awaiting' });
    while (pending.size > WORKTASK_IDEMPOTENCY_CAP) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
    }
  };

  /**
   * Move a key to its terminal state. Body-free tombstones, capped an order of
   * magnitude above the result LRU: with keys bounded at
   * FANOUT_IDEMPOTENCY_KEY_MAX_BYTES this is a couple of MB at worst, and a
   * session would have to terminate FANOUT_TOMBSTONE_CAP fan-outs (up to
   * FANOUT_MAX_TASKS worktrees each) before the oldest one could return to
   * `unknown`. Residual, deliberately not solved here: tombstones are
   * per-process, so a poll that survives an app restart still reads `unknown`
   * — restart-safety needs durable state the service side does not have
   * either, and is a separate change.
   */
  const settle = (key: string, state: Tombstone): void => {
    pending.delete(key);
    terminal.delete(key);
    terminal.set(key, state);
    while (terminal.size > FANOUT_TOMBSTONE_CAP) {
      const oldest = terminal.keys().next();
      if (oldest.done) break;
      terminal.delete(oldest.value);
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
    // Bounded before it is retained anywhere (gate maps, detached closures,
    // daemon log). Checked in BYTES because that is what it costs.
    if (Buffer.byteLength(callerKey, 'utf8') > FANOUT_IDEMPOTENCY_KEY_MAX_BYTES) {
      return deny(
        'INVALID_ARGUMENT',
        `idempotencyKey exceeds ${FANOUT_IDEMPOTENCY_KEY_MAX_BYTES} bytes — it is a handle, not a payload`,
      );
    }

    // ── R2: caller identity, server-resolved ─────────────────────────────
    // Resolved BEFORE the poll branch on purpose: the poll answer carries the
    // full FanOutResult (task ids, branches, worktree paths), so it has to be
    // scoped to the workspace that started the fan-out. Keys are caller-chosen
    // strings; without the scoping below, guessing "fanout-1" would read a
    // neighbouring workspace's result.
    const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'].trim() : '';
    const callerWorkspaceId = await resolveCallerWorkspace(getWindow, senderPtyId);
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
    //
    // Everything from here to the `claim(key)` below is SYNCHRONOUS on purpose.
    // The gate used to be set after two renderer round-trips and a git call, so
    // two concurrent calls on one key both observed no gate and both raised an
    // approval prompt — two visually identical dialogs carrying different
    // payloads. Reading the gate and claiming it in one tick makes the second
    // caller a poll instead.
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
    if (pending.get(key)?.phase === 'awaiting') {
      return { ok: true as const, status: 'awaiting_approval' as const, idempotencyKey: callerKey };
    }
    const gate = terminal.get(key);
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
    // Same class as the three above, and it used to be the one that was merely
    // overwritten in silence — which left a caller believing its tasks were
    // owned by the workspace it named. The stated principle applies to it too.
    if (params['verifiedWorkspaceId'] !== undefined) {
      return deny(
        'INVALID_ARGUMENT',
        'task.fanout.start does not accept verifiedWorkspaceId — your workspace is resolved from your verified terminal',
      );
    }

    // ── R5/R6: caps ──────────────────────────────────────────────────────
    // Before the claim below, so a malformed request never occupies a key.
    const sharedPrompt = typeof params['prompt'] === 'string' ? params['prompt'].trim() : '';
    if (Buffer.byteLength(sharedPrompt, 'utf8') > FANOUT_PROMPT_MAX_BYTES) {
      return deny('INVALID_ARGUMENT', `prompt exceeds ${FANOUT_PROMPT_MAX_BYTES} bytes`);
    }
    const parsed = parseTasks(params, sharedPrompt);
    if ('error' in parsed) return deny('INVALID_ARGUMENT', parsed.error);

    // ── Claim the key ────────────────────────────────────────────────────
    // Last synchronous statement of the tick that read the gate above: from
    // here on a concurrent call on this key is a poll, not a second prompt.
    claim(key);

    // ── R3: repo confinement ─────────────────────────────────────────────
    const preflight = await deriveCallerRepoRoot(getWindow, callerWorkspaceId, senderPtyId);
    if (!('root' in preflight)) {
      // Nothing was started and nothing was asked, so the key must go back —
      // otherwise a transient renderer miss would brick it until eviction.
      pending.delete(key);
      return deny(preflight.code, preflight.message);
    }
    const callerRepoRoot = preflight.root;

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
    // The key is already claimed (above), so a poll that arrives while the
    // prompt is still up answers awaiting_approval instead of raising a second
    // prompt for it.
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
            promptPreview: buildFanOutPreview(sharedPrompt, parsed.titles, parsed.taskPrompts),
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
        settle(key, { phase: 'denied', reason });
        console.warn(`[fanout.rpc] fan-out ${key} denied (${reason})`);
        return;
      }

      // R3, second half. The prompt named a repository and the user approved
      // THAT repository; the call is asynchronous now, so between the preflight
      // and this line the calling terminal may have moved (its own `cd`, or a
      // sibling pane's if the surface reports no cwd of its own). Re-derive and
      // require the same root, or the approval was given for one repo and spent
      // on another.
      const atApproval = await deriveCallerRepoRoot(getWindow, callerWorkspaceId, senderPtyId);
      if (!('root' in atApproval) || atApproval.root !== callerRepoRoot) {
        settle(key, { phase: 'denied', reason: 'repo-moved' });
        console.warn(`[fanout.rpc] fan-out ${key} denied (repo-moved)`);
        return;
      }

      // start() registers the key in-flight synchronously, before its first
      // await, so there is no window in which the gate says 'started' and the
      // service still says 'unknown'.
      settle(key, { phase: 'started' });
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
