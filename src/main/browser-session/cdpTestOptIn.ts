import { PORTABLE_DATA_SUFFIX } from '../dataIsolation';

/** The env var a test harness sets on the instance it launches. */
export const TEST_CDP_OPT_IN_ENV = 'WMUX_TEST_CDP_PORT';

export interface CdpTestOptInInputs {
  env: NodeJS.ProcessEnv;
  /** The instance suffix (`dataSuffix()`). */
  suffix: string;
  /** `loadConfig().browser?.cdp?.enabled !== false`. */
  cdpEnabledInConfig: boolean;
}

/**
 * The test harness opt-in: `WMUX_TEST_CDP_PORT=1` on an isolated instance.
 *
 * Honoured only with a non-empty instance suffix other than `-portable`, so
 * the default instance and portable copies never take it. A disabled CDP
 * (`WMUX_DISABLE_CDP=true` or `browser.cdp.enabled: false`) always wins.
 * The value must be exactly `1`.
 */
export function cdpTestOptIn({ env, suffix, cdpEnabledInConfig }: CdpTestOptInInputs): boolean {
  if (env[TEST_CDP_OPT_IN_ENV] !== '1') return false;
  if (suffix === '' || suffix === PORTABLE_DATA_SUFFIX) return false;
  if (env.WMUX_DISABLE_CDP === 'true') return false;
  return cdpEnabledInConfig;
}
