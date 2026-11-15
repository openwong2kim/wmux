// ─── The origin of each folder this PC lets other PCs start agents in ───────
//
// A PC that places tasks itself (fanout_start with pc "any") matches the
// same repository across PCs by it: each PC mints its own root ids, so ids
// alone never match across PCs. What a PC is sent is a tag keyed per
// requester: equal for the same repository, and never the remote URL. Read
// when the policy loads or changes and on each sweep; a folder with no single
// origin, or whose origin cannot be read now, has none.

import crypto from 'node:crypto';
import type { HostId } from '../../shared/a2aRemote';
import type { A2aSpawnPolicyV1 } from '../../shared/a2aSpawn';
import { bundleGit } from './bundleMaker';
import { rootOriginKey } from './continueRootGit';

/** The tag `requester` is sent for a folder whose origin repo key is `repoKey`: 32 hex digits. Pure. */
export function spawnRootHashFor(requester: HostId, repoKey: string): string {
  return crypto.createHmac('sha256', requester).update(`wmux-spawn-root\0${repoKey}`, 'utf8').digest('hex').slice(0, 32);
}

/** Root folder → its origin repo key, read again for every root of the policy on each refresh. */
export class SpawnRootKeys {
  private byPath = new Map<string, string>();
  private queue: Promise<boolean> = Promise.resolve(false);
  private readonly policy: () => A2aSpawnPolicyV1;
  private readonly originOf: (rootPath: string) => Promise<string | null>;

  constructor(policy: () => A2aSpawnPolicyV1, originOf?: (rootPath: string) => Promise<string | null>) {
    this.policy = policy;
    this.originOf = originOf ?? ((rootPath) => rootOriginKey(bundleGit(rootPath), rootPath));
  }

  /**
   * Reads every root's origin now (one refresh at a time); a root whose origin
   * cannot be read has no key, never the one read before. Resolves true when
   * any key changed. Never rejects.
   */
  refresh(): Promise<boolean> {
    this.queue = this.queue.then(() => this.read(), () => this.read());
    return this.queue;
  }

  hashFor(requester: HostId, rootPath: string): string | undefined {
    const key = this.byPath.get(rootPath);
    return key === undefined ? undefined : spawnRootHashFor(requester, key);
  }

  private async read(): Promise<boolean> {
    const next = new Map<string, string>();
    for (const root of this.policy().roots) {
      // eslint-disable-next-line no-await-in-loop -- a policy holds a few roots
      const key = await this.originOf(root.path).catch(() => null);
      if (key) next.set(root.path, key);
    }
    const changed = next.size !== this.byPath.size || [...next].some(([p, k]) => this.byPath.get(p) !== k);
    this.byPath = next;
    return changed;
  }
}
