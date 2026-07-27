import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

// X1: the old machine-global getListeningPorts()/collect() pair is gone —
// ports are now PID-tree-scoped via PortWatcher (src/main/pty/portWatch.ts)
// and the metadata poll assembles payloads from watcher-fed caches
// (metadata.handler.buildMetadataPayload). Only the git-branch exec
// fallback remains, for sessions the fs.watch GitContextWatcher missed.
export class MetadataCollector {
  async getGitBranch(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        timeout: 3000,
        env: getExecEnv(),
      });
      const branch = stdout.trim();
      return branch || undefined;
    } catch {
      return undefined;
    }
  }
}
