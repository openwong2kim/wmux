// ─── task.fanout.start RPC handler ─────────────────────────────────────
// Pipe/MCP surface for J1 fan-out (plans/fanout-mcp-surface-2026-07-28.md).
// The renderer keeps its own ungated `fanout:start` IPC (fanout.handler.ts) —
// there the human's click IS the authorization. This handler is the surface an
// AGENT reaches, so it re-derives everything the renderer was trusted to state
// and adds the approval the renderer path never needed.
//
// Three fields become attack surface the moment fan-out is on the wire, and
// each is closed here rather than downstream:
//
//   verifiedWorkspaceId — D5 stamp, identical to a2a.channel.rpc.ts: resolve
//     `senderPtyId` → owning workspace via the renderer and overwrite ANY
//     client-supplied value. Unresolvable → fail closed (fan-out is a mutation).
//
//   repoPath — NOT a wire parameter. Derived from the caller's OWN pane: the
//     surface whose ptyId === senderPtyId, and that surface's live cwd (OSC 7 /
//     prompt scrape). So a worktree can only ever be created in the repo the
//     caller's own terminal is sitting in. An explicit repoPath is REJECTED,
//     not ignored — silently ignoring it would let a caller believe it fanned
//     out over repo B while it actually fanned out over repo A.
//
//   agentCmd — NOT a wire parameter. FanOutService.buildInitialCommand
//     interpolates it UNQUOTED into `<agentCmd> "$(cat '<path>')"`, so a wire
//     value would be plain shell injection. The renderer path may keep it
//     because a human types it into the dialog.
//
// The prompt body itself never reaches the shell parser: it is written to
// prompt.md and read back via `$(cat '<path>')` with the PATH single-quoted
// (FanOutService §4 D4).
//
// Residual: `senderPtyId` arrives in params, not from the connection peer PID,
// so a same-user process can forge it — the #113 ceiling documented at length in
// a2a.channel.rpc.ts. Attribution here is advisory in exactly the same way; this
// handler is no weaker and no stronger than the channel surface it mirrors.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { FanOutService } from '../../worktask/FanOutService';
import { FANOUT_MAX_TASKS } from '../../../shared/workTask';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

/** The renderer prompt auto-denies at 30s; leave headroom before the bridge
 *  gives up, or a user who approves at 29s gets a dead RPC. */
const APPROVAL_TIMEOUT_MS = 45_000;

type Fail = { ok: false; error: { code: string; message: string } };

function fail(code: string, message: string): Fail {
  return { ok: false, error: { code, message } };
}

/**
 * The caller's own repo, derived from its own pane. Two renderer hops:
 * ptyId → owning workspace (`input.findOwnerWorkspace`, the same resolution
 * a2a.channel.rpc.ts uses), then workspace → the surface bound to that ptyId
 * and its live cwd (`surface.list`).
 *
 * Returns '' for every failure mode (no sender, unknown pty, renderer down,
 * surface with no cwd) — the caller turns that into a fail-closed rejection.
 */
async function resolveCallerRepo(
  getWindow: GetWindow,
  senderPtyId: string,
): Promise<{ workspaceId: string; cwd: string }> {
  if (!senderPtyId) return { workspaceId: '', cwd: '' };
  let workspaceId = '';
  try {
    const owner = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId: senderPtyId });
    const wsId =
      owner && typeof owner === 'object' && 'workspaceId' in owner
        ? (owner as Record<string, unknown>)['workspaceId']
        : null;
    workspaceId = typeof wsId === 'string' ? wsId : '';
  } catch {
    // Renderer unavailable (early boot / reload) — treat as unresolvable.
    return { workspaceId: '', cwd: '' };
  }
  if (!workspaceId) return { workspaceId: '', cwd: '' };

  try {
    const surfaces = await sendToRenderer(getWindow, 'surface.list', { workspaceId });
    if (!Array.isArray(surfaces)) return { workspaceId, cwd: '' };
    for (const s of surfaces) {
      if (!s || typeof s !== 'object') continue;
      const row = s as Record<string, unknown>;
      if (row['ptyId'] !== senderPtyId) continue;
      const cwd = typeof row['cwd'] === 'string' ? row['cwd'].trim() : '';
      return { workspaceId, cwd };
    }
  } catch {
    return { workspaceId, cwd: '' };
  }
  return { workspaceId, cwd: '' };
}

/** Defensive wire parsing. Unlike the renderer's normalizeRequest this rejects
 *  rather than coerces: an agent that sends the wrong shape should learn so. */
function readTitles(raw: unknown): string[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'titles must be an array of strings' };
  const titles: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') return { error: 'titles must contain only strings' };
    const trimmed = t.trim();
    if (trimmed.length > 0) titles.push(trimmed);
  }
  if (titles.length === 0) return { error: 'at least one non-empty title is required' };
  if (titles.length > FANOUT_MAX_TASKS) {
    return { error: `task count ${titles.length} exceeds cap ${FANOUT_MAX_TASKS}` };
  }
  return titles;
}

