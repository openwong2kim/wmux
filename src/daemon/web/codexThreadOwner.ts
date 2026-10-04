import fs from 'node:fs';
import type { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CodexRelayObservation } from './codexTuiSelection';
import { threadIdentityEnv } from './codexRelayPolicy';

type Pane = { id: string; env?: Record<string, string> };
const snapshots = new WeakMap<Pane, string>();
const keys = ['WMUX_PTY_ID', 'WMUX_WORKSPACE_ID', 'WMUX_SURFACE_ID', 'WMUX_DATA_SUFFIX', 'WMUX_PIPE_NAME', 'WMUX_HOOKS_TO_MAIN'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ }
  }
}

function identity(pane: Pane, daemonEnv: NodeJS.ProcessEnv): Record<string, string> {
  const trusted = threadIdentityEnv(pane, daemonEnv);
  return Object.fromEntries(keys.map(key => [key, trusted[key] || pane.env?.[key] || '']));
}
function pointer(codeHome: string, env: Record<string, string>): string {
  return path.join(codeHome, 'wmux-thread-owners', `pane-${digest(JSON.stringify([env.WMUX_DATA_SUFFIX, env.WMUX_PTY_ID]))}.json`);
}
function unlinkPointer(file: string): void {
  try { fs.unlinkSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Called before closing a pane/relay, while the attached account is known.
 * Unlinking needs no new file allocation; failures propagate to the caller.
 */
export function invalidateCodexThreadOwner(pane: Pane, codeHome: string, daemonEnv = process.env): void {
  unlinkPointer(pointer(codeHome, identity(pane, daemonEnv)));
  snapshots.delete(pane);
}

/** Persist the TUI relay's confirmed foreground selection for detached hooks.
 * The v1 file protocol is shared with integrations/codex/bin/wmux-codex-thread.mjs.
 * codeHome is the relay's attached account, never recomputed from pane.env.
 * A lost link retains its last owner; a live empty selection invalidates disk
 * even after restart, when this process has no snapshot. Any write failure
 * propagates so the relay aborts before forwarding a conversation switch.
 */
export function persistCodexThreadOwner(pane: Pane, observed: CodexRelayObservation, codeHome: string, daemonEnv = process.env): void {
  if (!observed.live) return;
  const id = observed.selection?.threadId;
  if (id && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return;
  const env = identity(pane, daemonEnv);
  const snapshot = JSON.stringify([codeHome, env, id, observed.selection?.generation]);
  if (id && snapshots.get(pane) === snapshot) return;
  // Remove the old authority first. ENOSPC during publication cannot leave a
  // stale pair valid; an unlink failure aborts before the switch is sent.
  unlinkPointer(pointer(codeHome, env));
  snapshots.delete(pane);
  if (!id) return;
  const dir = path.join(codeHome, 'wmux-thread-owners');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  writeAtomic(path.join(dir, `thread-${digest(id)}.json`), { version: 1, id, env, nonce });
  writeAtomic(pointer(codeHome, env), { id, nonce });
  snapshots.set(pane, snapshot);
}

/** Direct launches have no relay retirement callback. Remember their spawn
 * account until destruction (the manager removes the pane before that event).
 * Relay-owned accounts are additionally invalidated by their retiring hook.
 */
export function trackCodexPaneOwnerCleanup(events: Pick<EventEmitter, 'on'>, defaultCodeHome: string,
  onError: (error: unknown) => void, daemonEnv = process.env): void {
  const panes = new Map<string, Pane>();
  events.on('session:created', ({ session }: { session: Pane }) => { panes.set(session.id, session); });
  const gone = ({ id }: { id: string }) => {
    const pane = panes.get(id);
    if (!pane) return;
    try { invalidateCodexThreadOwner(pane, pane.env?.CODEX_HOME || defaultCodeHome, daemonEnv); }
    catch (error) { onError(error); }
    finally { panes.delete(id); }
  };
  events.on('session:died', gone);
  events.on('session:destroyed', gone);
}
