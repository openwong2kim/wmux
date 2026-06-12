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
 */

import type { RpcMethod, RpcResponse } from '../shared/rpc';

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
 * Resolve the CLI's own pane identity. Never throws — identity is an
 * enhancement, not a gate; on any failure the caller proceeds with
 * active-pane semantics.
 */
export async function resolveSelfContext(deps: IdentityDeps): Promise<SelfContext> {
  const insideWmuxHint = Boolean(deps.env['WMUX_WORKSPACE_ID']);

  let entries: IdentityEntry[];
  try {
    const response = await deps.sendRequest('a2a.resolve.identity' as RpcMethod, {});
    if (!response.ok) return {};
    entries = parseIdentityEntries(response.result);
  } catch {
    return {};
  }
  if (entries.length === 0) return {};

  const byPid = new Map<number, IdentityEntry>();
  for (const entry of entries) {
    const pid = parseInt(entry.pid, 10);
    if (!Number.isNaN(pid)) byPid.set(pid, entry);
  }

  // Depth 0 — our direct parent. Free (no spawn); covers `wmux …` typed
  // straight into a pane shell.
  const direct = byPid.get(deps.ppid);
  if (direct) return toContext(direct);

  // Deeper walk costs one spawn per hop — only worth it when the env hint
  // says a wmux pane is somewhere above us (nested shells, scripts).
  if (!insideWmuxHint) return {};

  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  let currentPid = deps.ppid;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const parentPid = await deps.getParentPid(currentPid);
    if (!parentPid || parentPid === currentPid || parentPid <= 1) break;
    currentPid = parentPid;
    const hit = byPid.get(currentPid);
    if (hit) return toContext(hit);
  }
  return {};
}

function toContext(entry: IdentityEntry): SelfContext {
  const ctx: SelfContext = { workspaceId: entry.workspaceId };
  if (entry.ptyId) ctx.ptyId = entry.ptyId;
  return ctx;
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
