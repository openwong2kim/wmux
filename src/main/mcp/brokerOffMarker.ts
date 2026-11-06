import * as fs from 'fs';
import * as path from 'path';
import { getMcpBrokerOffMarkerPath, getMcpBrokerPipeName } from '../../shared/constants';
import { canConnectBrokerPipe } from './brokerProbe';

/**
 * What the broker supervisor does to the filesystem when its breaker trips
 * or it first starts. Every step is best effort: a failure is logged and
 * never thrown into the main process.
 */
export interface BrokerOffEffects {
  /** Write the marker that sends native launchers to their own server. */
  mark(): void;
  /** Remove the marker. */
  clear(): void;
  /** Remove the broker's socket file when nothing answers on it (Unix only). */
  unlinkStaleSocket(): Promise<void>;
}

function bestEffort(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') console.warn(`[BrokerSupervisor] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function brokerOffEffects(
  markerPath: () => string = getMcpBrokerOffMarkerPath,
  pipeName: () => string = getMcpBrokerPipeName,
  pipeAnswers: () => Promise<boolean> = () => canConnectBrokerPipe(200),
): BrokerOffEffects {
  return {
    mark: () =>
      bestEffort('writing the broker-off marker', () => {
        const marker = markerPath();
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, '');
      }),
    clear: () => bestEffort('removing the broker-off marker', () => fs.unlinkSync(markerPath())),
    unlinkStaleSocket: async () => {
      // A named pipe goes away with its owner; only a socket file can be left.
      if (process.platform === 'win32') return;
      try {
        if (await pipeAnswers()) return;
      } catch {
        return;
      }
      bestEffort('removing the stale broker socket', () => fs.unlinkSync(pipeName()));
    },
  };
}
