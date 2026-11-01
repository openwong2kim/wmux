// Bounded, cancellable local filesystem jobs. No permanent-delete RPC exists.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { shell } from 'electron';
import { isPluginRefusedPath, resolvePluginPath } from './fsRefusals';
import { validatePathParam } from './fs.rpc';
import type { RpcRouter } from '../RpcRouter';

type Kind = 'copy' | 'move' | 'trash';
type Conflict = 'skip' | 'overwrite' | 'fail';
export interface FsJob {
  id: string;
  kind: Kind;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  totalBytes: number;
  doneBytes: number;
  totalItems: number;
  doneItems: number;
  current?: string;
  errors: { path: string; reason: string }[];
}
class Refusal extends Error {}
const fail = (reason: string): never => { throw new Refusal(reason); };
const reasonOf = (e: unknown) => e instanceof Refusal ? e.message
  : ({ EEXIST: 'exists', ENOENT: 'unavailable', EACCES: 'denied', EPERM: 'denied', ENOTDIR: 'not-a-directory' }[(e as NodeJS.ErrnoException)?.code ?? ''] ?? 'failed');
const validName = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && !/[\\/\0]/.test(s) && s !== '.' && s !== '..';
const overlaps = (a: string, b: string) => {
  const inside = (x: string, y: string) => { const r = path.relative(x, y); return !r || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
  return inside(a, b) || inside(b, a);
};
/**
 * Puts a finished temp file at a destination that did not exist. A hard link
 * cannot replace an entry that appeared meanwhile; volumes without hard links
 * (exFAT, FAT32, some network shares) fall back to a rename after a fresh
 * existence check.
 */
async function linkOrRename(temp: string, dest: string): Promise<void> {
  try {
    await fs.promises.link(temp, dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOENT') throw e;
    if (await exists(dest)) fail('exists');
    await fs.promises.rename(temp, dest);
  }
}
const exists = async (p: string) => { try { return await fs.promises.lstat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };

/** Validate the target too, but retain the directory entry when it is a link. */
async function accessible(input: unknown, missing = false): Promise<string> {
  const p = validatePathParam(input);
  if (!p) return fail('invalid');
  if (!validName(path.basename(p)) && path.dirname(p) !== p) return fail('invalid');
  const canonical = await resolvePluginPath(p);
  const stat = await exists(p);
  if (canonical && !stat?.isSymbolicLink()) return canonical;
  const parent = await resolvePluginPath(path.dirname(p));
  if (!parent) return fail('unavailable');
  const entry = path.join(parent, path.basename(p));
  if (isPluginRefusedPath(p) || isPluginRefusedPath(entry)) return fail('unavailable');
  if (stat?.isSymbolicLink()) {
    const target = path.resolve(parent, await fs.promises.readlink(entry));
    if (isPluginRefusedPath(target) || (!canonical && await exists(target))) return fail('unavailable');
    return entry;
  }
  if (!stat && missing) return entry;
  return fail('unavailable');
}

interface RecordJob { job: FsJob; controller: AbortController; locks: string[]; finished?: number }
export class FsJobQueue {
  private jobs = new Map<string, RecordJob>();
  constructor(private trashItem: (p: string) => Promise<void> = (p) => shell.trashItem(p), private now = Date.now) {}

  private prune() {
    for (const [id, r] of this.jobs) if (r.finished !== undefined && this.now() - r.finished >= 600_000) this.jobs.delete(id);
  }
  private checkLocks(paths: string[]) {
    for (const r of this.jobs.values()) if (r.job.state === 'running' && paths.some((p) => r.locks.some((q) => overlaps(p, q)))) fail('busy');
  }
  status(jobId: unknown) {
    this.prune();
    const r = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined;
    return r ? { ok: true as const, job: structuredClone(r.job) } : { ok: false as const, reason: 'unavailable' };
  }
  cancel(jobId: unknown) {
    const r = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined;
    if (!r) return { ok: false, reason: 'unavailable' };
    if (r.job.state === 'running') r.controller.abort();
    return { ok: true };
  }
  async mkdir(params: Record<string, unknown>) {
    try {
      const p = await accessible(params.path, true);
      this.checkLocks([p]);
      await fs.promises.mkdir(p);
      return { ok: true, path: p };
    } catch (e) { return { ok: false, reason: reasonOf(e) }; }
  }
  async rename(params: Record<string, unknown>) {
    try {
      if (!validName(params.newName)) fail('invalid');
      const src = await accessible(params.path);
      const dest = await accessible(path.join(path.dirname(src), params.newName as string), true);
      this.checkLocks([src, dest]);
      if (await exists(dest)) fail('exists');
      await this.scan(src); // Refuse credential descendants before moving a tree.
      this.checkLocks([src, dest]);
      await fs.promises.rename(src, dest);
      return { ok: true, path: dest };
    } catch (e) { return { ok: false, reason: reasonOf(e) }; }
  }
  /** Preflight every descendant; links are validated but never traversed. */
  private async scan(p: string, signal?: AbortSignal): Promise<{ bytes: number; items: number }> {
    signal?.throwIfAborted();
    await accessible(p);
    const s = await fs.promises.lstat(p);
    const total = { bytes: s.isFile() ? s.size : 0, items: 1 };
    if (s.isDirectory()) for (const name of await fs.promises.readdir(p)) {
      const sub = await this.scan(path.join(p, name), signal);
      total.bytes += sub.bytes; total.items += sub.items;
    }
    return total;
  }
  async start(kind: Kind, params: Record<string, unknown>) {
    try {
      this.prune();
      const inputs = kind === 'trash' ? params.paths : params.sources;
      if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 32) fail('invalid');
      const sources = await Promise.all((inputs as unknown[]).map((p) => accessible(p)));
      let destDir: string | undefined;
      const conflict = params.conflict as Conflict;
      if (kind !== 'trash') {
        if (!['skip', 'overwrite', 'fail'].includes(conflict)) fail('invalid');
        destDir = await resolvePluginPath(await accessible(params.destDir)) ?? fail('unavailable');
        if (!(await fs.promises.stat(destDir)).isDirectory()) fail('not-a-directory');
        for (const src of sources) {
          const dest = await accessible(path.join(destDir, path.basename(src)), true);
          const realSource = await resolvePluginPath(src);
          const realDest = await resolvePluginPath(dest);
          if (src === dest || (realSource && realDest && realSource === realDest)
            || ((await fs.promises.lstat(src)).isDirectory() && overlaps(src, realDest ?? dest))) fail('invalid');
        }
      }
      for (let i = 0; i < sources.length; i++) if (sources.slice(i + 1).some((s) => overlaps(sources[i], s))) fail('invalid');
      const locks = [...sources, ...(destDir ? [destDir] : [])];
      this.checkLocks(locks);
      if ([...this.jobs.values()].filter((r) => r.job.state === 'running').length >= 4) fail('busy');
      const job: FsJob = { id: randomUUID(), kind, state: 'running', totalBytes: 0, doneBytes: 0, totalItems: 0, doneItems: 0, errors: [] };
      const record: RecordJob = { job, locks, controller: new AbortController() };
      this.jobs.set(job.id, record);
      void this.run(record, sources, destDir, conflict);
      return { ok: true as const, jobId: job.id };
    } catch (e) { return { ok: false as const, reason: reasonOf(e) }; }
  }
  private async run(r: RecordJob, sources: string[], destDir: string | undefined, conflict: Conflict) {
    const { job, controller } = r;
    try {
      // Complete security preflight before performing any mutation.
      const totals = [];
      for (const src of sources) totals.push(await this.scan(src, controller.signal));
      job.totalBytes = totals.reduce((n, t) => n + t.bytes, 0);
      job.totalItems = totals.reduce((n, t) => n + t.items, 0);
      for (const [i, src] of sources.entries()) {
        controller.signal.throwIfAborted(); job.current = src;
        try {
          if (job.kind === 'trash') {
            await this.trashItem(await accessible(src));
            job.doneBytes += totals[i].bytes; job.doneItems += totals[i].items;
          } else {
            const dest = path.join(destDir ?? fail('invalid'), path.basename(src));
            if (job.kind === 'move' && !(await exists(dest))) {
              try {
                await fs.promises.rename(await accessible(src), await accessible(dest, true));
                job.doneBytes += totals[i].bytes; job.doneItems += totals[i].items;
                continue;
              } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
            }
            const complete = await this.copy(src, dest, conflict, r);
            controller.signal.throwIfAborted();
            if (job.kind === 'move' && complete) await fs.promises.rm(await accessible(src), { recursive: true });
          }
        } catch (e) {
          if (controller.signal.aborted) throw e;
          job.errors.push({ path: src, reason: reasonOf(e) });
        }
      }
      job.state = job.errors.length ? 'failed' : 'done';
    } catch (e) {
      job.state = controller.signal.aborted ? 'cancelled' : 'failed';
      if (!controller.signal.aborted) job.errors.push({ path: job.current ?? sources[0], reason: reasonOf(e) });
    } finally { r.finished = this.now(); }
  }
  private async copy(src: string, dest: string, conflict: Conflict, r: RecordJob): Promise<boolean> {
    const { job, controller: { signal } } = r;
    signal.throwIfAborted();
    await accessible(src); await accessible(dest, true);
    job.current = src;
    const s = await fs.promises.lstat(src);
    const target = await exists(dest);
    if (target) {
      if (conflict === 'fail') fail('exists');
      if (conflict === 'skip') {
        const t = await this.scan(src, signal); job.doneBytes += t.bytes; job.doneItems += t.items;
        return false;
      }
      // Rename replaces the entry itself; never stream through a destination link.
      if (s.isDirectory() !== target.isDirectory()) fail('exists');
    }
    if (s.isDirectory()) {
      if (!target) await fs.promises.mkdir(dest);
      let complete = true;
      for (const name of await fs.promises.readdir(src)) {
        if (!await this.copy(path.join(src, name), path.join(dest, name), conflict, r)) complete = false;
      }
      await fs.promises.utimes(dest, s.atime, s.mtime);
      job.doneItems++;
      return complete;
    }
    const temp = path.join(path.dirname(dest), `.wmux-copy-${randomUUID()}`);
    try {
      if (s.isSymbolicLink()) await fs.promises.symlink(await fs.promises.readlink(src), temp);
      else if (s.isFile()) {
        await pipeline(fs.createReadStream(src), new Transform({ transform(chunk: Buffer, _encoding, callback) {
          job.doneBytes += chunk.length; callback(null, chunk);
        } }), fs.createWriteStream(temp, { flags: 'wx', mode: s.mode & 0o777 }), { signal });
        await fs.promises.utimes(temp, s.atime, s.mtime);
      } else fail('invalid');
      signal.throwIfAborted();
      if (!target) {
        // link is exclusive, unlike rename on POSIX: a new destination never gets clobbered.
        if (s.isSymbolicLink()) await fs.promises.symlink(await fs.promises.readlink(temp), dest);
        else await linkOrRename(temp, dest);
      } else await fs.promises.rename(temp, dest);
      job.doneItems++;
      return true;
    } finally { await fs.promises.rm(temp, { force: true }); }
  }
}

export function registerFsWriteRpc(router: RpcRouter, queue = new FsJobQueue()): void {
  router.register('fs.mkdir', (p) => queue.mkdir(p));
  router.register('fs.rename', (p) => queue.rename(p));
  router.register('fs.copy', (p) => queue.start('copy', p));
  router.register('fs.move', (p) => queue.start('move', p));
  router.register('fs.trash', (p) => queue.start('trash', p));
  router.register('fs.job.status', async (p) => queue.status(p.jobId));
  router.register('fs.job.cancel', async (p) => queue.cancel(p.jobId));
}
