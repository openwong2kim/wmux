// ─── The Hermes bot engine's readiness (FACTORY_HERMES_READINESS) ──────────
//
// Whether a bot on Hermes Agent (Nous Research) can run on this computer,
// answered without a model turn: `hermes` is found, its version is in the
// range wmux was tested against, wmux's own Hermes home has a model, and the
// settings wmux writes there read back as written (main/factory/
// hermesEngine.ts). Never carries a credential or any part of one.

/** The Hermes Agent project page (https only; opened via shell.openExternal). */
export const HERMES_INSTALL_URL = 'https://github.com/NousResearch/hermes-agent';

/** The oldest Hermes wmux runs bots on. */
export const HERMES_VERSION_MIN = '0.22.5';
/** The first Hermes release wmux has not been tested against. */
export const HERMES_VERSION_BELOW = '0.23.0';

/** What adds Hermes's MCP support to an install that lacks it. */
export const HERMES_MCP_FIX_COMMAND = 'hermes pm install --extra mcp';

export type HermesNotReadyReason =
  | 'not-installed'
  /** Older than HERMES_VERSION_MIN: the owner updates Hermes. */
  | 'outdated'
  /** At or past HERMES_VERSION_BELOW: wmux has not been tested on it. */
  | 'unsupported'
  /** wmux's Hermes home has no model yet: the owner runs the setup once. */
  | 'not-set-up'
  /** Hermes cannot load MCP servers (its `mcp` extra is missing), so a bot
   *  would run without the wmux tools: `hermes pm install --extra mcp`. */
  | 'mcp-missing'
  /** A setting wmux writes does not read back as written. */
  | 'config-mismatch'
  | 'unknown';

export interface HermesReadiness {
  ready: boolean;
  /** Set when `ready` is false. */
  reason?: HermesNotReadyReason;
  /** The version of the install `hermes` runs, when it was read (from the
   *  install's files, main/factory/hermesInstall.ts). */
  version?: string;
  /** A short, credential-free detail for the owner (English). */
  message?: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Where `version` (X.Y.Z, or X.Y.Z-<pre>) stands against the tested range.
 *  A pre-release comes before its release, so 0.22.5-rc1 is outdated. Pure. */
export function hermesVersionStatus(version: string): 'ok' | 'outdated' | 'unsupported' {
  const [core, pre] = version.split('-', 2);
  const min = compareVersions(core, HERMES_VERSION_MIN);
  if (min < 0 || (min === 0 && pre !== undefined)) return 'outdated';
  if (compareVersions(core, HERMES_VERSION_BELOW) >= 0) return 'unsupported';
  return 'ok';
}

// ─── My Hermes: the owner's own Hermes profile (FACTORY_MY_HERMES) ─────────
//
// A bot on "My Hermes" (BotEngine `mode: 'own'`) would use the owner's own
// Hermes profile: `~/.hermes` (profile `default`) or `~/.hermes/profiles/<n>`.
// wmux never writes there; its readiness is read-only (main/factory/
// myHermes.ts). This version stores the choice but does not run it.

/** What the owner runs to update their own Hermes (wmux never does). */
export const HERMES_UPDATE_COMMAND = 'hermes update';

export type MyHermesNotReadyReason =
  /** v1 runs on macOS and Linux only. */
  | 'unsupported-os'
  | 'not-installed'
  /** The `hermes` found is not the one installed in this Hermes home. */
  | 'foreign-install'
  | 'outdated'
  | 'unsupported'
  /** The profile's folder is gone. */
  | 'profile-missing'
  /** `hermes acp --check` failed (its ACP support is missing). */
  | 'acp-missing'
  | 'no-model'
  /** approvals.mode is `off`: every command would run unasked. */
  | 'approvals-off'
  /** An MCP server named wmux (or mcp-wmux) is in the profile's config. */
  | 'wmux-mcp'
  /** A messaging platform is turned on in the profile's config or `.env`. */
  | 'messengers'
  /** The profile's gateway is running messaging platforms now. */
  | 'gateway-messengers'
  | 'unknown';

/** What the owner should know but that does not stop the bot. */
export type MyHermesNotice =
  /** approvals.mode `smart`: a helper model approves most commands. */
  | { kind: 'approvals-smart' }
  /** Commands that run without asking (command_allowlist). */
  | { kind: 'allowlist'; count: number }
  /** The profile's other MCP servers, which attach to the bot's session. */
  | { kind: 'mcp-servers'; names: string[] };

export interface MyHermesReadiness {
  ready: boolean;
  reason?: MyHermesNotReadyReason;
  version?: string;
  /** Messaging platforms found on (`messengers`, `gateway-messengers`). */
  platforms?: string[];
  /** A short, credential-free detail for the owner (English). */
  message?: string;
  notices: MyHermesNotice[];
}

/** One Hermes profile the owner could pick. */
export interface MyHermesProfile {
  /** `default` (`~/.hermes`) or a named profile's id. */
  name: string;
  /** Where it lives, as the owner reads it (`~/.hermes/profiles/coder`). */
  dir: string;
  /** The bot already on it, when one is. */
  usedBy?: { botId: string; name: string };
}

export interface MyHermesStatus {
  /** False on Windows (v1 is macOS and Linux only). */
  supported: boolean;
  profiles: MyHermesProfile[];
  /** The requested profile's readiness, when one was asked for. */
  readiness?: MyHermesReadiness;
}

/** The env names that turn a messaging platform on when set in a Hermes
 *  home's `.env` (Hermes gateway/config.py PLATFORM_TOKEN_ENV_NAMES). wmux
 *  reads only the names in that file, never a value. */
export const HERMES_MESSENGER_TOKEN_ENV: Readonly<Record<string, string>> = {
  TELEGRAM_BOT_TOKEN: 'telegram',
  DISCORD_BOT_TOKEN: 'discord',
  SLACK_BOT_TOKEN: 'slack',
  MATTERMOST_TOKEN: 'mattermost',
  MATRIX_ACCESS_TOKEN: 'matrix',
  WEIXIN_TOKEN: 'weixin',
};

/** `profile`'s folder as the owner reads it. Pure. */
export function myHermesProfileLabel(profile: string): string {
  return profile === 'default' ? '~/.hermes' : `~/.hermes/profiles/${profile}`;
}
