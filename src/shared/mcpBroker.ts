/**
 * Whether the shared MCP broker is on: one rule for the app and the CLI.
 *
 * WMUX_MCP_BROKER=1 turns it on and WMUX_MCP_BROKER=0 turns it off on every
 * platform. Unset (or any other value) leaves it to the platform default,
 * which is off everywhere today (BROKER_DEFAULT_ON is empty).
 */

/** The platforms where an unset WMUX_MCP_BROKER means on. Empty: off everywhere. */
export const BROKER_DEFAULT_ON: readonly NodeJS.Platform[] = [];

export type BrokerFlag = 'on' | 'off' | 'unset';

/** What WMUX_MCP_BROKER asks for: '1' → on, '0' → off, anything else → unset. */
export function brokerFlag(value: string | undefined): BrokerFlag {
  if (value === '1') return 'on';
  if (value === '0') return 'off';
  return 'unset';
}

/** Whether the app runs the broker on `platform` for this WMUX_MCP_BROKER value. */
export function brokerDefault(
  platform: NodeJS.Platform,
  value: string | undefined,
  defaultOn: readonly NodeJS.Platform[] = BROKER_DEFAULT_ON,
): boolean {
  const flag = brokerFlag(value);
  return flag === 'on' || (flag === 'unset' && defaultOn.includes(platform));
}
