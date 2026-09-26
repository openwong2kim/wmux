import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tryNativeSnapshot } from '../../main/pty/winSnapshotNative';
import type { AgentSignal } from '../../shared/hooks/signal-types';

/** Process evidence is taken by the receiving daemon, never supplied as a tree by the caller. */
export function notifyProvenance(
  parentPid: unknown,
  shellPid: number | undefined,
  parents: ReadonlyMap<number, number> | undefined,
): 'owned' | 'foreign' | 'unknown' {
  if (typeof parentPid !== 'number' || !Number.isSafeInteger(parentPid) || parentPid <= 0 || !parents) return 'unknown';
  let pid = parentPid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 128 && !seen.has(pid); depth++) {
    seen.add(pid);
    if (pid === shellPid && parents.has(pid)) return 'owned';
    if (pid <= 1) return 'foreign';
    const parent = parents.get(pid);
    if (parent === undefined) return 'unknown';
    if (parent <= 0) return 'foreign';
    pid = parent;
  }
  return 'unknown';
}

export function applyNotifyProvenance(signal: AgentSignal, provenance: 'owned' | 'foreign' | 'unknown'): AgentSignal {
  // Older session_id-only clients and cross-OS bridges retain their original
  // routing when no contrary process evidence is available. Official shared-host
  // notifications must instead prove a completed turn on an owned relay.
  if (provenance === 'owned' || provenance === 'unknown' && signal.payload?.notifyFormat === 'legacy') {
    return { ...signal, payload: { ...signal.payload, source: 'codex.notify.direct' } };
  }
  return signal;
}

/** Parent IDs only: no command lines, environment reads or shell command parsing. */
export async function readNotifyParents(): Promise<Map<number, number> | undefined> {
  try {
    if (process.platform === 'win32') {
      const snapshot = tryNativeSnapshot();
      return snapshot ? new Map(snapshot.procs.map(p => [p.pid, p.ppid])) : undefined;
    }
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid='],
      { encoding: 'utf8', timeout: 700, maxBuffer: 2 * 1024 * 1024 });
    const parents = new Map<number, number>();
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (match) parents.set(Number(match[1]), Number(match[2]));
    }
    return parents;
  } catch { return undefined; }
}
