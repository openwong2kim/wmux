import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNotLiveWmuxDataDir, dataSuffix } from './constants';
import { writeJsonAtomic } from './settingsFile';
import { stripBom } from './stripBom';

// Settings → Labs switches the terminal host reads. Its own file, like
// terminal-core.json: the daemon rewrites config.json, so the app does not
// edit that one. `config.session.ringCompression` keeps working as well.

export interface LabsSettings {
  ringCompression: boolean;
}

export interface LabsStatus {
  saved: LabsSettings;
  /** What the running terminal host started with (labs.json or config.json's
   *  flag); null when it did not answer. */
  running: LabsSettings | null;
  /** config.json's session.ringCompression is on, so compression is on whatever labs.json says. */
  ringCompressionInConfig: boolean;
  /** Whether ring compression applies to the running host's engine; null when
   *  it did not report its engine. Every engine compresses now; an older app
   *  build still reports false for Rust (labs.handler.ts). */
  ringCompressionApplies: boolean | null;
  restartRequired: boolean;
  stopCommand: string;
}

function dataDir(): string {
  assertNotLiveWmuxDataDir(os.homedir());
  return path.join(os.homedir(), `.wmux${dataSuffix()}`);
}

export function labsSettingsPath(): string {
  return path.join(dataDir(), 'labs.json');
}

export function ringCompressionInConfig(file?: string): boolean {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file ?? path.join(dataDir(), 'config.json'), 'utf8')))?.session?.ringCompression === true;
  } catch {
    return false;
  }
}

/** Ring compression is on unless labs.json turns it off. */
export function readLabsSettings(file?: string): LabsSettings {
  try {
    const saved = JSON.parse(fs.readFileSync(file ?? labsSettingsPath(), 'utf8'));
    return { ringCompression: saved?.ringCompression !== false };
  } catch {
    return { ringCompression: true };
  }
}

export function writeLabsSettings(settings: LabsSettings, file = labsSettingsPath()): void {
  if (typeof settings?.ringCompression !== 'boolean') throw new Error('Invalid labs settings');
  writeJsonAtomic(file, { ringCompression: settings.ringCompression });
}

let startup: LabsSettings | undefined;
/** The terminal host's switches, read once when it starts: a change applies after a restart. */
export function labsSettingsAtStartup(): LabsSettings {
  startup ??= readLabsSettings();
  return startup;
}
