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
// Full rationale: plans/fanout-mcp-surface-design.md. The gates, in order:
//
//   R4 origin allowlist — `ctx.origin === 'local'` or reject. Verbatim from the
//      a2a execute precedent (a2a.rpc.ts): fan-out spawns N processes and
//      mutates a git repository, so remote/undefined/unknown fail closed.
//   R2 identity — verifiedWorkspaceId is RESOLVED from senderPtyId via the
//      renderer (the D5 anchor a2a.channel.* mutations use), never read from
//      params. An unresolvable caller gets nothing.
//   R3 repo confinement — the fan-out repo is the git toplevel of the CALLER's
//      own workspace cwd. A caller-supplied repoPath is only allowed to
//      re-state that same repository (compared as realpath'd toplevels).
//   R1 agentCmd — never read from the wire. Interpolated verbatim into a shell
//      line by FanOutService, so accepting it would be arbitrary command
//      execution. Forced to FANOUT_WIRE_AGENT_CMD.
//   R5/R6 caps — N ≤ FANOUT_MAX_TASKS, effective prompt ≤
//      FANOUT_PROMPT_MAX_BYTES, title ≤ CHANNEL_TOPIC_MAX, checked here (not
//      only inside the service) so the wire gets a wire-shaped rejection and
//      an oversized array is bounded before any per-element work.
//
// Asynchrony is forced, not chosen: the MCP client's RPC deadline is 10s
// (wmux-client.ts) and one task's renderer spawn alone is allowed 30s. So the
// call is accept-then-poll — re-send the same idempotencyKey to get
// running/completed. The poll answer is FanOutService's existing G1 LRU.

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { HUMAN_WORKSPACE_ID, CHANNEL_TOPIC_MAX } from '../../../shared/channels';
import { FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES } from '../../../shared/workTask';
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
 * git toplevel of `dir`, realpath'd, or null. Realpath on BOTH sides of the R3
 * comparison so a symlinked path cannot alias a different repository, and
 * `--show-toplevel` so any subdirectory of the caller's repo normalises to the
 * same answer (a prefix match would be defeated by `..` and by symlinks).
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
async function resolveCallerWorkspace(getWindow: GetWindow, params: Record<string, unknown>): Promise<string> {
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
function parseTasks(params: Record<string, unknown>, sharedPrompt: string): ParsedTasks | { error: string } {
  const rawTitles = params['titles'];
  if (!Array.isArray(rawTitles)) return { error: 'titles must be an array of task titles' };
  // Bound the RAW length before any per-element work — an oversized array is
  // rejected on length, not after N trims.
  if (rawTitles.length > FANOUT_MAX_TASKS) {
    return { error: `task count ${rawTitles.length} exceeds the cap of ${FANOUT_MAX_TASKS}` };
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
  if (paired.length > FANOUT_MAX_TASKS) {
    return { error: `task count ${paired.length} exceeds the cap of ${FANOUT_MAX_TASKS}` };
  }

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
 * renderer IPC handler uses — see createFanOutService.ts.
 */
export function registerFanOutRpc(router: RpcRouter, service: FanOutService, getWindow: GetWindow): void {
  router.register('task.fanout.start', async (params, ctx?: RpcContext) => {
    // ── R4: origin allowlist, fail-closed ────────────────────────────────
    // local + nothing else. `origin` is a REQUIRED RpcContext field, so a
    // future remote transport cannot silently inherit fan-out by forgetting to
    // classify itself. Same lane as the a2a execute spawn.
    if (ctx?.origin !== 'local') {
      return deny('NOT_AUTHORIZED', 'task.fanout.start is local-origin only (remote callers cannot spawn tasks)');
    }

    const idempotencyKey = typeof params['idempotencyKey'] === 'string' ? params['idempotencyKey'].trim() : '';
    if (!idempotencyKey) {
      return deny(
        'INVALID_ARGUMENT',
        'task.fanout.start requires an idempotencyKey — it is also the handle you poll this fan-out with',
      );
    }

    // ── Poll branch ──────────────────────────────────────────────────────
    // A repeat of a key we already know answers from the G1 bookkeeping and
    // starts nothing. This is the whole poll protocol (see design §4).
    const known = service.statusOf(idempotencyKey);
    if (known.state === 'running') {
      return { ok: true as const, status: 'running' as const, idempotencyKey };
    }
    if (known.state === 'done') {
      return { ok: true as const, status: 'completed' as const, idempotencyKey, result: known.result };
    }

    // ── R2: caller identity, server-resolved ─────────────────────────────
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
    // A caller-supplied repoPath may only RE-STATE the caller's own repository.
    // Anything else — another checkout, a parent directory, a sibling project —
    // is refused; a wire caller must not be able to create worktrees and
    // branches in a repository it does not already sit in.
    if (params['repoPath'] !== undefined) {
      if (typeof params['repoPath'] !== 'string') {
        return deny('INVALID_ARGUMENT', 'repoPath must be a string when provided');
      }
      const requested = normalizeRepoInput(params['repoPath']);
      const requestedRoot = requested ? await repoRootOf(requested) : null;
      if (!requestedRoot || requestedRoot !== callerRepoRoot) {
        return deny(
          'NOT_AUTHORIZED',
          `repoPath must resolve to the calling workspace's own repository (${callerRepoRoot})`,
        );
      }
    }

    // ── R5/R6: caps ──────────────────────────────────────────────────────
    const sharedPrompt = typeof params['prompt'] === 'string' ? params['prompt'].trim() : '';
    if (Buffer.byteLength(sharedPrompt, 'utf8') > FANOUT_PROMPT_MAX_BYTES) {
      return deny('INVALID_ARGUMENT', `prompt exceeds ${FANOUT_PROMPT_MAX_BYTES} bytes`);
    }
    const parsed = parseTasks(params, sharedPrompt);
    if ('error' in parsed) return deny('INVALID_ARGUMENT', parsed.error);

    // ── Build the request from SERVER-DERIVED values only ────────────────
    // Note what is absent: agentCmd (R1), verifiedWorkspaceId (R2), repoPath
    // (R3), memberId. The request is constructed field by field — params is
    // never spread — so a field added to the wire later cannot leak through by
    // accident.
    const req: FanOutRequest = {
      idempotencyKey,
      prompt: sharedPrompt,
      titles: parsed.titles,
      taskPrompts: parsed.taskPrompts,
      repoPath: callerRepoRoot,
      agentCmd: FANOUT_WIRE_AGENT_CMD,
      verifiedWorkspaceId: callerWorkspaceId,
    };

    // Detached run (design §4): the caller polls with the same key. start()
    // records a failed result rather than releasing the key on a throw, so a
    // poll can never restart a fan-out that already spawned tasks.
    void service.start(req).catch((err: unknown) => {
      console.error(`[fanout.rpc] fan-out ${idempotencyKey} failed:`, err);
    });

    return {
      ok: true as const,
      status: 'accepted' as const,
      idempotencyKey,
      taskCount: parsed.titles.length,
      repoPath: callerRepoRoot,
      workspaceId: callerWorkspaceId,
    };
  });
}
