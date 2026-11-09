import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { agentRow, agentSlugToDisplay } from '../../shared/agentIdentity';
import { dataSuffix } from '../../shared/constants';
import { getMcpServerEntry, getMcpServerScript, isWmuxOwnedEntry, parseConfig } from '../../shared/configIO';
import { MCP_TARGETS, WMUX_SERVER_KEY, externalRegistrationSkipReason, getMcpTarget, type McpTarget } from '../../shared/mcpTargets';
import {
  readCodexHooksStatus,
  readCodexNotifyStatus,
  unregisterCodexHooks,
  unregisterCodexNotify,
  unregisterTarget,
} from '../../shared/mcpRegistration';
import { COMPAT_HOOK_FLAVOUR_IDS, COMPAT_HOOK_FLAVOURS } from '../../shared/hooks/hookFlavours';
import { isPackagedBridge } from '../../shared/hooks/claudeNativeHook';
import { compatHookConfigPath, removeCompatHooks, resolveCompatHookPaths } from '../../shared/hooks/compatHookInstall';
import { resolveLifecycleIntegrationPaths } from '../../shared/lifecycleIntegrations';
import { shouldUsePortableData } from '../../main/dataIsolation';
import {
  classifyAgyStatusLine,
  extractChainedB64,
  extractExistingCommand,
} from '../../main/quota/installAgyQuotaSensor';
import { applyConfigEdit, snapshotFile } from '../../main/surfaces/safeWrite';
import { stripBom } from '../../shared/stripBom';
import { hookTargets, removeFanoutWorkerTools, removeHooks, type HookTarget } from './setupHooks';
import { removeStatusline, type TargetOutcome } from './setupStatusline';

/**
 * `wmux uninstall-integrations`, and the `--squirrel-uninstall` hook: take wmux
 * out of the other agents' configs. Deleting wmux's files alone leaves them on a
 * dead MCP server and on hooks that fail on every turn, with nothing left that
 * knows why.
 *
 * Everything goes through the removal each writer already has, so its ownership
 * check, safe write and config lock apply. A removal with no such function lives
 * here, on the same read-check-write primitives.
 *
 * Left out on purpose:
 *   - agy `trustedWorkspaces`: folder paths, the same entry the operator's own
 *     keypress writes, so wmux's cannot be told apart. Harmless without wmux.
 *   - `setup-hooks --wsl`: needs wsl.exe per distro (a 60 s timeout each), which
 *     does not fit an uninstall hook. `--uninstall` on that command removes it.
 *   - The Claude Code marketplace plugin: installed and owned by Claude's `/plugin`.
 *   - kiro, gemini, qwen hook flavours: no wired installer, so wmux wrote nothing.
 *   - Scripts under `~/.wmux/hooks`: wmux's own folder, not an agent's config.
 */

/** Squirrel cancels the uninstall hook at about 16 s, and the steps after this
 *  one must still run. The longest wait inside is the 3 s Claude config lock. */
export const SQUIRREL_INTEGRATIONS_BUDGET_MS = 4_000;

export type IntegrationOutcome =
  /** wmux's entry was there and is gone (or the entry it replaced is back). */
  | 'removed'
  | 'not-present'
  /** An entry is there and stays: not wmux's, or another wmux copy's. */
  | 'kept'
  | 'failed';

export interface IntegrationItem {
  agent: string;
  item: string;
  path: string;
  outcome: IntegrationOutcome;
  detail?: string;
}

export interface IntegrationRemovalReport {
  /** Nothing failed and the run was not refused. */
  ok: boolean;
  /** Why nothing was touched (an isolated instance), or null. */
  skipped: string | null;
  items: IntegrationItem[];
}

/** Which copy of wmux is asking. */
export interface WmuxCopy {
  /** The installed app, which owns the shared `~/.wmux` slot every entry but an
   *  MCP one names. A portable copy or a checkout does not. */
  installed: boolean;
  /** Folders that are this copy: an entry under them is its own. */
  roots: string[];
}

export interface RemoveAgentIntegrationsOptions {
  home: string;
  /** Where this code runs from; only used to resolve packaged asset layouts. */
  startDir: string;
  copy: WmuxCopy;
  /** Skip the second-copy check. The ownership shape checks still apply. */
  force?: boolean;
  /** Stop starting new items after this long; the rest report `failed`. */
  deadlineMs?: number;
  now?: () => number;
  env?: Readonly<Record<string, string | undefined>>;
}

