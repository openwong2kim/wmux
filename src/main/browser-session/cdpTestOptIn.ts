import { PORTABLE_DATA_SUFFIX } from '../dataIsolation';

/** The env var a test harness sets on the instance it launches. */
export const TEST_CDP_OPT_IN_ENV = 'WMUX_TEST_CDP_PORT';

export interface CdpTestOptInInputs {
  env: NodeJS.ProcessEnv;
  /** The instance suffix (`dataSuffix()`). */
  suffix: string;
  /**
   * Whether CDP is enabled at all: the value the port decision in
   * src/main/index.ts computes (`WMUX_DISABLE_CDP` and `browser.cdp.enabled`).
   */
  cdpEnabled: boolean;
}

/**
 * The test harness opt-in: `WMUX_TEST_CDP_PORT=1` on an isolated instance.
 *
 * Honoured only with a non-empty instance suffix other than `-portable`, so
 * the default instance and portable copies never take it. A disabled CDP
 * always wins. The value must be exactly `1`.
 */
export function cdpTestOptIn({ env, suffix, cdpEnabled }: CdpTestOptInInputs): boolean {
  if (!cdpEnabled) return false;
  if (env[TEST_CDP_OPT_IN_ENV] !== '1') return false;
  return suffix !== '' && suffix !== PORTABLE_DATA_SUFFIX;
}
