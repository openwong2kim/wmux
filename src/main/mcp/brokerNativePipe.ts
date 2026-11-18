import { loadNativePipe, type NativePipeModule } from '../../mcp/nativePipe';
import { brokerHostsSessions } from '../../shared/mcpBroker';

/**
 * The native pipe module as main loads it (Windows; the same capability the
 * broker needs, src/mcp/nativePipe.ts). `module` is null off Windows, and on
 * Windows when the terminal core lacks it (`error` says why).
 */
export interface BrokerNativePipe {
  module: NativePipeModule | null;
  error: string | null;
}

/** How long a failed load is answered from memory before main tries again. */
export const NATIVE_PIPE_RETRY_MS = 30_000;

let loaded: BrokerNativePipe | undefined;
/** When the failed load in `loaded` happened; null for a success. */
let failedAt: number | null = null;

/**
 * The module, loaded once on success. A failure is kept for
 * NATIVE_PIPE_RETRY_MS and then tried again, so a core that becomes loadable
 * later in the run (a file that was locked, say) is picked up.
 */
export function brokerNativePipe(
  load: () => NativePipeModule | null = loadNativePipe,
  now: () => number = Date.now,
): BrokerNativePipe {
  if (loaded && (failedAt === null || now() - failedAt < NATIVE_PIPE_RETRY_MS)) return loaded;
  try {
    loaded = { module: load(), error: null };
    failedAt = null;
  } catch (err) {
    loaded = { module: null, error: err instanceof Error ? err.message : String(err) };
    failedAt = now();
  }
  return loaded;
}

/** Tests only: forget the module read. */
export function resetBrokerNativePipeForTests(): void {
  loaded = undefined;
  failedAt = null;
}

/**
 * Whether the broker can host agents in this app: every platform but
 * Windows, and Windows when the terminal core has the native pipe listener.
 */
export function brokerHostsSessionsHere(platform: NodeJS.Platform = process.platform): boolean {
  return brokerHostsSessions(platform, () => brokerNativePipe().module !== null);
}
