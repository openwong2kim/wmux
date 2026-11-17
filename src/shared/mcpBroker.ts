/**
 * Whether the shared MCP broker is on: one rule for the app and the CLI.
 *
 * In order: WMUX_MCP_BROKER=1 turns it on and WMUX_MCP_BROKER=0 turns it off
 * on every platform; otherwise the Settings choice (`mcp-broker.json`, see
 * brokerSetting.ts) decides when it is `on` or `off`; otherwise the platform
 * default, which is off everywhere today (BROKER_DEFAULT_ON is empty).
 */

/** The platforms where an unset WMUX_MCP_BROKER means on. Empty: off everywhere. */
export const BROKER_DEFAULT_ON: readonly NodeJS.Platform[] = [];

export type BrokerFlag = 'on' | 'off' | 'unset';

/** The Settings choice: `default` follows the platform. */
export type BrokerSetting = 'on' | 'off' | 'default';

export const BROKER_SETTINGS: readonly BrokerSetting[] = ['default', 'on', 'off'];

export function isBrokerSetting(value: unknown): value is BrokerSetting {
  return typeof value === 'string' && (BROKER_SETTINGS as readonly string[]).includes(value);
}

/** What decided it: the app's environment, the Settings choice, or the platform. */
export type BrokerSource = 'env' | 'setting' | 'default';

export interface BrokerDecision {
  on: boolean;
  source: BrokerSource;
}

/** What Settings reads and gets back after a change (IPC mcp:broker-setting:*). */
export interface BrokerSettingPayload {
  saved: BrokerSetting;
  /** Set when mcp-broker.json is there but was not used. */
  problem?: string;
  env: BrokerFlag;
  /** What this app decided at start. */
  running: BrokerDecision;
  /** What the next start decides with `saved`. */
  next: BrokerDecision;
  /** Whether this platform's default is on. */
  platformDefaultOn: boolean;
  /**
   * False where the broker refuses every session (win32: no peer pid to
   * verify, src/mcp/brokerPeer.ts), so On only adds an idle process there.
   */
  hostsSessions: boolean;
}

/** What WMUX_MCP_BROKER asks for: '1' → on, '0' → off, anything else → unset. */
export function brokerFlag(value: string | undefined): BrokerFlag {
  if (value === '1') return 'on';
  if (value === '0') return 'off';
  return 'unset';
}

/** The rule above, with what decided it. */
export function brokerDecision(
  platform: NodeJS.Platform,
  envValue: string | undefined,
  setting: BrokerSetting,
  defaultOn: readonly NodeJS.Platform[] = BROKER_DEFAULT_ON,
): BrokerDecision {
  const flag = brokerFlag(envValue);
  if (flag !== 'unset') return { on: flag === 'on', source: 'env' };
  if (setting !== 'default') return { on: setting === 'on', source: 'setting' };
  return { on: defaultOn.includes(platform), source: 'default' };
}

/**
 * Whether `wmux mcp register` may point agents at the broker, before it checks
 * that the broker's pipe answers. No when WMUX_MCP_BROKER=0 or the Settings
 * choice turns it off. An unset default still probes: the app may have been
 * started with WMUX_MCP_BROKER=1, which this shell does not see.
 *
 * It follows the saved choice, not the running app: after Off is saved, a
 * broker the app started earlier may still run until the next start. The
 * full bundle this then registers works with or without a broker, so the
 * two differ only in memory until the app's next start re-registers.
 */
export function brokerMayRun(platform: NodeJS.Platform, envValue: string | undefined, setting: BrokerSetting): boolean {
  const decision = brokerDecision(platform, envValue, setting);
  return decision.on || decision.source === 'default';
}

/** Whether the app runs the broker on `platform` for this WMUX_MCP_BROKER value, with no Settings choice. */
export function brokerDefault(
  platform: NodeJS.Platform,
  value: string | undefined,
  defaultOn: readonly NodeJS.Platform[] = BROKER_DEFAULT_ON,
): boolean {
  return brokerDecision(platform, value, 'default', defaultOn).on;
}
