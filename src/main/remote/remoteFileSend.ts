import { constants as fsConstants, promises as fsp } from 'fs';
import * as path from 'path';
import {
  REMOTE_UPLOAD_LIMITS,
  remoteUploadPathText,
  type RemoteSendFailure,
  type RemoteSendResult,
  type RemoteWriteResult,
} from '../../shared/remoteUpload';
import { sniffRoomImage } from '../../shared/roomAttachments';
import { sameFileId } from '../../shared/sameFileId';
import { isRemoteAuthRejected, isRemoteInsecureTransport, type RemoteUploadResult } from './RemoteHostClient';

// ─── Send files to a remote-terminal pane ────────────────────────────────────
//
// Upload each file to the host one at a time, then hand back the host's paths,
// checked and quoted, for the renderer to type into the pane in one write,
// unsent. All or nothing: a refusal anywhere hands back no text (what was
// already uploaded expires on the host by its TTL).

/** One file ready to send: its bytes and the name its extension comes from. */
export interface RemoteSendFile {
  name: string;
  bytes: Uint8Array;
}

/** What main knows about the pane's host, from its last config probe. */
export interface RemoteSendTarget {
  allowInput?: boolean;
  allowUpload?: boolean;
  generalFileUpload?: boolean;
  /** The host's `process.platform`: picks the path syntax and quoting. */
  hostPlatform?: string;
  /** The pane's shell enters WSL on a Windows host. */
  wsl?: boolean;
}

export interface RemoteSendDeps {
  upload: (bytes: Uint8Array, ext: string | null) => Promise<RemoteUploadResult>;
  /** Aborted when the pane is detached: the send stops and nothing is typed. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The one wait before retrying a 429. The host answers 429 before it reads a
 * byte of the body (WebTerminalServer `handleUpload`), so the refused request
 * stored nothing and a retry cannot leave a second file.
 */
export const REMOTE_UPLOAD_RETRY_MS = 1_500;

const UPLOADS_DISABLED_TAG = 'uploads-disabled:';
const PROMPT_ACTIVE_TAG = 'terminal-prompt-active';

/** The extension `/api/upload-file` takes: 1-12 ASCII alphanumerics, else `bin`. */
function fileExtension(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : 'bin';
}

function uploadFailure(status: number, error: string): RemoteSendFailure {
  if (status === 403 && error.startsWith(UPLOADS_DISABLED_TAG)) return 'uploads-disabled';
  if (status === 413) return 'too-large';
  if (status === 415) return 'unsupported';
  if (status === 429) return 'busy';
  if (status === 507) return 'full';
  return 'failed';
}

/**
 * An absolute path on a local disk: on Windows only a drive path (`C:\…`), so
 * nothing starting with `\` or `/` (a share, `\??\…`); elsewhere not `//…`.
 */
export function isLocalAbsolutePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:\\/.test(p);
  return path.isAbsolute(p) && !p.startsWith('//') && !p.startsWith('\\\\');
}

/**
 * Read one dropped file through a single descriptor: an absolute local path
 * to a regular file (not a link, not a network share), the same file that was
 * checked, at most the host's cap, and no longer than it was when checked.
 */
async function readDroppedFile(p: string): Promise<RemoteSendFile | RemoteSendFailure> {
  if (!isLocalAbsolutePath(p)) return 'not-a-file';
  const before = await fsp.lstat(p, { bigint: true }).catch(() => null);
  if (!before || !before.isFile()) return 'not-a-file';
  if (before.size > REMOTE_UPLOAD_LIMITS.MAX_BYTES) return 'too-large';
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fsp.open(p, fsConstants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) return 'not-a-file';
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !sameFileId(stat, before)) return 'not-a-file';
    if (stat.size > REMOTE_UPLOAD_LIMITS.MAX_BYTES) return 'too-large';
    const size = Number(stat.size);
    // One byte past the checked size: a file still growing is refused, not cut short.
    const buf = Buffer.alloc(size + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > size) return 'not-a-file';
    return { name: path.basename(p), bytes: buf.subarray(0, filled) };
  } catch {
    return 'not-a-file';
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Read the paths of one OS drop for sending, at most MAX_FILES of them. */
export async function readDroppedFiles(paths: readonly string[]): Promise<RemoteSendFile[] | { reason: RemoteSendFailure }> {
  if (paths.length === 0) return { reason: 'not-a-file' };
  if (paths.length > REMOTE_UPLOAD_LIMITS.MAX_FILES) return { reason: 'too-many' };
  const files: RemoteSendFile[] = [];
  for (const p of paths) {
    const read = await readDroppedFile(p);
    if (typeof read === 'string') return { reason: read };
    files.push(read);
  }
  return files;
}

/**
 * Why the host's grants refuse a send before any file is read, or null.
 * Unknown grants count as refused: main probes before asking.
 */
export function grantRefusal(target: RemoteSendTarget): RemoteSendFailure | null {
  if (target.allowInput !== true) return 'read-only';
  if (target.allowUpload !== true) return 'uploads-disabled';
  if (!target.hostPlatform) return 'host-unknown';
  return null;
}

export async function uploadFilesForRemote(
  files: readonly RemoteSendFile[],
  target: RemoteSendTarget,
  deps: RemoteSendDeps,
): Promise<RemoteSendResult> {
  const fail = (reason: RemoteSendFailure): RemoteSendResult => ({ ok: false, reason });
  const refused = grantRefusal(target);
  if (refused) return fail(refused);
  if (files.length === 0) return fail('not-a-file');
  if (files.length > REMOTE_UPLOAD_LIMITS.MAX_FILES) return fail('too-many');
  const routes = files.map((f) => (sniffRoomImage(f.bytes) ? null : fileExtension(f.name)));
  // A host that does not advertise general files takes JPEG and PNG only.
  if (target.generalFileUpload !== true && routes.some((ext) => ext !== null)) return fail('photos-only');
  for (const f of files) if (f.bytes.length > REMOTE_UPLOAD_LIMITS.MAX_BYTES) return fail('too-large');

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const texts: string[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      if (deps.signal?.aborted) return fail('pane-changed');
      let res = await deps.upload(files[i].bytes, routes[i]);
      if (!res.ok && res.status === 429) {
        await sleep(REMOTE_UPLOAD_RETRY_MS);
        if (deps.signal?.aborted) return fail('pane-changed');
        res = await deps.upload(files[i].bytes, routes[i]);
      }
      if (!res.ok) return fail(uploadFailure(res.status, res.error));
      const typed = remoteUploadPathText(res.path, { hostPlatform: target.hostPlatform, wsl: target.wsl });
      if (!typed.ok) return fail(typed.reason);
      texts.push(typed.text);
    }
  } catch (err) {
    if (deps.signal?.aborted) return fail('pane-changed');
    return fail(isRemoteAuthRejected(err) ? 'auth' : 'failed');
  }
  return { ok: true, text: texts.join(' '), count: files.length };
}

/**
 * Why a write of the typed paths failed, said honestly: a refusal the host
 * answered (or one made before any request) applied nothing; a transport
 * failure may have reached the pane first.
 */
export function remoteWriteFailure(err: unknown): Exclude<RemoteWriteResult, { ok: true }>['reason'] {
  if (isRemoteAuthRejected(err) || isRemoteInsecureTransport(err)) return 'auth';
  if (err instanceof Error && err.message.startsWith(PROMPT_ACTIVE_TAG)) return 'prompt-active';
  const name = err instanceof Error ? err.name : '';
  if (name === 'TypeError' || name === 'TimeoutError' || name === 'AbortError') return 'unknown';
  return 'failed';
}
