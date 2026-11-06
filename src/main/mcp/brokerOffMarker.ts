import * as fs from 'fs';
import * as path from 'path';
import { getMcpBrokerOffMarkerPath } from '../../shared/constants';
import { canConnectBrokerPipe } from './brokerProbe';

/**
 * What the broker supervisor does to the filesystem. Every step is best
 * effort: a failure is logged and never thrown into the main process.
 */
export interface BrokerOffEffects {
  /** A broker is starting here: no instance means it to be off any more. */
  clear(): void;
  /**
   * The breaker tripped: mark the broker off, so native launchers go straight
   * to their own server, unless another instance's broker answers on the pipe.
   */
  tripped(): Promise<void>;
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
  pipeAnswers: () => Promise<boolean> = () => canConnectBrokerPipe(200),
): BrokerOffEffects {
  return {
    clear: () => bestEffort('removing the broker-off marker', () => fs.unlinkSync(markerPath())),
    tripped: async () => {
      let served: boolean;
      try {
        served = await pipeAnswers();
      } catch {
        return;
      }
      if (served) return;
      bestEffort('writing the broker-off marker', () => {
        const marker = markerPath();
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, '');
      });
    },
  };
}
