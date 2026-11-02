import fs from 'node:fs';
import path from 'node:path';
import { isHostId, type HostId } from '../../shared/a2aRemote';
import { isContinueId, isContinueSessionId, normalizeContinueRel } from '../../shared/a2aContinue';

/**
 * Where the bytes of a conversation another PC hands over wait until they
 * are placed: `<a2aDir>/continue-in/<hostId>/<continueId>/`, laid out as
 * they will sit in Claude's project folder:
 *
 *   <sessionId>.jsonl    the transcript
 *   <sessionId>/<rel>    each file of the manifest
 *
 * A request holds every byte there, checked, from `received` on. Nothing
 * else ever has a name there of the form `<uuid>.jsonl` or `<uuid>/`.
 */
export function continueStagingDir(a2aDir: string, hostId: HostId, continueId: string): string {
  if (!isHostId(hostId) || !isContinueId(continueId)) throw new Error('not a continue request id');
  return path.join(a2aDir, 'continue-in', hostId, continueId);
}

/** The staged transcript of conversation `sessionId`. */
export function continueStagedTranscript(dir: string, sessionId: string): string {
  if (!isContinueSessionId(sessionId)) throw new Error('not a session id');
  return path.join(dir, `${sessionId}.jsonl`);
}

/** The staged copy of one file of the conversation's folder; `rel` as the manifest names it. */
export function continueStagedFile(dir: string, sessionId: string, rel: string): string {
  if (!isContinueSessionId(sessionId) || normalizeContinueRel(rel) !== rel) throw new Error('not a conversation file');
  return path.join(dir, sessionId, ...rel.split('/'));
}

/** `<a2aDir>/continue-in`: every request's staging dir is below it. */
export function continueStagingRoot(a2aDir: string): string {
  return path.join(a2aDir, 'continue-in');
}

/** `<a2aDir>/continue-in/<hostId>`: the staging of every request of one PC. */
export function continueStagingHostDir(a2aDir: string, hostId: HostId): string {
  if (!isHostId(hostId)) throw new Error('not a host id');
  return path.join(continueStagingRoot(a2aDir), hostId);
}

/**
 * Where a request's files are written while they arrive, before their checks
 * pass: a folder of its staging dir that the layout never names (a session id
 * is a uuid), emptied once every file is in place.
 */
export function continuePartsDir(dir: string): string {
  return path.join(dir, '.parts');
}

/**
 * Why a request's bytes cannot be staged: a link, or something other than a
 * plain folder or file, where staging needs one, or a manifest that cannot be
 * what it says. The request fails.
 */
export class ContinueStagingRefusal extends Error {}

/**
 * Make (or check) the request's staging dir, with `continue-in/` and
 * `continue-in/<hostId>/` above it, each 0700 and following no link: one that
 * is a link or not a folder is refused. Its parts folder starts empty: a part
 * file left by a transfer that never finished is not kept.
 */
export async function makeContinueStagingDir(a2aDir: string, hostId: HostId, continueId: string): Promise<string> {
  const dir = continueStagingDir(a2aDir, hostId, continueId);
  await fs.promises.mkdir(a2aDir, { recursive: true });
  for (const d of [continueStagingRoot(a2aDir), path.dirname(dir), dir]) {
    // eslint-disable-next-line no-await-in-loop -- each folder inside the one before
    await plainDir(d, true);
  }
  await fs.promises.rm(continuePartsDir(dir), { recursive: true, force: true });
  await plainDir(continuePartsDir(dir), true);
  return dir;
}

/**
 * The folders from the staging dir `dir` down to `target`'s, each a plain
 * one, never followed through a link: made 0700 when missing and `create`,
 * else a missing one answers false. A link or a non-folder on the way, or a
 * folder that resolves outside `dir`, is refused.
 */
export async function continueParentsInside(dir: string, target: string, create: boolean): Promise<boolean> {
  const rel = path.relative(dir, path.dirname(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ContinueStagingRefusal('a path outside the staging dir');
  let at = dir;
  for (const segment of rel === '' ? [] : rel.split(path.sep)) {
    at = path.join(at, segment);
    // eslint-disable-next-line no-await-in-loop -- each folder inside the one before
    if (!(await plainDir(at, create))) return false;
  }
  const [real, top] = await Promise.all([fs.promises.realpath(path.dirname(target)), fs.promises.realpath(dir)]);
  if (real !== top && !real.startsWith(top + path.sep)) throw new ContinueStagingRefusal('a folder in the staging dir resolves outside it');
  return true;
}

/** Remove a request's staging dir and everything in it (a link is removed, never followed). */
export async function removeContinueStagingDir(a2aDir: string, hostId: HostId, continueId: string): Promise<void> {
  await fs.promises.rm(continueStagingDir(a2aDir, hostId, continueId), { recursive: true, force: true });
}

/** `d` is a plain folder, made 0700 when missing and `create`; false when missing; refused when a link or not a folder. */
async function plainDir(d: string, create: boolean): Promise<boolean> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(d);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (!create) return false;
    await fs.promises.mkdir(d, { mode: 0o700 });
    return true;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ContinueStagingRefusal(`${path.basename(d)} in staging is not a plain folder`);
  // Windows keeps no such mode.
  if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o700) await fs.promises.chmod(d, 0o700);
  return true;
}
