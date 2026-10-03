// wmux ↔ Antigravity CLI (agy) quota sensor installer.
// Configures agy's statusLine hook to feed the quota sink while preserving any
// pre-existing statusLine configuration via base64url chaining.

import * as fs from 'fs';
import * as path from 'path';
import { copyFileAtomic } from '../../shared/settingsFile';
import { applyConfigEdit, ConfigChangedError, snapshotFile, type FileSnapshot } from '../surfaces/safeWrite';

export type AgyStatusLineKind = 'none' | 'agy-sink' | 'foreign';
export type InstallAgyQuotaSensorAction = 'installed' | 'chained' | 'noop';

export interface InstallAgyQuotaSensorOptions {
  /** Node executable path to write into statusLine.command (defaults to 'node'). */
  nodePath?: string;
  /** Destination script path (defaults to <homeDir>/.wmux/bin/quota-sink.js). */
  sinkScriptPath?: string;
  /** Source script path to copy from (searched automatically if omitted). */
  sourceScriptPath?: string;
  /** Whether to copy the quota-sink.js script to sinkScriptPath (defaults to true). */
  copyScript?: boolean;
  /** Target OS platform (retained for backward compatibility). */
  platform?: NodeJS.Platform;
}

export interface InstallAgyQuotaSensorOutcome {
  ok: boolean;
  action: InstallAgyQuotaSensorAction;
  settingsPath: string;
  backupPath?: string;
  commandWritten?: string;
  error?: string;
}

export const ALLOWED_PATH_CHARS = /^[\p{L}\p{Nd}_.:\\/~-]+$/u;

/**
 * Searches upward candidate paths to find the bundled or repository quota-sink.js script.
 */
