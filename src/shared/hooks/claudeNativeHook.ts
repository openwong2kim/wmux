// The Claude hook entries' native form: a copy of the shipped wmux-native at
// ~/.wmux/hooks/wmux-claude-hook, beside the bridge it hands runs over to. A
// settings entry names it only once its `--self-test` answered this build's
// protocol and the pin of this build's bridge (see probedNative).
//
// Its own name, not the compat bridge's wmux-native: a wmux from before this
// copy existed refreshes ~/.wmux/hooks/wmux-native on its own schedule, which
// would put an older binary under these entries. No such build writes this
// name.
//
// Unix only: claude-hook does not exist in the Windows build, whose Claude
// hooks stay on node.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../mcpRegistration';
import {
  prepareProbedNative,
  recordedVerdictOf,
  recordedVerdictsOf,
  runProbe,
  sha256Of,
} from '../probedNative';
import { NATIVE_HOOKS_MARKER } from './hookFlavours';
import { packagedNativeHooksSource } from './compatHookInstall';

export const CLAUDE_HOOK_BASENAME = 'wmux-claude-hook';
/** `node` or `native`: what `wmux setup-hooks` writes (`--runtime`). Beside
 *  native-disabled, which turns native runs off at once; this turns the
 *  entries themselves to node on the next install. */
export const CLAUDE_RUNTIME_FILE = 'claude-runtime';
/** The binary's own kill switch (claude_hook.rs): a file beside it. */
export const CLAUDE_KILL_SWITCH_FILE = 'native-disabled';
const SELF_TEST_TIMEOUT_MS = 5000;

export type ClaudeHookRuntime = 'node' | 'native';

/** The copy's path: beside the bridge, which is where it looks for it. */
export function claudeHookCopyPath(bridgeDest: string): string {
  return path.join(path.dirname(bridgeDest), CLAUDE_HOOK_BASENAME);
}

/** True when the bridge comes from an installed app
 *  (`<resources>/cli-bundle/wmux-bridge.mjs`), not a checkout. */
export function isPackagedBridge(bridgeSource: string | null): boolean {
  if (!bridgeSource) return false;
  const bundle = path.dirname(bridgeSource);
  return path.basename(bundle) === 'cli-bundle' && path.basename(path.dirname(bundle)).toLowerCase() === 'resources';
}

/**
 * The shipped binary beside a packaged bridge: `<resources>/native-hooks/`.
 * Packaged resources only; a checkout's build is used only when named
 * (`wmux setup-hooks --native-from`). Null on Windows.
 */
export function packagedClaudeNativeSource(bridgeSource: string | null, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32' || !bridgeSource) return null;
  return packagedNativeHooksSource(path.dirname(bridgeSource), platform);
}

/** The bridge's pin as the binary computes it: SHA-256 with every CRLF read
 *  as LF (a lone CR is kept). */
