// ─── Channels v2 (durable inbox) Step 0: daemon-side caller stamping ───────
//
// Lets a HEADLESS pipe client (the `wmux channel` CLI, or any agent-side
// tool running inside a pane's process tree) mutate/read channels without
// the GUI being alive. Before this module, `verifiedWorkspaceId` had exactly
// one honest producer — the MAIN process (a2a.channel.rpc.ts D5 stamp, which
// needs a live renderer to resolve pty → workspace) — so a daemon-pipe
// caller with no GUI was locked out of every channel op (fail-closed).
//
// The daemon, however, already holds a server-side pty → workspace binding:
// `daemon.createSession` persists the FULLY-RESOLVED child env, and main
// force-stamps `WMUX_WORKSPACE_ID` into that env at spawn time (see
// pty.handler.ts "Env resolution happens HERE in main"). Reading it back
// from the daemon's OWN session record is server-side provenance — NOT the
// caller's env claim (the spoofable hint the WI-002 audit retired).
//
// Acceptance rule (design doc "두 RPC 표면과 신뢰 모델", fail-closed):
//   1. Request already carries `verifiedWorkspaceId`  → trust it verbatim.
//      That value has exactly two honest producers today — main's D5 stamp
//      and the renderer-local mutate path — and this preserves their
//      behavior byte-for-byte. (A same-user pipe client can forge it; that
//      is the documented #113 same-user ceiling / audit-B1 residual, NOT a
//      boundary this module claims to close. True peer identification =
//      GetNamedPipeClientProcessId, strategy track.)
//   2. No `verifiedWorkspaceId` but a `senderPtyId` the daemon can resolve
//      from its session store → stamp `verifiedWorkspaceId` server-side
//      (NEW headless path), and backfill the caller-identity field of the
//      payload (sender/createdBy/member/workspaceId) when the caller left
//      it empty — a pipe client cannot be expected to know its workspace.
//   3. Neither resolvable → { ok:false, NOT_AUTHORIZED } (fail-closed),
//      matching the per-handler guards that already reject bare requests.
//
// Staleness note: the binding is stamped at spawn time. A workspace id that
// is re-minted while the session lives would leave a stale binding; under
// the #113 ceiling this is ADVISORY attribution either way, and the GUI
// paths (rule 1) keep using the renderer's live answer.

/** Resolve a live session's owning workspace, '' when unknown. */
export type ResolveSessionWorkspace = (sessionId: string) => string;

/**
 * Which payload field carries the CALLER's own identity for this method —
 * backfilled from the stamped workspace when the caller omitted it. Target
 * identities (e.g. invite's `invitedMember`) are deliberately NOT listed.
 */
export type CallerFieldSpec =
  | { kind: 'none' }
  | { kind: 'ref'; key: 'sender' | 'createdBy' | 'member' }
  | { kind: 'flat'; key: 'workspaceId' };

export interface StampOk {
  ok: true;
  params: Record<string, unknown>;
}

export interface StampErr {
  ok: false;
  error: { code: 'NOT_AUTHORIZED'; message: string };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const nonEmptyString = (v: unknown): string =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : '';

/**
 * Stamp the caller identity for one `a2a.channel.*` daemon RPC request.
 * Returns a SHALLOW-cloned params object (never mutates the input); nested
 * caller-ref objects are cloned before backfill.
 */
export function stampChannelCaller(
  resolveSessionWorkspace: ResolveSessionWorkspace,
  rawParams: Record<string, unknown>,
  callerField: CallerFieldSpec,
): StampOk | StampErr {
  const params: Record<string, unknown> = { ...rawParams };

  // Rule 1 — pre-stamped request (main D5 / renderer-local): trust verbatim.
  if (nonEmptyString(params['verifiedWorkspaceId'])) {
    return { ok: true, params };
  }

  const senderPtyId = nonEmptyString(params['senderPtyId']);
  if (!senderPtyId) {
    // Rule 3a — nothing to resolve. Let the per-handler guard produce its
    // canonical "verifiedWorkspaceId is required" rejection (byte-identical
    // behavior for today's callers).
    return { ok: true, params };
  }

  // Rule 2 — headless caller: resolve pty → workspace from the daemon's own
  // session record (server-side provenance).
  const ws = resolveSessionWorkspace(senderPtyId);
  if (!ws) {
    // Rule 3b — a caller ASKED for pty-based identity and the daemon cannot
    // vouch for that pty: fail closed with a precise reason instead of the
    // generic missing-verifiedWorkspaceId error.
    return {
      ok: false,
      error: {
        code: 'NOT_AUTHORIZED',
        message:
          `channel caller identity: senderPtyId "${senderPtyId}" is not a live daemon session ` +
          'with a workspace binding (WMUX_WORKSPACE_ID) — cannot stamp verifiedWorkspaceId',
      },
    };
  }

  params['verifiedWorkspaceId'] = ws;

  // Backfill the caller's own identity field when omitted, so a pipe client
  // does not need to know (or guess) its workspace id. An EXPLICIT value is
  // left alone — the downstream sender-pin gates (e.g. post's
  // sender.workspaceId === verifiedWorkspaceId) still verify it.
  if (callerField.kind === 'ref') {
    const ref = asRecord(params[callerField.key]);
    if (ref && !nonEmptyString(ref['workspaceId'])) {
      params[callerField.key] = { ...ref, workspaceId: ws };
    }
  } else if (callerField.kind === 'flat') {
    if (!nonEmptyString(params[callerField.key])) {
      params[callerField.key] = ws;
    }
  }

  return { ok: true, params };
}
