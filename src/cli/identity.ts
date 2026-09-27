/**
 * Self-identity resolution for the `wmux` CLI (X4).
 *
 * When the CLI runs inside a wmux pane, its parent process chain leads to the
 * shell that wmux spawned for that pane. The main process keeps an on-disk
 * pid-map (PID → ptyId, resolved live to the owning workspace via
 * `a2a.resolve.identity`), so walking our own PPID chain against that map
 * yields VERIFIED pane-level identity: { ptyId, workspaceId }.
 *
 * Design constraints:
 *  - The common case (CLI spawned directly by the pane shell) must resolve
 *    with ZERO process spawns: `process.ppid` is free and is usually the
 *    mapped shell PID itself.
 *  - Walking further up requires one PowerShell/ps spawn per hop (slow), so
 *    the deep walk only runs when the WMUX_WORKSPACE_ID env hint says we are
 *    nominally inside wmux. Outside wmux the CLI falls back to active-pane
 *    semantics immediately instead of burning seconds on a doomed walk.
 *  - Env hints (WMUX_WORKSPACE_ID / WMUX_SURFACE_ID) are NEVER trusted as
 *    routing identity — they are frozen at PTY create time and go stale when
 *    a daemon respawn re-mints workspace ids (issue #163). They only gate
 *    how hard we try to verify.
 *
 * Resolution outcome:
 *  - verified hit  → commands target the caller's own pane (ptyId +
 *    workspaceId; main asserts ownership server-side).
 *  - miss / transient / outside → `{}` — commands keep today's active-pane
 *    behavior, which is never worse than the pre-X4 CLI.
 *
 * The CLI sends its own pid (`callerPid`) so main walks the real process
 * ancestry. Commands that ACT AS a pane (channel, meta) take their pane from
 * `senderPtyIdFor`, which refuses rather than trust the pane env when main
 * says the caller is not under that pane.
 */

import type { RpcMethod, RpcResponse } from '../shared/rpc';
import { ENV_KEYS } from '../shared/constants';
import {
  isPaneAncestryStatus,
  PANE_IDENTITY_MISS_MESSAGE,
  PANE_IDENTITY_UNAVAILABLE_MESSAGE,
  PANE_IDENTITY_UNVERIFIED_WRITE_MESSAGE,
} from '../shared/paneIdentity';

export interface SelfContext {
  /** Verified ptyId of the pane whose shell spawned this CLI process. */
  ptyId?: string;
  /** Verified workspace that owns that pane (live ownership, not the frozen env hint). */
  workspaceId?: string;
}

export interface IdentityEntry {
  pid: string;
  ptyId: string;
  workspaceId: string;
}

export interface IdentityDeps {
  /** RPC transport — the CLI's sendRequest. */
  sendRequest: (method: RpcMethod, params?: Record<string, unknown>) => Promise<RpcResponse>;
  /** Environment (injectable for tests). */
  env: Record<string, string | undefined>;
  /** Our parent PID (injectable for tests). */
  ppid: number;
  /** Our own PID, sent as callerPid so main walks our ancestry (defaults to process.pid). */
  pid?: number;
  /** PPID lookup for one hop up the tree. Spawns a process — used sparingly. */
  getParentPid: (pid: number) => Promise<number | null>;
  /** Max hops above process.ppid when the env hint says we're inside wmux. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 6;

/**
 * Parse the a2a.resolve.identity result into pane-level entries.
 * Falls back to workspace-only entries (ptyId='') for older mains that
 * return `mappings` without `entries`.
 */
export function parseIdentityEntries(result: unknown): IdentityEntry[] {
  if (result === null || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.entries)) {
    return obj.entries.filter(
      (e): e is IdentityEntry =>
        e !== null &&
        typeof e === 'object' &&
        typeof (e as IdentityEntry).pid === 'string' &&
        typeof (e as IdentityEntry).ptyId === 'string' &&
        typeof (e as IdentityEntry).workspaceId === 'string',
    );
  }
  const mappings = obj.mappings;
  if (mappings !== null && typeof mappings === 'object') {
    return Object.entries(mappings as Record<string, unknown>)
      .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
      .map(([pid, workspaceId]) => ({ pid, ptyId: '', workspaceId }));
  }
  return [];
}

/**
 * How the caller's pane was (or was not) established:
 *   - 'hit'         verified: the caller runs under that pane's shell;
 *   - 'miss'        main read the process table and no pane shell is above us;
 *   - 'unavailable' main could not read the process table (after its retry);
 *   - 'unverified'  main is unreachable, or predates the check, and our own
 *                   walk found nothing.
 */
export type PaneIdentityStatus = 'hit' | 'miss' | 'unavailable' | 'unverified';

export interface PaneIdentity extends SelfContext {
  status: PaneIdentityStatus;
}

/**
 * Resolve the CLI's own pane identity. Never throws. Only a 'hit' carries a
 * pane; what a non-hit caller may do is decided by `senderPtyIdFor`.
 */
