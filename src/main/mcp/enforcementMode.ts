// Phase 2.2 enforcement mode loader (pre-commit 6).
//
// Reads `mcp.mode` from `~/.wmux/config.json` to decide whether RpcRouter
// should ENFORCE permission rejections (return RpcResponse failures) or
// just SHADOW-log them and proceed to the handler.
//
// Defaults are environment-aware:
//   - Production wmux:  enforce  (the v3.0 ship target)
//   - Dev wmux (electron-forge start, npm start, vitest, etc.):
//                       shadow   (rollback safety during dogfood — a bad
//                                 delta doesn't lock out internal RPCs)
//
// Override path: a user (or a dev who wants to dogfood enforce mode) can
// set `mcp.mode` in `~/.wmux/config.json` explicitly. The daemon's
// validateConfig is strict on its own fields but ignores unknown sections,
// so this stays compatible with the existing daemon config schema.

import * as fs from 'fs';
import { getConfigPath } from '../../daemon/config';

export type EnforcementMode = 'shadow' | 'enforce';

export interface EnforcementModeResolveOptions {
  /** When true, default to 'shadow' (dogfood safety). When false, default to 'enforce'. */
  isDev: boolean;
  /** Override the config path for tests. */
  configPath?: string;
}

export function resolveEnforcementMode(
  opts: EnforcementModeResolveOptions,
): EnforcementMode {
  const defaultMode: EnforcementMode = opts.isDev ? 'shadow' : 'enforce';
  const cfgPath = opts.configPath ?? getConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(cfgPath, 'utf-8');
  } catch {
    return defaultMode;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key, value) => {
      // Prototype pollution guard — mirrors daemon/config.ts.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    });
  } catch {
    return defaultMode;
  }
  if (!parsed || typeof parsed !== 'object') return defaultMode;
  const mcp = (parsed as Record<string, unknown>).mcp;
  if (!mcp || typeof mcp !== 'object') return defaultMode;
  const mode = (mcp as Record<string, unknown>).mode;
  if (mode === 'shadow' || mode === 'enforce') return mode;
  return defaultMode;
}

/**
 * Convenience: is this the dev electron-forge / vitest environment? Used
 * by main/index.ts to pick the right default at boot.
 *
 * `electron-forge start` / `npm start` set NODE_ENV=development. Test
 * harness (vitest) sets NODE_ENV=test. Either way, the substrate should
 * default to shadow so a bad commit doesn't lock the developer out.
 */
export function detectIsDev(): boolean {
  const env = process.env.NODE_ENV;
  if (env === 'development' || env === 'test') return true;
  // Electron exposes `app.isPackaged` — false when running from source.
  // Avoid importing electron here so this stays usable from unit tests;
  // main/index.ts passes the explicit flag.
  return false;
}
