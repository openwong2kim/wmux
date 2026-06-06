import * as crypto from 'crypto';

export const CDP_PORT_MIN = 18800;
export const CDP_PORT_MAX = 18899;

export interface CdpRemoteDebuggingConfig {
  enabled: boolean;
  port: number;
  reason?: string;
}

interface ResolveCdpRemoteDebuggingOptions {
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
  randomInt?: (max: number) => number;
}

function parseExplicitPort(value: string | undefined): number | null {
  if (!value) return null;

  const port = Number(value);
  if (!Number.isInteger(port) || port < CDP_PORT_MIN || port > CDP_PORT_MAX) {
    throw new Error(
      `WMUX_CDP_PORT must be an integer in the range ${CDP_PORT_MIN}-${CDP_PORT_MAX}`,
    );
  }

  return port;
}

/**
 * Resolve whether Electron's unauthenticated Chromium remote debugging endpoint
 * should be exposed. Production builds require an explicit opt-in so arbitrary
 * web content loaded in a wmux <webview> cannot rely on a default CDP listener
 * to reach privileged renderer APIs.
 */
export function resolveCdpRemoteDebuggingConfig({
  env = process.env,
  isPackaged,
  randomInt = crypto.randomInt,
}: ResolveCdpRemoteDebuggingOptions): CdpRemoteDebuggingConfig {
  if (env.WMUX_DISABLE_CDP === 'true') {
    return { enabled: false, port: 0, reason: 'disabled by WMUX_DISABLE_CDP' };
  }

  if (isPackaged && env.WMUX_ENABLE_CDP !== 'true') {
    return { enabled: false, port: 0, reason: 'disabled by default in packaged builds' };
  }

  const explicitPort = parseExplicitPort(env.WMUX_CDP_PORT);
  const port = explicitPort ?? CDP_PORT_MIN + randomInt(CDP_PORT_MAX - CDP_PORT_MIN + 1);
  return { enabled: true, port };
}