export function findQuotaSinkSourceFrom(startDir: string): string | null {
  const candidates = [
    'quota-sink.js',
    path.join('cli-bundle', 'quota-sink.js'),
    path.join('dist', 'cli-bundle', 'quota-sink.js'),
    path.join('integrations', 'agy', 'bin', 'quota-sink.js'),
  ];
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    for (const rel of candidates) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Encodes a command into a base64url string (unpadded, URL-safe alphabet).
 */
export function encodeChainedCommand(cmd: string): string {
  return Buffer.from(cmd, 'utf8').toString('base64url');
}

/**
 * Decodes a base64url-encoded chained command string, returning the original string or null if empty/invalid.
 */
export function decodeChainedCommand(b64: string): string | null {
  try {
    const decoded = Buffer.from(b64, 'base64url').toString('utf8');
    return decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Extracts and decodes the chained command argument (--chain-b64 <val>) from a statusLine command string.
 */
export function extractChainedB64(command: string): string | null {
  const match = command.match(/--chain-b64(?:=|\s+)([A-Za-z0-9_-]+)/);
  if (!match) return null;
  return decodeChainedCommand(match[1]);
}

/**
 * Classifies the current statusLine entry in settings.json:
 * - 'none': missing, null, undefined, empty/whitespace string, or object with missing/non-string/whitespace command.
 * - 'agy-sink': already configured to point to wmux's quota-sink.js.
 * - 'foreign': another command is configured.
 */
/**
 * Whether a statusLine command runs wmux's sink: the path wmux installs to, or a wmux data dir's
 * `bin/quota-sink.js` from an earlier install. A user's own script named quota-sink.js is not ours.
 */
function isOurSink(command: string, sinkScriptPath?: string): boolean {
  if (sinkScriptPath && command.includes(sinkScriptPath)) return true;
  return /[\\/]\.wmux[^\\/\s]*[\\/]bin[\\/]quota-sink\.js/.test(command);
}

export function classifyAgyStatusLine(
  settings: Record<string, unknown>,
  sinkScriptPath?: string,
): AgyStatusLineKind {
  const sl = settings.statusLine;
  if (sl === undefined || sl === null) return 'none';
  if (typeof sl === 'object' && !Array.isArray(sl)) {
    const cmd = (sl as Record<string, unknown>).command;
    if (typeof cmd !== 'string' || cmd.trim().length === 0) return 'none';
    if (isOurSink(cmd, sinkScriptPath)) return 'agy-sink';
    return 'foreign';
  }
  if (typeof sl === 'string') {
    if (sl.trim().length === 0) return 'none';
    if (isOurSink(sl, sinkScriptPath)) return 'agy-sink';
    return 'foreign';
  }
  return 'foreign';
}

/**
 * Extracts the raw command string from an existing statusLine entry.
 */
export function extractExistingCommand(statusLine: unknown): string {
  if (typeof statusLine === 'object' && statusLine !== null && !Array.isArray(statusLine)) {
    const cmd = (statusLine as Record<string, unknown>).command;
    if (typeof cmd === 'string') return cmd;
  }
  if (typeof statusLine === 'string') return statusLine;
  return '';
}

/**
 * Installs the wmux quota sensor into ~/.gemini/antigravity-cli/settings.json.
 *
 * Injected home directory ensures safe execution in tests without touching real user home.
 *
 * Behavior:
 * 1. Checks nodePath and sinkScriptPath against invalid characters (whitespace, quotes, cmd metacharacters).
 *    Returns ok: false immediately without modifying anything if found.
 * 2. Copies quota-sink.js to <homeDir>/.wmux/bin/quota-sink.js (unless copyScript is false).
 *    Returns ok: false if the source script cannot be found.
 * 3. Reads <homeDir>/.gemini/antigravity-cli/settings.json (creates parent dirs / {} if missing).
 * 4. If statusLine already points to quota-sink.js:
 *    - If the command equals the command that would be written now: no-op without backup or rewrite.
 *    - If it differs (moved path, old format), rewrites it with a backup, preserving --chain-b64 if present.
 * 5. If statusLine exists and is foreign:
 *    Refuses (ok: false) when it has `enabled: false`: chaining would run a command the user turned off.
 *    Otherwise backs up settings.json to <settingsPath>.bak-wmux-<timestamp>, then rewrites statusLine to chain
 *    via `--chain-b64 <base64url>`:
 *    `${node} ${sinkScriptPath} agy --chain-b64 <b64>`, keeping the entry's other fields.
 * 6. If no statusLine key exists (or empty placeholder):
 *    Writes `"statusLine": { "type": "command", "command": "${node} ${sinkScriptPath} agy", "enabled": true, "stack_with_default": true }`.
 * 7. Preserves all other keys in settings.json; writes atomically via writeJsonAtomic.
 */
export function installAgyQuotaSensor(
  homeDir: string,
  options?: InstallAgyQuotaSensorOptions,
): InstallAgyQuotaSensorOutcome {
  const settingsPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  const nodePath = options?.nodePath ?? 'node';
  const sinkScriptPath = options?.sinkScriptPath ?? path.join(homeDir, '.wmux', 'bin', 'quota-sink.js');

  // Safety guard: reject node or sink paths containing anything other than allowed characters
  if (!ALLOWED_PATH_CHARS.test(nodePath) || !ALLOWED_PATH_CHARS.test(sinkScriptPath)) {
    return {
      ok: false,
      action: 'noop',
      settingsPath,
      error: 'Install path must not contain spaces or special characters',
    };
  }

  // Copy quota-sink.js into place
  if (options?.copyScript !== false) {
    const source = options?.sourceScriptPath ?? findQuotaSinkSourceFrom(__dirname);
    if (!source || !fs.existsSync(source)) {
      return {
        ok: false,
        action: 'noop',
        settingsPath,
        error: `Source quota-sink.js script not found${source ? ` at ${source}` : ''}`,
      };
    }
    copyFileAtomic(source, sinkScriptPath);
  }

  let settings: Record<string, unknown> = {};
  // One snapshot: the write below refuses if agy changed the file since this read.
  const snap = snapshotFile(settingsPath);
  if (snap.exists) {
    const raw = snap.text ?? '';
    if (raw.trim().length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          settings = parsed as Record<string, unknown>;
        } else {
          return {
            ok: false,
            action: 'noop',
            settingsPath,
            error: 'settings.json does not contain a JSON object',
          };
        }
      } catch {
        return {
          ok: false,
          action: 'noop',
          settingsPath,
          error: 'settings.json is not valid JSON; fix or remove it and try again',
        };
      }
    }
  }

  const classification = classifyAgyStatusLine(settings, sinkScriptPath);

  if (classification === 'agy-sink') {
    const currentCmd = extractExistingCommand(settings.statusLine);
    const chainedOriginal = extractChainedB64(currentCmd);

    let targetCommand: string;
    let targetAction: InstallAgyQuotaSensorAction;
    if (chainedOriginal) {
      const b64 = encodeChainedCommand(chainedOriginal);
      targetCommand = `${nodePath} ${sinkScriptPath} agy --chain-b64 ${b64}`;
      targetAction = 'chained';
    } else {
      targetCommand = `${nodePath} ${sinkScriptPath} agy`;
      targetAction = 'installed';
    }

    if (currentCmd === targetCommand) {
      return {
        ok: true,
        action: 'noop',
        settingsPath,
        commandWritten: currentCmd,
      };
    }

    const current = settings.statusLine;
    const written = writeStatusLine(settingsPath, snap,
      current && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>), type: 'command', command: targetCommand }
        : { type: 'command', command: targetCommand, enabled: true, stack_with_default: true });
    if (!written.ok) return { ok: false, action: 'noop', settingsPath, error: written.error };
    const backupPath = written.backupPath;

    return {
      ok: true,
      action: targetAction,
      settingsPath,
      backupPath,
      commandWritten: targetCommand,
    };
  }

  if (classification === 'foreign') {
    const original = settings.statusLine;
    const originalFields =
      original && typeof original === 'object' && !Array.isArray(original)
        ? (original as Record<string, unknown>)
        : null;
    // Chaining runs the user's command again; one they turned off must stay off.
    if (originalFields?.enabled === false) {
      return {
        ok: false,
        action: 'noop',
        settingsPath,
        error: 'Your agy statusLine is turned off, so wmux did not chain it. Turn it on or remove it, then install again.',
      };
    }

    const existingCmd = extractExistingCommand(original);
    const b64 = encodeChainedCommand(existingCmd);
    const chainedCommand = `${nodePath} ${sinkScriptPath} agy --chain-b64 ${b64}`;

    // Keep every field the user set (padding, stack_with_default, ...); only the command changes.
    const written = writeStatusLine(settingsPath, snap, originalFields
      ? { ...originalFields, type: 'command', command: chainedCommand }
      : { type: 'command', command: chainedCommand, enabled: true, stack_with_default: true });
    if (!written.ok) return { ok: false, action: 'noop', settingsPath, error: written.error };
    const backupPath = written.backupPath;

    return {
      ok: true,
      action: 'chained',
      settingsPath,
      backupPath,
      commandWritten: chainedCommand,
    };
  }

  // classification === 'none': fresh install
  const command = `${nodePath} ${sinkScriptPath} agy`;
  const written = writeStatusLine(settingsPath, snap, {
    type: 'command',
    command,
    enabled: true,
    stack_with_default: true,
  }, false);
  if (!written.ok) return { ok: false, action: 'noop', settingsPath, error: written.error };

  return {
    ok: true,
    action: 'installed',
    settingsPath,
    commandWritten: command,
  };
}

