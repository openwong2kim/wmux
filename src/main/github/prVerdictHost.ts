// The real ports of verify.recordVerdict (pipe/handlers/verify.rpc.ts): the
// repo key from the cwd's remote (the same detectRemote Moa's merge lane keys
// its decisions by, so the two compare equal), the merge lane's fresh PR read
// (gh, or glab for a GitLab remote: hostLane.ts), git in the verifier's cwd,
// and the app's verdict store.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VerifyRpcDeps } from '../pipe/handlers/verify.rpc';
import { detectRemote } from './PrProvider';
import { readLaneFacts } from './hostLane';
import { getPrVerdictStore } from './prVerdictStore';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

export function prVerdictHostPorts(): Pick<VerifyRpcDeps, 'repoKeyOf' | 'readPr' | 'git' | 'record'> {
  return {
    repoKeyOf: async (cwd) => (await detectRemote(cwd))?.key ?? null,
    readPr: async (repoPath, key, n) => {
      const r = await readLaneFacts(repoPath, key, n);
      if (!r.ok) throw new Error(r.message);
      return r.value;
    },
    git: async (args, cwd) => {
      try {
        const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
        return stdout.trim();
      } catch {
        return null;
      }
    },
    record: (rec) => getPrVerdictStore().record(rec),
  };
}
