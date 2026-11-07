// Whether the MCP broker hosts a shim's session, from the OS's own answer for
// the process at the other end of the socket (shared/peerPid.ts).
//
// A shim names its pid and parent pid in its handshake, and the session's
// identity walk starts from them. The broker hosts the session only when the
// kernel's peer is that pid and runs as this user, and it takes the parent pid
// from the OS, never from the handshake. Anything it cannot read is refused:
// the native shim then runs the full bundle, which talks to main directly.

import { execFile } from 'node:child_process';
import type { PeerPid } from '../shared/peerPid';

/** Why the broker refused a session. It logs the reason and closes the connection with no ack line. */
export type PeerRefusal = 'peer' | 'peer-unverified';

export type PeerDecision =
  | { ok: true; callerPid: number }
  | { ok: false; reason: PeerRefusal; detail: string };

export interface PeerCheckInput {
  /** The broker's startup self-check passed (peer pids can be read here). */
  selfCheckOk: boolean;
  /** What the OS reported for the accepted socket. */
  peer: PeerPid;
  /** The pid the handshake claims. */
  claimedPid: unknown;
  /** This process's uid; null where there is none (Windows). */
  ownUid: number | null;
}

/** The pid check, before the parent pid is read. */
export function checkPeer(input: PeerCheckInput): PeerDecision {
  if (!input.selfCheckOk) return { ok: false, reason: 'peer-unverified', detail: 'peer pids cannot be read in this process' };
  const { peer } = input;
  if (peer.pid === null) return { ok: false, reason: 'peer-unverified', detail: peer.reason };
  if (peer.uid === undefined || input.ownUid === null) return { ok: false, reason: 'peer-unverified', detail: `no uid for peer ${peer.pid}` };
  if (peer.uid !== input.ownUid) return { ok: false, reason: 'peer', detail: `peer ${peer.pid} runs as uid ${peer.uid}` };
  if (input.claimedPid !== peer.pid) {
    return { ok: false, reason: 'peer', detail: `claimed pid ${String(input.claimedPid)}, peer ${peer.pid}` };
  }
  return { ok: true, callerPid: peer.pid };
}

/**
 * How long the broker waits for a peer's parent pid. With the self-check's own
 * 2 s this stays under the native shim's 5 s ack deadline.
 */
export const PARENT_READ_TIMEOUT_MS = 1500;

/** The parent of a live pid, as the OS reports it; null when it cannot be read. */
export function osParentPid(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: PARENT_READ_TIMEOUT_MS }, (err, stdout) => {
      const ppid = err ? NaN : Number.parseInt(stdout.trim(), 10);
      resolve(Number.isInteger(ppid) && ppid > 0 ? ppid : null);
    });
  });
}

export type HostDecision =
  | { ok: true; callerPid: number; callerPpid: number }
  | { ok: false; reason: PeerRefusal; detail: string };

/** The full decision: the pid check, then the parent pid from the OS. */
export async function decidePeer(
  input: PeerCheckInput,
  parentOf: (pid: number) => Promise<number | null> = osParentPid,
): Promise<HostDecision> {
  const checked = checkPeer(input);
  if (!checked.ok) return checked;
  const callerPpid = await parentOf(checked.callerPid);
  if (callerPpid === null) return { ok: false, reason: 'peer-unverified', detail: `no parent pid for peer ${checked.callerPid}` };
  return { ok: true, callerPid: checked.callerPid, callerPpid };
}
