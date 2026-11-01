// A fan-out's workers inherit bypass from the pane that fans out (owner
// decision 2026-11-01): when the calling pane is itself running Claude Code in
// `bypassPermissions`, its workers launch in `bypassPermissions` too. That is
// the ONLY inheritance: any other parent mode, or a mode that cannot be read,
// leaves the operator's setting in charge — never elevated beyond the parent.
//
// The parent's mode is the daemon's, from process truth: `daemon.listSessions`
// marks a row `liveClaudeBypass` only when the pane's live Claude process was
// launched in bypass (its command line) AND the newest mode its hooks reported
// since that launch is still bypass. A conversation resumed without the flag, a
// mode switched mid-session, a WSL pane (its command line is not read) or a
// dead process all say no. Nothing here reads the caller's request.

import type { DaemonRpc } from '../pty/wslCallerCwd';
import type { FanoutWorkerPermissionMode } from '../../shared/workerLaunch';

/** Where a fan-out's worker mode came from, for its audit records. */
export type FanoutWorkerModeSource = 'setting' | 'bot-preset' | 'inherited-caller-pane';

/** Whether one `daemon.listSessions` row is a pane running bypass Claude right now (the daemon's `liveClaudeBypass`). */
export function sessionRunsBypassClaude(row: unknown): boolean {
  return !!row && typeof row === 'object' && (row as Record<string, unknown>)['liveClaudeBypass'] === true;
}

/**
 * Whether the pane `ptyId` runs Claude in bypass, read from the daemon. Any
 * miss — no daemon, an error, no such session, an unreadable row — is false,
 * so the fan-out keeps the operator's setting (fail closed).
 */
export async function callerPaneRunsBypass(ptyId: string, daemonRpc: DaemonRpc): Promise<boolean> {
  if (!ptyId) return false;
  try {
    const reply = await daemonRpc('daemon.listSessions', {});
    const sessions = Array.isArray(reply)
      ? reply
      : Array.isArray((reply as { sessions?: unknown } | null)?.sessions)
        ? (reply as { sessions: unknown[] }).sessions
        : [];
    const row = sessions.find((s) => !!s && typeof s === 'object' && (s as { id?: unknown }).id === ptyId);
    return sessionRunsBypassClaude(row);
  } catch {
    return false;
  }
}

/**
 * The worker mode for a pane caller's fan-out: `bypassPermissions` when the
 * calling pane runs bypass (whatever the setting, `manual` included — the
 * parent already runs unguarded), otherwise the setting unchanged.
 */
export function inheritWorkerMode(
  setting: FanoutWorkerPermissionMode,
  parentRunsBypass: boolean,
): { mode: FanoutWorkerPermissionMode; source: FanoutWorkerModeSource } {
  if (parentRunsBypass && setting !== 'bypassPermissions') {
    return { mode: 'bypassPermissions', source: 'inherited-caller-pane' };
  }
  return { mode: setting, source: 'setting' };
}