function realOr(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

export interface DescribeCopyDeps {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (target: string) => boolean;
}

/**
 * Work out which copy `startDir` belongs to, from the layout on disk.
 *
 * A packaged CLI runs from `<resources>/cli-bundle`. On Windows a Squirrel
 * install has Update.exe above its `app-*` folder, and every `app-*` is the same
 * install. On macOS "installed" means what the app's own data isolation means
 * (the CLI does not get the suffix the app forces on itself). Linux packages are
 * treated as installed: an AppImage mounts at a new path each run, so its path
 * says nothing. Anything else is a checkout, which owns only its own folder.
 */
export function describeThisCopy(startDir: string, deps: DescribeCopyDeps = {}): WmuxCopy {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? fs.existsSync;
  const dir = realOr(startDir);
  if (!isPackagedBridge(path.join(dir, 'index.js'))) {
    let root = dir;
    for (let at = dir; ; at = path.dirname(at)) {
      if (exists(path.join(at, 'package.json'))) { root = at; break; }
      if (path.dirname(at) === at) break;
    }
    return { installed: false, roots: [root] };
  }
  const appDir = path.dirname(path.dirname(dir));
  if (platform === 'win32') {
    const root = path.dirname(appDir);
    const installed = exists(path.join(root, 'Update.exe'));
    return { installed, roots: [installed ? root : appDir] };
  }
  if (platform === 'darwin') {
    const bundle = path.dirname(appDir);
    const env = { ...(deps.env ?? process.env), WMUX_DATA_SUFFIX: undefined };
    const execPath = path.join(bundle, 'Contents', 'MacOS', 'wmux');
    return { installed: !shouldUsePortableData(execPath, deps.home ?? os.homedir(), env), roots: [bundle] };
  }
  return { installed: true, roots: [appDir] };
}

/** Whether `child` is `parent` or inside it. Case-insensitive where the default
 *  filesystem is, as normalizedTargetKey is. */
function isInside(parent: string, child: string): boolean {
  const fold = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  const rel = path.relative(fold(realOr(parent)), fold(realOr(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

type Result = Pick<IntegrationItem, 'outcome' | 'detail'>;
const REMOVED: Result = { outcome: 'removed' };
const NOT_PRESENT: Result = { outcome: 'not-present' };
const CORRUPT: Result = { outcome: 'failed', detail: 'not valid, so it was left untouched' };
const NOT_WMUX: Result = { outcome: 'kept', detail: 'not wmux\'s entry' };

interface Step {
  agent: string;
  item: string;
  path: string;
  /** Names the shared `~/.wmux` slot, so only the installed copy removes it. */
  sharedSlot?: boolean;
  run: () => Result;
}

/**
 * Who an MCP entry belongs to, by the path it names. Unlike the other entries,
 * which all name the shared `~/.wmux` slot, an MCP entry can name one install's
 * own bundle (`wmux mcp register` writes the CLI's layout), so this can tell.
 */
function mcpEntryBelongsToOtherCopy(named: string, opts: RemoveAgentIntegrationsOptions): string | null {
  if (opts.force) return null;
  const another = `another wmux copy runs it (${named}); remove it from there, or pass --force`;
  // wmux always writes an absolute path.
  if (!path.isAbsolute(named)) return another;
  if (opts.copy.roots.some((root) => isInside(root, named))) return null;
  // Nothing can run it any more, whichever copy wrote it.
  if (!fs.existsSync(named)) return null;
  if (isInside(path.join(opts.home, '.wmux'), named)) return opts.copy.installed ? null : another;
  return another;
}

function removeMcpEntry(target: McpTarget, opts: RemoveAgentIntegrationsOptions): Result {
  const configPath = target.configPath(opts.home);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseConfig(fs.readFileSync(configPath, 'utf8'), target.format);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? NOT_PRESENT : CORRUPT;
  }
  const entry = getMcpServerEntry(parsed, target.format, WMUX_SERVER_KEY);
  if (!entry) return NOT_PRESENT;
  if (!isWmuxOwnedEntry(entry)) return NOT_WMUX;
  const elsewhere = mcpEntryBelongsToOtherCopy(getMcpServerScript(parsed, target.format, WMUX_SERVER_KEY) ?? '', opts);
  if (elsewhere) return { outcome: 'kept', detail: elsewhere };
  return unregisterTarget(target, opts.home).removed.length > 0
    ? REMOVED
    : { outcome: 'failed', detail: 'its form could not be edited safely, so it was left untouched' };
}

function removeClaudeHooks(target: HookTarget): Result {
  const outcome = removeHooks(target.paths);
  if (!outcome.ok) return { outcome: 'failed', detail: outcome.error ?? undefined };
  return outcome.removed > 0 ? REMOVED : NOT_PRESENT;
}

function statuslineResult(outcome: TargetOutcome, error?: string): Result {
  switch (outcome) {
    case 'removed': return REMOVED;
    case 'restored': return { outcome: 'removed', detail: 'the statusLine it replaced is back' };
    case 'skipped-corrupt': return CORRUPT;
    case 'skipped-no-backup': return { outcome: 'failed', detail: 'the statusLine it replaced could not be read back, so it was left' };
    case 'failed': return { outcome: 'failed', detail: error };
    default: return NOT_PRESENT;
  }
}

function removeClaudeStatusline(target: HookTarget, home: string): Result {
  const { targets: [report] } = removeStatusline({
    targets: [{ label: target.label, settingsPath: target.settingsPath }],
    // The backups of a replaced statusLine sit beside the installed script.
    scriptDest: path.join(home, '.wmux', 'hooks', 'wmux-statusline.mjs'),
    scriptSource: null,
  });
  return statuslineResult(report.outcome, report.error);
}

function removeClaudeWorkerGrants(target: HookTarget): Result {
  const outcome = removeFanoutWorkerTools(target.paths);
  if (!outcome.ok) return { outcome: 'failed', detail: outcome.error ?? undefined };
  return outcome.removed.length > 0 ? REMOVED : NOT_PRESENT;
}

function removeCodexNotify(home: string): Result {
  const { state } = readCodexNotifyStatus(home);
  if (state === 'none') return NOT_PRESENT;
  if (state === 'foreign') return NOT_WMUX;
  if (state === 'malformed') return CORRUPT;
  return unregisterCodexNotify(home).removed ? REMOVED : { outcome: 'failed', detail: 'it could not be removed' };
}

function removeCodexHooksBlock(home: string): Result {
  const { state } = readCodexHooksStatus(home, '');
  if (state === 'none') return NOT_PRESENT;
  if (state === 'foreign') return NOT_WMUX;
  if (state === 'malformed') return CORRUPT;
  return unregisterCodexHooks(home).removed ? REMOVED : { outcome: 'failed', detail: 'its markers are not a complete block, so it was left' };
}

function removeOwnedHookFile(flavour: (typeof COMPAT_HOOK_FLAVOUR_IDS)[number], opts: RemoveAgentIntegrationsOptions): Result {
  const outcome = removeCompatHooks(flavour, resolveCompatHookPaths(opts.home, opts.startDir, opts.env ?? process.env));
  if (outcome.removed) return REMOVED;
  if (outcome.before === 'foreign') return NOT_WMUX;
  if (outcome.before === 'malformed') return CORRUPT;
  return outcome.error ? { outcome: 'failed', detail: outcome.error } : NOT_PRESENT;
}

/** agy's statusLine: put back the command the sink chained, or drop the entry. */
function removeAgyQuotaSensor(home: string, settingsPath: string): Result {
  const snapshot = snapshotFile(settingsPath);
  if (!snapshot.exists) return NOT_PRESENT;
  let settings: Record<string, unknown> = {};
  try {
    const bare = stripBom(snapshot.text ?? '');
    if (bare.trim()) settings = JSON.parse(bare) as Record<string, unknown>;
  } catch {
    return CORRUPT;
  }
  const kind = classifyAgyStatusLine(settings, path.join(home, '.wmux', 'bin', 'quota-sink.js'));
  if (kind === 'none') return NOT_PRESENT;
  if (kind === 'foreign') return NOT_WMUX;
  const chained = extractChainedB64(extractExistingCommand(settings.statusLine));
  const fields = settings.statusLine && typeof settings.statusLine === 'object' ? settings.statusLine : {};
  applyConfigEdit({
    path: settingsPath,
    kind: 'json',
    edits: chained
      ? [{ op: 'set', path: ['statusLine'], value: { ...fields, command: chained } }]
      : [{ op: 'delete', path: ['statusLine'] }],
    backup: false,
    snapshot,
  });
  return chained ? { outcome: 'removed', detail: 'the statusLine it chained is back' } : REMOVED;
}

/** A file wmux put in the agent's folder: deleted only if it carries wmux's marker. */
function removeMarkedFile(file: string, markers: readonly string[]): Result {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return NOT_PRESENT;
    throw err;
  }
  if (!markers.some((marker) => text.includes(marker))) return NOT_WMUX;
  fs.unlinkSync(file);
  return REMOVED;
}

/** wmux's entry in OpenCode's `tui.json` plugin list. The writer refuses JSONC
 *  and any file it cannot parse, so wmux has written nothing into one of those. */
function removeTuiPluginEntry(configRoot: string, chatFile: string): Result {
  const configPath = path.join(configRoot, 'tui.json');
  const snapshot = snapshotFile(configPath);
  if (!snapshot.exists) return NOT_PRESENT;
  let config: { plugin?: unknown };
  try {
    config = JSON.parse(stripBom(snapshot.text ?? '')) as { plugin?: unknown };
  } catch {
    return NOT_PRESENT;
  }
  if (!config || !Array.isArray(config.plugin)) return NOT_PRESENT;
  const pluginUrl = pathToFileURL(chatFile).href;
  const kept = config.plugin.filter((p: unknown) => p !== pluginUrl && !(Array.isArray(p) && p[0] === pluginUrl));
  if (kept.length === config.plugin.length) return NOT_PRESENT;
  applyConfigEdit({
    path: configPath,
    kind: 'json',
    edits: kept.length > 0
      ? [{ op: 'set', path: ['plugin'], value: kept }]
      : [{ op: 'delete', path: ['plugin'] }],
    backup: false,
    snapshot,
  });
  return REMOVED;
}

function planSteps(opts: RemoveAgentIntegrationsOptions): Step[] {
  const { home } = opts;
  const env = opts.env ?? process.env;
  const steps: Step[] = [];

  const codex = { agent: agentSlugToDisplay('codex'), path: getMcpTarget('codex')?.configPath(home) ?? '', sharedSlot: true };
  steps.push({ ...codex, item: 'hooks block', run: () => removeCodexHooksBlock(home) });
  steps.push({ ...codex, item: 'notify', run: () => removeCodexNotify(home) });

  for (const target of MCP_TARGETS) {
    steps.push({ agent: target.displayName, item: 'MCP server', path: target.configPath(home), run: () => removeMcpEntry(target, opts) });
  }

  // Every Claude folder a `claude` can run with: the env's or ~/.claude, then each account.
  const claude = agentSlugToDisplay('claude');
  const { targets } = hookTargets({
    action: 'remove',
    env: env.CLAUDE_CONFIG_DIR,
    wmuxDir: path.join(home, `.wmux${dataSuffix()}`),
    base: {
      settingsPath: path.join(home, '.claude', 'settings.json'),
      bridgeDest: path.join(home, '.wmux', 'hooks', 'wmux-bridge.mjs'),
      bridgeSource: null,
    },
  });
  for (const target of targets) {
    const at = { agent: claude, path: target.settingsPath, sharedSlot: true };
    steps.push({ ...at, item: 'hooks', run: () => removeClaudeHooks(target) });
    steps.push({ ...at, item: 'statusLine', run: () => removeClaudeStatusline(target, home) });
    steps.push({ ...at, item: 'fan-out worker tool grants', run: () => removeClaudeWorkerGrants(target) });
  }

  const agySettings = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  steps.push({ agent: agentSlugToDisplay('agy'), item: 'quota statusLine', path: agySettings, sharedSlot: true, run: () => removeAgyQuotaSensor(home, agySettings) });

  const compatPaths = resolveCompatHookPaths(home, opts.startDir, env);
  for (const id of COMPAT_HOOK_FLAVOUR_IDS) {
    if (COMPAT_HOOK_FLAVOURS[id].install?.strategy !== 'owned-file') continue;
    const file = compatHookConfigPath(id, compatPaths) ?? '';
    steps.push({ agent: agentRow(id)?.display ?? id, item: 'hook file', path: file, sharedSlot: true, run: () => removeOwnedHookFile(id, opts) });
  }

  // The list entry first: OpenCode fails to load a listed plugin that is gone.
  const opencode = resolveLifecycleIntegrationPaths(home, opts.startDir).opencode;
  const configRoot = path.dirname(path.dirname(opencode.destinationPath));
  const chatFile = path.join(configRoot, 'wmux-chat-tui.mjs');
  const openCodeAgent = agentSlugToDisplay('opencode');
  steps.push({ agent: openCodeAgent, item: 'terminal chat entry', path: path.join(configRoot, 'tui.json'), sharedSlot: true, run: () => removeTuiPluginEntry(configRoot, chatFile) });
  steps.push({ agent: openCodeAgent, item: 'terminal chat plugin', path: chatFile, sharedSlot: true, run: () => removeMarkedFile(chatFile, ['wmux-managed: opencode-terminal-chat']) });
  steps.push({ agent: openCodeAgent, item: 'lifecycle plugin', path: opencode.destinationPath, sharedSlot: true, run: () => removeMarkedFile(opencode.destinationPath, opencode.ownershipMarkers) });

  return steps;
}

/**
 * Remove what wmux wrote into every agent's config and say what happened to
 * each item. Never throws: one failure does not stop the rest.
 *
 * An isolated instance (WMUX_DATA_SUFFIX) touches nothing: these paths are
 * suffix-blind, so they are production's. Same rule, and same override, as the
 * external MCP registration (`externalRegistrationSkipReason`).
 *
 * A second copy does not strip the installed app's entries:
 *   - The installed copy removes everything wmux-owned, except an MCP entry that
 *     names another copy's existing file.
 *   - A portable copy or a checkout removes only an MCP entry naming its own
 *     folder or a file that is gone. The rest is reported `kept`.
 *   - `force` drops this check. The ownership shape checks still apply.
 */
export function removeAgentIntegrations(opts: RemoveAgentIntegrationsOptions): IntegrationRemovalReport {
  const skipped = externalRegistrationSkipReason();
  if (skipped) return { ok: false, skipped, items: [] };

  const now = opts.now ?? Date.now;
  const started = now();
  const items: IntegrationItem[] = [];
  let steps: Step[];
  try {
    steps = planSteps(opts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, skipped: null, items: [{ agent: 'wmux', item: 'agent configs', path: opts.home, outcome: 'failed', detail }] };
  }
  for (const step of steps) {
    const { agent, item, path: at } = step;
    let result: Result;
    if (opts.deadlineMs !== undefined && now() - started > opts.deadlineMs) {
      result = { outcome: 'failed', detail: `not attempted: the ${opts.deadlineMs} ms budget ran out` };
    } else if (step.sharedSlot && !opts.copy.installed && !opts.force) {
      result = { outcome: 'kept', detail: 'not checked: this copy is not the installed wmux; run this from the installed one, or pass --force' };
    } else {
      try {
        result = step.run();
      } catch (err) {
        result = { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    }
    items.push({ agent, item, path: at, ...result });
  }
  return { ok: items.every((i) => i.outcome !== 'failed'), skipped: null, items };
}

/** One line per item, for the CLI and the Squirrel log. */
export function formatIntegrationItem(i: IntegrationItem): string {
  return `${i.agent} ${i.item}: ${i.outcome} (${i.path})${i.detail ? `: ${i.detail}` : ''}`;
}

export async function handleUninstallIntegrations(args: string[], jsonMode: boolean): Promise<void> {
  const unknown = args.filter((a) => a !== '--force');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(', ')}. Run 'wmux --help' for usage.`);
    process.exit(1);
    return;
  }
  const report = removeAgentIntegrations({
    home: os.homedir(),
    startDir: __dirname,
    copy: describeThisCopy(__dirname),
    force: args.includes('--force'),
  });
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.skipped) {
    console.error(report.skipped);
  } else {
    for (const item of report.items) console.log(formatIntegrationItem(item));
    console.log('Restart running agent sessions so they stop using these entries. A WSL distro set up with `wmux setup-hooks --wsl` is removed with `--wsl <distro> --uninstall`.');
  }
  if (!report.ok) process.exit(1);
}