export function bridgePin(bytes: Buffer): string {
  return sha256Of(Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
}

/** What `--self-test` prints for a copy made from the bridge at `bridge`, or
 *  null when that bridge cannot be read. */
export function claudeSelfTestLine(bridge: string | null): string | null {
  if (!bridge) return null;
  try {
    return `wmux-claude-hook protocol 1 pin ${bridgePin(fs.readFileSync(bridge))}`;
  } catch {
    return null;
  }
}

export function readClaudeRuntime(hooksDir: string): ClaudeHookRuntime {
  try {
    return fs.readFileSync(path.join(hooksDir, CLAUDE_RUNTIME_FILE), 'utf8').trim() === 'node' ? 'node' : 'native';
  } catch {
    return 'native';
  }
}

export function writeClaudeRuntime(hooksDir: string, runtime: ClaudeHookRuntime): void {
  fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(path.join(hooksDir, CLAUDE_RUNTIME_FILE), `${runtime}\n`);
}

/** Which form the entries take, and why not native when they do not. */
export interface ClaudeNativePlan {
  /** The copy the entries run, or null for `node <bridge>`. */
  binary: string | null;
  reason: string | null;
}

export interface PrepareClaudeNativeOptions {
  /** The shipped binary (packaged resources), or one named by --native-from. */
  nativeSource: string | null;
  /** The bridge this build ships: the copy must pin it. */
  bridgeSource: string | null;
  /** Where the bridge is installed; the copy goes beside it. */
  bridgeDest: string;
  /** An isolated instance writes the node form only. */
  suffixed: boolean;
  reprobe?: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Install or refresh the copy, before settings.json is read: the probe takes
 * time, and the settings read-modify-write must not wait inside. Returns the
 * copy to name, or why the entries stay on node.
 */
export async function prepareClaudeNative(opts: PrepareClaudeNativeOptions): Promise<ClaudeNativePlan> {
  const platform = opts.platform ?? process.platform;
  // Before anything is copied.
  if (platform === 'win32') return { binary: null, reason: 'Windows runs the Claude hooks on node' };
  if (opts.suffixed) return { binary: null, reason: 'an isolated instance writes the node form' };
  const hooksDir = path.dirname(opts.bridgeDest);
  if (readClaudeRuntime(hooksDir) === 'node') return { binary: null, reason: 'runtime set to node (`wmux setup-hooks --runtime native` turns it back)' };
  // Nothing to install: a copy already in place still counts when it passed
  // for this build's bridge, as status counts it.
  if (!opts.nativeSource) {
    return claudeNativeAvailable(opts.bridgeDest, opts.bridgeSource, platform)
      ? { binary: claudeHookCopyPath(opts.bridgeDest), reason: null }
      : { binary: null, reason: 'not shipped with this build' };
  }
  const line = claudeSelfTestLine(opts.bridgeSource);
  if (!line) return { binary: null, reason: 'the bridge this build ships could not be read' };
  const result = await prepareProbedNative({
    sourcePath: opts.nativeSource,
    destinationPath: claudeHookCopyPath(opts.bridgeDest),
    recordDir: hooksDir,
    line,
    probe: (binary) => runProbe(binary, ['--self-test'], { line }, SELF_TEST_TIMEOUT_MS),
    ownershipMarkers: [NATIVE_HOOKS_MARKER],
    reprobe: opts.reprobe,
    platform,
  });
  return { binary: result.binary, reason: result.reason ?? null };
}

/**
 * The copy beside `bridgeDest`, judged for the bridge at `bridge` (this
 * build's, or the one installed beside the copy): missing, its recorded
 * `--self-test` verdict, or undefined when none is recorded for that pin.
 * Runs nothing.
 */
export function claudeCopyVerdict(bridgeDest: string, bridge: string | null): 'missing' | 'pass' | 'fail' | undefined {
  const copy = claudeHookCopyPath(bridgeDest);
  if (!fs.existsSync(copy)) return 'missing';
  const line = claudeSelfTestLine(bridge);
  return line ? recordedVerdictOf(copy, path.dirname(bridgeDest), line) : undefined;
}

const SELF_TEST_PREFIX = 'wmux-claude-hook protocol 1 pin ';

/**
 * How a copy the entries name runs, from its recorded self-tests and the
 * bridge beside it (which is the one it hands over to). Runs nothing.
 *   missing       no copy: every hook fails
 *   pass          passed for the bridge beside it
 *   pin-mismatch  passed for another bridge: each run hands over to node
 *   no-bridge     passed, and no bridge is beside it: the runs stay native
 *   fail          never passed: it does not run here
 *   unchecked     nothing recorded for these bytes
 */
export type ClaudeCopyJudgement = 'missing' | 'pass' | 'pin-mismatch' | 'no-bridge' | 'fail' | 'unchecked';

export function judgeClaudeCopy(copy: string): ClaudeCopyJudgement {
  if (!fs.existsSync(copy)) return 'missing';
  const dir = path.dirname(copy);
  const verdicts = [...recordedVerdictsOf(copy, dir)].filter(([line]) => line.startsWith(SELF_TEST_PREFIX));
  const line = claudeSelfTestLine(path.join(dir, 'wmux-bridge.mjs'));
  if (line && verdicts.some(([l, v]) => l === line && v === 'pass')) return 'pass';
  if (verdicts.some(([, v]) => v === 'pass')) return line ? 'pin-mismatch' : 'no-bridge';
  return verdicts.length > 0 ? 'fail' : 'unchecked';
}

/** True when the entries can run the copy: not Windows, and its recorded
 *  `--self-test` passed for this build's bridge. */
export function claudeNativeAvailable(bridgeDest: string, bridgeSource: string | null, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && claudeCopyVerdict(bridgeDest, bridgeSource) === 'pass';
}

/** What a copy's `--self-test` answered, for `wmux doctor`. */
export type ClaudeSelfTestResult =
  | { outcome: 'pass' }
  | { outcome: 'fail'; printed: string }
  | { outcome: 'unstartable'; error: string }
  | { outcome: 'timeout' };

/**
 * Run the copy's `--self-test` once, as `wmux doctor` does: the only place a
 * recorded pass is checked again (a home turned noexec, a policy that now
 * blocks it). It prints one line, reads no stdin and writes no log. A copy
 * that does not answer within `timeoutMs` proves nothing (a slow antivirus
 * scan). Never throws.
 */
export function selfTestClaudeCopy(copy: string, line: string, timeoutMs = SELF_TEST_TIMEOUT_MS): Promise<ClaudeSelfTestResult> {
  return new Promise((resolve) => {
    try {
      execFile(copy, ['--self-test'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (error && (error as { killed?: boolean }).killed) return resolve({ outcome: 'timeout' });
        const code = (error as { code?: unknown } | null)?.code;
        // A string code is a spawn error (EACCES, ENOENT); a number, the exit status.
        if (typeof code === 'string') return resolve({ outcome: 'unstartable', error: `${code}: ${(error as Error).message}` });
        const printed = String(stdout).trim();
        if (!error && printed === line) return resolve({ outcome: 'pass' });
        resolve({ outcome: 'fail', printed: printed ? printed.slice(0, 200) : `nothing (exit ${typeof code === 'number' ? code : 0})` });
      });
    } catch (error) {
      resolve({ outcome: 'unstartable', error: String(error) });
    }
  });
}
