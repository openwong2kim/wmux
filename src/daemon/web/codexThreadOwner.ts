import fs from 'node:fs';
import os from 'node:os';
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

/** Persist the TUI relay's confirmed foreground selection for detached hooks.
 * The v1 file protocol is shared with integrations/codex/bin/wmux-codex-thread.mjs;
 * subprocess integration tests verify that those standalone readers consume it.
 * A lost link retains its last owner; a live empty selection invalidates it.
 */
export function persistCodexThreadOwner(pane: Pane, observed: CodexRelayObservation, daemonEnv = process.env): void {
  if (!observed.live) return;
  const id = observed.selection?.threadId;
  if (id && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return;
  const codeHome = pane.env?.CODEX_HOME || path.join(daemonEnv.USERPROFILE || daemonEnv.HOME || os.homedir(), '.codex');
  const identity = threadIdentityEnv(pane, daemonEnv);
  const env = Object.fromEntries(keys.map(key => [key, identity[key] || pane.env?.[key] || '']));
  const snapshot = JSON.stringify([codeHome, env, id, observed.selection?.generation]);
  if (snapshots.get(pane) === snapshot) return;
  // Never create a registry solely because an unselected relay connected.
  if (!id && !snapshots.has(pane)) return;
  try {
    const dir = path.join(codeHome, 'wmux-thread-owners');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const paneKey = digest(JSON.stringify([env.WMUX_DATA_SUFFIX, env.WMUX_PTY_ID]));
    writeAtomic(path.join(dir, `pane-${paneKey}.json`), { id: id || '', nonce });
    if (id) writeAtomic(path.join(dir, `thread-${digest(id)}.json`), { version: 1, id, env, nonce });
    snapshots.set(pane, snapshot);
  } catch { /* A hook without provable ownership will be dropped. */ }
}