export async function resolvePaneIdentity(deps: IdentityDeps): Promise<PaneIdentity> {
  const insideWmuxHint = Boolean(deps.env['WMUX_WORKSPACE_ID']);

  let entries: IdentityEntry[];
  let serverStatus: PaneIdentityStatus | undefined;
  try {
    const response = await deps.sendRequest('a2a.resolve.identity' as RpcMethod, {
      callerPid: deps.pid ?? process.pid,
    });
    if (!response.ok) return { status: 'unverified' };
    const result = (response.result ?? {}) as { resolvedStatus?: unknown; resolved?: unknown };
    const resolved = result.resolved as { workspaceId?: unknown; ptyId?: unknown } | null | undefined;
    if (
      resolved && typeof resolved.workspaceId === 'string' && resolved.workspaceId &&
      typeof resolved.ptyId === 'string' && resolved.ptyId
    ) {
      return { status: 'hit', workspaceId: resolved.workspaceId, ptyId: resolved.ptyId };
    }
    if (isPaneAncestryStatus(result.resolvedStatus)) {
      // main walked our real ancestry and found no pane: authoritative. Env
      // and our own walk would only rediscover a pane we do not run under.
      if (result.resolvedStatus === 'miss') return { status: 'miss' };
      serverStatus = 'unavailable';
    }
    entries = parseIdentityEntries(response.result);
  } catch {
    return { status: 'unverified' };
  }
  const fallback: PaneIdentity = { status: serverStatus ?? 'unverified' };
  if (entries.length === 0) return fallback;

  const byPid = new Map<number, IdentityEntry>();
  for (const entry of entries) {
    const pid = parseInt(entry.pid, 10);
    if (!Number.isNaN(pid)) byPid.set(pid, entry);
  }

  // Depth 0 — our direct parent. Free (no spawn); covers `wmux …` typed
  // straight into a pane shell.
  const direct = byPid.get(deps.ppid);
  if (direct) return toIdentity(direct);

  // Deeper walk costs one spawn per hop — only worth it when the env hint
  // says a wmux pane is somewhere above us (nested shells, scripts).
  if (!insideWmuxHint) return fallback;

  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  let currentPid = deps.ppid;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const parentPid = await deps.getParentPid(currentPid);
    if (!parentPid || parentPid === currentPid || parentPid <= 1) break;
    currentPid = parentPid;
    const hit = byPid.get(currentPid);
    if (hit) return toIdentity(hit);
  }
  return fallback;
}

function toIdentity(entry: IdentityEntry): PaneIdentity {
  const id: PaneIdentity = { status: 'hit', workspaceId: entry.workspaceId };
  if (entry.ptyId) id.ptyId = entry.ptyId;
  return id;
}

/**
 * Pane-level context for commands that target "my own pane" (send, notify,
 * browser). A non-hit is `{}`: those commands keep active-pane semantics and
 * never act AS a pane.
 */
export async function resolveSelfContext(deps: IdentityDeps): Promise<SelfContext> {
  const id = await resolvePaneIdentity(deps);
  if (id.status !== 'hit') return {};
  const ctx: SelfContext = {};
  if (id.workspaceId) ctx.workspaceId = id.workspaceId;
  if (id.ptyId) ctx.ptyId = id.ptyId;
  return ctx;
}

/**
 * The senderPtyId a command may present as its own, or why it may not.
 *
 * Only a verified hit names a pane. The pane env (WMUX_PTY_ID) is used only
 * when main could not answer at all (unreachable, or older than this CLI),
 * and then only for reads. When the env names a pane but main says we are not
 * under it ('miss') or could not check ('unavailable'), refuse: acting on the
 * env there is exactly how a command inherits another pane's identity. With no
 * pane env at all we are simply outside wmux — '' lets the caller print its
 * usual "not inside a wmux pane" error.
 */
export function senderPtyIdFor(
  identity: PaneIdentity,
  env: Record<string, string | undefined>,
  opts: { write: boolean },
): { ptyId: string } | { error: string } {
  if (identity.status === 'hit' && identity.ptyId) return { ptyId: identity.ptyId };
  const envPty = (env[ENV_KEYS.PTY_ID] ?? '').trim();
  if (!envPty) return { ptyId: '' };
  if (identity.status === 'miss') return { error: PANE_IDENTITY_MISS_MESSAGE };
  if (identity.status === 'unavailable') return { error: PANE_IDENTITY_UNAVAILABLE_MESSAGE };
  // 'unverified', or a workspace-only hit from a main too old to name the pane.
  return opts.write ? { error: PANE_IDENTITY_UNVERIFIED_WRITE_MESSAGE } : { ptyId: envPty };
}

/**
 * Default channel member id ($WMUX_MEMBER_ID, the pane's ptyId stamped at
 * spawn). When the env visibly belongs to ANOTHER pane than the verified one
 * (its WMUX_PTY_ID differs), the env member is that other pane's, so the
 * verified pane's own ptyId is used instead.
 */
export function defaultMemberIdFor(
  identity: PaneIdentity,
  env: Record<string, string | undefined>,
): string | undefined {
  const envMember = env[ENV_KEYS.MEMBER_ID];
  const envPty = (env[ENV_KEYS.PTY_ID] ?? '').trim();
  if (identity.status === 'hit' && identity.ptyId && envMember && envPty && envPty !== identity.ptyId) {
    return identity.ptyId;
  }
  return envMember && envMember.length > 0 ? envMember : undefined;
}

/**
 * One-hop parent PID lookup. Windows uses the absolute WindowsPowerShell
 * path (bare `powershell.exe` can ENOENT under stripped PATH — see the
 * pwsh ENOENT dogfood lesson); unix uses `ps`.
 */
export async function getParentPidDefault(pid: number): Promise<number | null> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    if (process.platform === 'win32') {
      const path = await import('path');
      const ps = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      const { stdout } = await execFileAsync(
        ps,
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      const parsed = parseInt(stdout.trim(), 10);
      return Number.isNaN(parsed) ? null : parsed;
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return parseInt(stdout.trim(), 10) || null;
  } catch {
    return null;
  }
}
