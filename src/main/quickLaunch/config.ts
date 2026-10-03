// Quick launch settings: `{ enabled, accelerator }` in ~/.wmux/quick-launch.json.
//
// Main-owned, like computer-use.json: main has to register the shortcut at
// `ready`, before any renderer has loaded its session, and the composer window
// has no store of its own to read it from.
//
// A missing file means the defaults (on, CommandOrControl+Shift+Space). A
// malformed accelerator falls back to the default rather than turning the
// feature off, so a bad hand edit cannot silently lose the shortcut.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dataSuffix } from '../../shared/constants';
import { QUICK_LAUNCH_DEFAULT_ACCELERATOR, isGlobalAccelerator } from '../../shared/quickLaunch';

export interface QuickLaunchConfig {
  enabled: boolean;
  accelerator: string;
}

export function quickLaunchConfigPath(): string {
  return path.join(os.homedir(), `.wmux${dataSuffix()}`, 'quick-launch.json');
}

export function readQuickLaunchConfig(configPath: string = quickLaunchConfigPath()): QuickLaunchConfig {
  const fallback = { enabled: true, accelerator: QUICK_LAUNCH_DEFAULT_ACCELERATOR };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'), (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const r = parsed as Record<string, unknown>;
  return {
    enabled: r.enabled !== false,
    accelerator: isGlobalAccelerator(r.accelerator) ? r.accelerator : QUICK_LAUNCH_DEFAULT_ACCELERATOR,
  };
}

/** Atomic (temp file + rename), so a reader never sees half a file. */
export function writeQuickLaunchConfig(config: QuickLaunchConfig, configPath: string = quickLaunchConfigPath()): void {
  const tmpPath = `${configPath}.tmp`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}
