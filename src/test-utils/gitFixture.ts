import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** Configure a freshly initialized template before its first commit. */
export function disableGitMaintenance(repo: string): void {
  // commit can return while detached maintenance still creates/removes
  // .git/objects/maintenance.lock or repacks objects. A byte-copy template must
  // remain immutable until cleanup; its copies inherit the same protection.
  // gc.auto also covers Git versions that use auto-gc instead of maintenance.
  appendFileSync(join(repo, '.git', 'config'), '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');
}