export function registerFanOutRpc(
  router: RpcRouter,
  getFanOutService: () => FanOutService,
  getWindow: GetWindow,
): void {
  router.register('task.fanout.start', async (params, ctx?: RpcContext) => {
    // Origin gate. LanLink's LAN listener is a separate router that stamps
    // origin:'remote'; `origin` is a REQUIRED RpcContext field so a future
    // remote transport cannot silently inherit a spawn path. Fan-out is
    // strictly more powerful than a2a execute, which gates the same way.
    if (ctx && ctx.origin !== 'local') {
      return fail('NOT_AUTHORIZED', 'task.fanout.start is local-origin only');
    }

    // Fields the renderer may state but a wire caller may not. Rejected loudly
    // rather than dropped — see the file header.
    if (params['repoPath'] !== undefined) {
      return fail(
        'INVALID_ARGUMENT',
        'task.fanout.start does not accept repoPath — the repo is derived from the calling pane\'s working directory',
      );
    }
    if (params['agentCmd'] !== undefined) {
      return fail(
        'INVALID_ARGUMENT',
        'task.fanout.start does not accept agentCmd — the pipe surface always uses the default agent command',
      );
    }

    const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'].trim() : '';
    const { workspaceId, cwd } = await resolveCallerRepo(getWindow, senderPtyId);
    if (!workspaceId) {
      return fail(
        'NOT_AUTHORIZED',
        'task.fanout.start requires a verifiable caller (no resolvable senderPtyId)',
      );
    }
    if (!cwd) {
      return fail(
        'FAILED_PRECONDITION',
        'task.fanout.start could not determine the calling pane\'s working directory — run the caller inside a terminal pane whose cwd is a git repository',
      );
    }

    const idempotencyKey =
      typeof params['idempotencyKey'] === 'string' ? params['idempotencyKey'].trim() : '';
    if (!idempotencyKey) {
      return fail('INVALID_ARGUMENT', 'task.fanout.start requires an idempotencyKey');
    }

    const titles = readTitles(params['titles']);
    if (!Array.isArray(titles)) return fail('INVALID_ARGUMENT', `task.fanout.start: ${titles.error}`);

    const prompt = typeof params['prompt'] === 'string' ? params['prompt'] : '';
    let taskPrompts: string[] | undefined;
    if (params['taskPrompts'] !== undefined) {
      if (!Array.isArray(params['taskPrompts'])) {
        return fail('INVALID_ARGUMENT', 'task.fanout.start: taskPrompts must be an array of strings');
      }
      // Index-aligned with the RAW titles array. Empty titles are dropped by
      // readTitles, so re-pair against the raw array before dropping, or a hole
      // in titles would shift every later prompt onto the wrong task (the
      // regression fanout.handler.normalizeRequest already guards).
      const rawTitles = params['titles'] as unknown[];
      const rawPrompts = params['taskPrompts'] as unknown[];
      taskPrompts = rawTitles
        .map((t, k) => ({
          keep: typeof t === 'string' && t.trim().length > 0,
          value: typeof rawPrompts[k] === 'string' ? (rawPrompts[k] as string) : '',
        }))
        .filter((e) => e.keep)
        .map((e) => e.value);
    }

    const memberId = typeof params['memberId'] === 'string' && params['memberId'].length > 0
      ? params['memberId']
      : workspaceId;

    // Approval gate — reuse of the A2A execute gate, not a second one. Same
    // queue, same 30s auto-deny, same global auto-approve toggle; only the
    // dialog copy branches (a fan-out spawns into N NEW worktree workspaces,
    // which the A2A wording would misdescribe).
    //
    // Prompted BEFORE FanOutService.start, i.e. before the idempotency LRU is
    // consulted: probing the cache to decide whether to prompt would let a
    // caller skip the gate by replaying a key.
    let approved = false;
    try {
      const verdict = await sendToRenderer(
        getWindow,
        'fanout.requestApproval',
        {
          workspaceId,
          repoPath: cwd,
          taskCount: titles.length,
          promptPreview: [prompt, ...titles.map((t) => `- ${t}`)].filter((s) => s.length > 0).join('\n').slice(0, 500),
        },
        { timeoutMs: APPROVAL_TIMEOUT_MS },
      );
      approved = !!(verdict && typeof verdict === 'object' && (verdict as Record<string, unknown>)['approved'] === true);
    } catch {
      // Renderer unavailable / bridge timeout — fail closed. An unattended
      // spawn is exactly what the gate exists to prevent.
      approved = false;
    }
    if (!approved) {
      return fail('NOT_AUTHORIZED', 'task.fanout.start: fan-out was not approved');
    }

    const result = await getFanOutService().start({
      idempotencyKey,
      prompt,
      titles,
      ...(taskPrompts ? { taskPrompts } : {}),
      repoPath: cwd,
      agentCmd: 'claude',
      verifiedWorkspaceId: workspaceId,
      memberId,
    });
    return result;
  });
}
