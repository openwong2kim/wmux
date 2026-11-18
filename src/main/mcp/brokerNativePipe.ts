import { loadNativePipe, type NativePipeModule } from '../../mcp/nativePipe';
import { brokerHostsSessions } from '../../shared/mcpBroker';

/**
 * The native pipe module as main loads it (Windows; the same capability the
 * broker needs, src/mcp/nativePipe.ts), read once per app run. `module` is
 * null off Windows, and on Windows when the terminal core lacks it (`error`
 * says why).
 */
export interface BrokerNativePipe {
  module: NativePipeModule | null;
  error: string | null;
}

let loaded: BrokerNativePipe | undefined;

export function brokerNativePipe(load: () => NativePipeModule | null = loadNativePipe): BrokerNativePipe {
  if (loaded) return loaded;
  try {
    loaded = { module: load(), error: null };
  } catch (err) {
    loaded = { module: null, error: err instanceof Error ? err.message : String(err) };
  }
  return loaded;
}

/** Tests only: forget the module read. */
export function resetBrokerNativePipeForTests(): void {
  loaded = undefined;
}

/**
 * Whether the broker can host agents in this app: every platform but
 * Windows, and Windows when the terminal core has the native pipe listener.
 */
export function brokerHostsSessionsHere(platform: NodeJS.Platform = process.platform): boolean {
  return brokerHostsSessions(platform, () => brokerNativePipe().module !== null);
}
