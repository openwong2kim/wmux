import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitExecEnv } from '../../shared/execEnv';
import { preparePaneCommand, type PaneCommandTarget } from '../git/paneCommand';

const execFileAsync = promisify(execFile);

// X1: the old machine-global getListeningPorts()/collect() pair is gone —
// ports are now PID-tree-scoped via PortWatcher (src/main/pty/portWatch.ts)
// and the metadata poll assembles payloads from watcher-fed caches
// (metadata.handler.buildMetadataPayload). Only the git-branch exec
// fallback remains, for sessions the fs.watch GitContextWatcher missed.
export class MetadataCollector {
  constructor(
    private exec: typeof execFileAsync = execFileAsync,
  ) {}

  async getGitBranch(target: PaneCommandTarget): Promise<string | undefined> {
    try {
      const command = preparePaneCommand(target, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!command.ok) return undefined;
      const { stdout } = await this.exec(command.file, command.args, {
        ...(command.cwd ? { cwd: command.cwd } : {}),
        timeout: 3000,
        env: getGitExecEnv(),
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const branch = stdout.trim();
      return branch || undefined;
    } catch {
      return undefined;
    }
  }
}
