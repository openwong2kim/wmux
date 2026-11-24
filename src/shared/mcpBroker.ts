/**
 * Whether the shared MCP broker is on: one rule for the app and the CLI.
 *
 * In order: WMUX_MCP_BROKER=1 turns it on and WMUX_MCP_BROKER=0 turns it off
 * on every platform; otherwise the Settings choice (`mcp-broker.json`, see
 * brokerSetting.ts) decides when it is `on` or `off`; otherwise the platform
 * default (BROKER_DEFAULT_ON): on for macOS and Linux, off for Windows.
 */

/**
 * The platforms where an unset WMUX_MCP_BROKER and a Default Settings choice
 * mean on. Not win32: there the broker hosts sessions only through the native
 * pipe listener of the terminal core (brokerHostsSessions), and stays off
 * unless it is turned on.
 */
export const BROKER_DEFAULT_ON: readonly NodeJS.Platform[] = ['darwin', 'linux'];

export type BrokerFlag = 'on' | 'off' | 'unset';

/**
 * The broker's exit code when something that is not a socket sits at its
 * socket path, or (Windows) another owner holds its pipe name: a condition a
 * restart cannot fix, so the supervisor stops.
 */
export const BROKER_EXIT_PATH_OCCUPIED = 78;

/**
 * The broker's exit code when its peer self-check never came back available
 * through the whole retry schedule (src/mcp/brokerPeer.ts), or (Windows) when
 * the terminal core lacks the native pipe listener: it would refuse every
 * session, so the supervisor stops it the way it does for 78.
 */
export const BROKER_EXIT_PEER_UNAVAILABLE = 79;

/**
 * Whether the broker can host agents on `platform`. On win32 only when the
 * terminal core has the native pipe listener (`nativePipeLoads`; main asks
 * src/main/mcp/brokerNativePipe.ts): without it the broker stops at start,
 * so On only adds a process that exits there.
 */
export function brokerHostsSessions(platform: NodeJS.Platform, nativePipeLoads: () => boolean = () => false): boolean {
  return platform !== 'win32' || nativePipeLoads();
}

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
  /** The WMUX_MCP_BROKER value as set (trimmed), when it decides (brokerFlagValue). */
  envValue?: string;
  /** What this app decided at start. */
  running: BrokerDecision;
  /** What the next start decides with `saved`. */
  next: BrokerDecision;
  /** Whether this platform's default is on. */
  platformDefaultOn: boolean;
  /**
   * False where the broker cannot host sessions (win32 without the native
   * pipe listener, brokerHostsSessions), so On only adds an idle process there.
   */
  hostsSessions: boolean;
  /** Set when this app stopped the broker because its peer self-check never passed. */
  peerUnavailable?: boolean;
  /**
   * Set when this app stopped the broker because its pipe or socket path is
   * held by something else (another owner's pipe on Windows): no restart
   * frees it, and agents use their own MCP server.
   */
  pathOccupied?: boolean;
}

/**
 * The spellings WMUX_MCP_BROKER takes, compared trimmed and in any case. Off
 * matters most: unset means on for macOS and Linux, so a value someone set to
 * keep the broker off must not fall through to that default.
 */
const ON_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'on', 'yes']);
const OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);

/**
 * What WMUX_MCP_BROKER asks for: 1/true/on/yes → on, 0/false/off/no → off,
 * trimmed and in any case. Anything else is unset, and so is an empty value
 * (`WMUX_MCP_BROKER=` with nothing after it): both follow Settings, then the
 * platform default.
 */
export function brokerFlag(value: string | undefined): BrokerFlag {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '') return 'unset';
  if (ON_VALUES.has(v)) return 'on';
  if (OFF_VALUES.has(v)) return 'off';
  return 'unset';
}

/**
 * The WMUX_MCP_BROKER value as it was set (trimmed), for saying what decided
 * the broker; undefined when it decides nothing. Bounded by the spellings
 * above, since only those decide.
 */
export function brokerFlagValue(value: string | undefined): string | undefined {
  return brokerFlag(value) === 'unset' ? undefined : value?.trim();
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