/**
 * Sets only `statusLine`, through the same conflict-checked, backed-up edit the surface writers use:
 * an agy save between our read and this write is refused instead of overwritten.
 */
function writeStatusLine(
  settingsPath: string,
  snap: FileSnapshot,
  statusLine: Record<string, unknown>,
  backup = true,
): { ok: true; backupPath?: string } | { ok: false; error: string } {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const res = applyConfigEdit({
      path: settingsPath,
      kind: 'json',
      edits: [{ op: 'set', path: ['statusLine'], value: statusLine }],
      backup: backup && snap.exists,
      snapshot: snap,
    });
    return { ok: true, backupPath: res.backupPath };
  } catch (err) {
    if (err instanceof ConfigChangedError) {
      return { ok: false, error: 'agy changed settings.json while installing; try again.' };
    }
    return { ok: false, error: `Could not write settings.json: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Bring an installed quota-sink.js up to the bundled version. The sensor copy
 * in <homeDir>/.wmux/bin is only written by an explicit install, so without
 * this an upgrade would keep running the old sink (no per-account snapshots).
 * Never installs: when the sensor is not there, nothing is written.
 */
export function refreshInstalledAgyQuotaSink(
  homeDir: string,
  sourceScriptPath: string | null = findQuotaSinkSourceFrom(__dirname),
): 'updated' | 'current' | 'absent' {
  const dest = path.join(homeDir, '.wmux', 'bin', 'quota-sink.js');
  if (!sourceScriptPath || !fs.existsSync(dest) || !fs.existsSync(sourceScriptPath)) return 'absent';
  try {
    if (fs.readFileSync(dest).equals(fs.readFileSync(sourceScriptPath))) return 'current';
    copyFileAtomic(sourceScriptPath, dest);
    return 'updated';
  } catch {
    return 'absent';
  }
}
