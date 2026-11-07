// The process at the other end of a local socket, as the OS reports it.
//
// A pipe call names its caller (a pid, a pty, a workspace) in its own fields,
// and nothing ties those fields to the process that sent them. The kernel
// knows which process connected: macOS answers LOCAL_PEERPID (and getpeereid
// for its uid) and Linux SO_PEERCRED for a unix socket. This reads that answer
// through koffi.
//
// The MCP broker decides on it (src/mcp/brokerPeer.ts), a2a.resolve.identity
// checks pane claims against it, and the daemon logs it next to what a call
// claimed. Windows named pipes and the loopback TCP fallback have no answer
// here yet (null).
//
// Linux SO_PEERCRED names the process that connected. macOS LOCAL_PEERPID
// names the socket's last_pid, the last process to use the peer's end. Neither
// tells apart a process that inherited the socket, or a pid reused after the
// peer exits.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export type PeerPid =
  | { pid: number; uid?: number }
  | { pid: null; reason: string };

type GetSockOpt = (fd: number, level: number, name: number, value: Buffer, length: Buffer) => number;
type GetPeerEid = (fd: number, uid: Buffer, gid: Buffer) => number;

// darwin <sys/un.h>: SOL_LOCAL 0, LOCAL_PEERPID 0x002 (pid_t).
// linux <asm/socket.h>: SOL_SOCKET 1, SO_PEERCRED 17 (struct ucred { pid; uid; gid }).
const OPTION: Partial<Record<NodeJS.Platform, { lib: string; level: number; name: number; size: number }>> = {
  darwin: { lib: 'libSystem.B.dylib', level: 0, name: 0x002, size: 4 },
  linux: { lib: 'libc.so.6', level: 1, name: 17, size: 12 },
};

let getsockopt: GetSockOpt | { reason: string } | undefined;
// darwin only: LOCAL_PEERPID carries no uid, getpeereid does.
let getpeereid: GetPeerEid | undefined;

function loadGetSockOpt(): GetSockOpt | { reason: string } {
  if (getsockopt) return getsockopt;
  const option = OPTION[process.platform];
  if (!option) return (getsockopt = { reason: `unsupported platform ${process.platform}` });
  try {
    // Runtime require, external to every bundle (its binary sits beside the package).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as { load(name: string): { func(name: string, result: string, args: string[]): unknown } };
    const lib = koffi.load(option.lib);
    getsockopt = lib.func('getsockopt', 'int', ['int', 'int', 'int', 'void *', 'void *']) as GetSockOpt;
    if (process.platform === 'darwin') getpeereid = lib.func('getpeereid', 'int', ['int', 'void *', 'void *']) as GetPeerEid;
  } catch (err) {
    getsockopt = { reason: `koffi unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  return getsockopt;
}

/** The peer's uid on darwin, or undefined when it cannot be read. */
function darwinPeerUid(fd: number): number | undefined {
  if (!getpeereid) return undefined;
  const uid = Buffer.alloc(4);
  const gid = Buffer.alloc(4);
  try {
    return getpeereid(fd, uid, gid) === 0 ? uid.readUInt32LE(0) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The peer of an accepted unix socket. Call it in the server's connection
 * callback: the fd is read there, before anything else can close and reuse it.
 */
export function peerPidOf(socket: net.Socket): PeerPid {
  const option = OPTION[process.platform];
  if (!option) return { pid: null, reason: `unsupported platform ${process.platform}` };
  const read = loadGetSockOpt();
  if (typeof read !== 'function') return { pid: null, reason: read.reason };
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== 'number' || fd < 0) return { pid: null, reason: 'no fd' };
  const value = Buffer.alloc(option.size);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(option.size);
  try {
    if (read(fd, option.level, option.name, value, length) !== 0) return { pid: null, reason: 'getsockopt failed' };
  } catch {
    // Measurement never fails a connection.
    return { pid: null, reason: 'getsockopt threw' };
  }
  const pid = value.readInt32LE(0);
  // 0: a peer outside this pid namespace (Linux).
  if (pid <= 0) return { pid: null, reason: 'no peer pid' };
  if (process.platform === 'linux') return { pid, uid: value.readUInt32LE(4) };
  const uid = darwinPeerUid(fd);
  return uid === undefined ? { pid } : { pid, uid };
}

/**
 * Whether this process can read peer pids: it connects to a socket of its own
 * and checks that the peer it reads is itself, by pid and uid. A packaged build missing
 * koffi's binary shows here as unavailable. The socket is a fresh name in the
 * temp directory, or `socketPath` when given: a file already there is removed
 * first, so a caller that names one path keeps a single file however often it
 * checks.
 */
export function selfCheckPeerPid(timeoutMs = 2000, socketPath?: string): Promise<string | null> {
  // Windows named pipes have no peer pid here: nothing to check or log.
  if (process.platform === 'win32') return Promise.resolve(null);
  if (!OPTION[process.platform]) return Promise.resolve(`unavailable (unsupported platform ${process.platform})`);
  const at = socketPath ?? path.join(os.tmpdir(), `wmux-peer-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`);
  // A file that cannot be removed shows up as the listen error below.
  if (socketPath) try { fs.rmSync(socketPath, { force: true }); } catch { /* listen reports it */ }
  return new Promise((resolve) => {
    let settled = false;
    let client: net.Socket | undefined;
    const timer = setTimeout(() => finish('unavailable (self-check timed out)'), timeoutMs);
    const finish = (verdict: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.destroy();
      server.close();
      fs.rm(at, { force: true }, () => undefined);
      resolve(verdict);
    };
    const server = net.createServer((socket) => {
      const peer = peerPidOf(socket);
      socket.destroy();
      const ownUid = process.getuid?.();
      if (peer.pid === null) finish(`unavailable (${peer.reason})`);
      else if (peer.pid !== process.pid) finish(`unavailable (read pid ${peer.pid}, expected ${process.pid})`);
      // The broker refuses a peer without a uid, so a uid it cannot read is no peer read at all.
      else if (peer.uid !== ownUid) finish(`unavailable (read uid ${String(peer.uid)}, expected ${String(ownUid)})`);
      else finish('available');
    });
    server.on('error', (err) => finish(`unavailable (${err.message})`));
    server.listen(at, () => {
      client = net.connect(at);
      client.on('error', (err) => finish(`unavailable (${err.message})`));
    });
  });
}
