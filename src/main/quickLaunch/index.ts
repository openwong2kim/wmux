// Global quick launch: a shortcut floats a small composer over whatever app is
// in front, and its prompt starts an agent in a background wmux workspace
// without bringing the main window forward.
//
// The launch flow (validate in main, dispatch to the window that owns the
// workspaces, hide the composer, keep the main window where it is) is adapted
// from MonoCode (hardbeat920/monocode@6bd432ca, src-tauri/src/quick_composer.rs,
// quick_composer_submit), MIT License, Copyright (c) 2026 Nick.
//
// Both checkouts reuse the fan-out machinery rather than a new spawn path:
//   - new worktree   → FanOutService.start through startGuiFanOut (the same
//                      audit record and worker policy as the fan-out dialog);
//   - current checkout → the renderer's `fanout.spawnWorkspace`, which applies
//                      the role binding and never steals focus. The new
//                      workspace nests under the picked one in the sidebar
//                      without being stamped as a fan-out task.

import { globalShortcut, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IPC, dataSuffix } from '../../shared/constants';
import { firstRunEnvForAgent } from '../../shared/agentFirstRun';
import { reservedAccelerators, resolveForPlatform } from '../../shared/keymap';
import {
  formatAccelerator,
  isGlobalAccelerator,
  normalizeQuickLaunchRequest,
  quickLaunchAgentFields,
  quickLaunchAgentOptions,
  quickLaunchTitle,
  type QuickLaunchContext,
  type QuickLaunchRequest,
  type QuickLaunchResult,
  type QuickLaunchSettingsPayload,
} from '../../shared/quickLaunch';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { startGuiFanOut } from '../ipc/handlers/fanout.handler';
import { workerLaunchCommand, type FanOutService } from '../worktask/FanOutService';
import { readQuickLaunchConfig, writeQuickLaunchConfig } from './config';
import { QuickLaunchHotkey } from './hotkey';
import { destroyQuickLaunch, fitQuickLaunch, hideQuickLaunch, prepareQuickLaunch, quickLaunchWindow, setQuickLaunchQuitting, toggleQuickLaunch } from './window';

type GetWindow = () => BrowserWindow | null;

/** Context from the main renderer, which owns the workspace tree and the theme. */
type RendererContext = Pick<QuickLaunchContext, 'workspaces' | 'activeWorkspaceId' | 'theme' | 'customThemeColors' | 'locale'>;

const PROMPT_FILES_KEPT = 50;

function promptDir(): string {
  return path.join(os.homedir(), `.wmux${dataSuffix()}`, 'quick-launch', 'prompts');
}

/**
 * The prompt goes to the agent as `"$(cat <file>)"` (workerLaunchCommand), the
 * way fan-out sends one, so no prompt text is ever typed into a shell. Old
 * files are pruned: each is read once, when its agent starts.
 */
function writePromptFile(prompt: string): string {
  const dir = promptDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.md`);
  fs.writeFileSync(file, prompt, { encoding: 'utf8', mode: 0o600 });
  try {
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - PROMPT_FILES_KEPT))) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    // Pruning is housekeeping; never fail a launch over it.
  }
  return file;
}

/**
 * Whether `accelerator` is already a wmux shortcut on `platform`: a built-in
 * key, or another global chord wmux holds (`otherGlobal`, e.g. the
 * computer-use stop key). A global chord wins over the app's own keys, so
 * taking one would silently disable that shortcut.
 */
export function clashesWithBuiltin(accelerator: string, platform: NodeJS.Platform, otherGlobal: readonly string[] = []): boolean {
  const wanted = resolveForPlatform(accelerator, platform);
  return [...reservedAccelerators(platform), ...otherGlobal].some((own) => resolveForPlatform(own, platform) === wanted);
}

/** An accelerator as Settings shows it on this OS (`⌘+K`, `Ctrl+K`). */
function keysOf(accelerator: string): string {
  return formatAccelerator(accelerator, process.platform === 'darwin');
}

function fromComposer(event: IpcMainInvokeEvent): boolean {
  const win = quickLaunchWindow();
  return Boolean(win && event.sender === win.webContents);
}

async function rendererContext(getMainWindow: GetWindow): Promise<RendererContext> {
  return (await sendToRenderer(getMainWindow, 'quickLaunch.context', {}, { timeoutMs: 3000 })) as RendererContext;
}

export async function launchQuick(
  req: QuickLaunchRequest,
  deps: { getMainWindow: GetWindow; fanOutService: FanOutService },
): Promise<QuickLaunchResult> {
  let context: RendererContext;
  try {
    context = await rendererContext(deps.getMainWindow);
  } catch {
    return { ok: false, error: 'wmux is still starting. Try again in a moment.' };
  }
  const ws = context.workspaces.find((w) => w.id === req.workspaceId);
  if (!ws) return { ok: false, error: 'That workspace is gone. Pick another one.' };
  if (!ws.cwd) return { ok: false, error: `${ws.name} has no folder yet. Open a terminal in it first.` };
  const title = quickLaunchTitle(req.prompt);
  const { role, agentChoice } = quickLaunchAgentFields(req.agent);

  if (req.checkout === 'worktree') {
    const result = await startGuiFanOut(deps.fanOutService, {
      idempotencyKey: `quick-${randomUUID()}`,
      prompt: req.prompt,
      titles: [title],
      repoPath: ws.cwd,
      agentCmd: 'claude',
      ...(role ? { roles: [role] } : {}),
      ...(agentChoice ? { agents: [agentChoice] } : {}),
      worktree: true,
      verifiedWorkspaceId: ws.id,
    });
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error ?? result.tasks.find((t) => t.error)?.error ?? 'The worktree could not be started.' };
  }

  // Current checkout: the person's own working tree, so no worker permission
  // mode is applied — the agent asks before it acts, as one opened by hand does.
  let promptPath: string;
  try {
    promptPath = writePromptFile(req.prompt);
  } catch (err) {
    return { ok: false, error: `Could not save the prompt: ${(err as Error).message}` };
  }
  const launch = workerLaunchCommand('claude', promptPath);
  const env = firstRunEnvForAgent(agentChoice?.agent ?? 'claude');
  try {
    const spawned = (await sendToRenderer(
      deps.getMainWindow,
      'fanout.spawnWorkspace',
      {
        name: `quick: ${title.slice(0, 32)}`,
        cwd: ws.cwd,
        initialCommand: launch.command,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(role ? { role } : {}),
        ...(agentChoice ? { agentChoice } : {}),
        // Nested under the picked workspace, but not a fan-out task (no
        // lineage stamp): it must not use up the fan-out cap or depth.
        nestUnder: ws.id,
        fanoutOrigin: { kind: 'gui' },
      },
      { timeoutMs: 30_000 },
    )) as { error?: string } | null;
    if (spawned && typeof spawned.error === 'string') return { ok: false, error: spawned.error };
  } catch (err) {
    return { ok: false, error: `The agent could not be started: ${(err as Error).message}` };
  }
  return { ok: true };
}

export function initQuickLaunch(deps: {
  getMainWindow: GetWindow;
  fanOutService: FanOutService;
  isQuitting: () => boolean;
  /** Other global chords wmux holds, which the quick-launch chord may not reuse. */
  otherGlobalShortcuts: readonly string[];
}): { dispose(): void } {
  setQuickLaunchQuitting(deps.isQuitting);
  const clashes = (accelerator: string) => clashesWithBuiltin(accelerator, process.platform, deps.otherGlobalShortcuts);
  const clashReason = 'it is already a wmux shortcut';
  /** Hold the configured chord, unless it would shadow another wmux shortcut. */
  const applyConfig = (config: { enabled: boolean; accelerator: string }): boolean => {
    if (config.enabled && clashes(config.accelerator)) {
      hotkey.block(config.accelerator, clashReason);
      return false;
    }
    return hotkey.apply(config.enabled, config.accelerator);
  };
  const notifyShown = (win: BrowserWindow) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send(IPC.QUICK_LAUNCH_SHOWN));
    else win.webContents.send(IPC.QUICK_LAUNCH_SHOWN);
  };
  const hotkey = new QuickLaunchHotkey({
    registry: globalShortcut,
    onPress: () => toggleQuickLaunch(notifyShown),
    log: (m) => console.warn(m),
  });
  applyConfig(readQuickLaunchConfig());
  // Off the boot path: the main window loads first.
  const prepareTimer = setTimeout(() => {
    if (readQuickLaunchConfig().enabled) prepareQuickLaunch();
  }, 5000);

  const snapshot = (error?: string): QuickLaunchSettingsPayload => {
    const config = readQuickLaunchConfig();
    // Re-applied on every read, so a chord another app has since let go of is
    // claimed the next time Settings looks.
    applyConfig(config);
    const reason = hotkey.failureReason();
    return { ...config, status: hotkey.status(), ...(error || reason ? { error: error ?? reason } : {}) };
  };

  ipcMain.removeHandler(IPC.QUICK_LAUNCH_SETTINGS_GET);
  ipcMain.handle(IPC.QUICK_LAUNCH_SETTINGS_GET, () => snapshot());

  ipcMain.removeHandler(IPC.QUICK_LAUNCH_SETTINGS_SET);
  ipcMain.handle(IPC.QUICK_LAUNCH_SETTINGS_SET, (_e, raw: unknown) => {
    const current = readQuickLaunchConfig();
    const patch = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (patch.accelerator !== undefined && !isGlobalAccelerator(patch.accelerator)) {
      return snapshot('Use Command or Control with another key.');
    }
    if (typeof patch.accelerator === 'string' && clashes(patch.accelerator)) {
      return snapshot(`${keysOf(patch.accelerator)} is already a wmux shortcut. Pick another one.`);
    }
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      accelerator: typeof patch.accelerator === 'string' ? patch.accelerator : current.accelerator,
    };
    // Claim first, save second: a chord the OS refuses is never written, so
    // the shortcut that worked keeps working and stays what Settings shows.
    if (!hotkey.apply(next.enabled, next.accelerator)) {
      const reason = hotkey.failureReason() ?? 'the shortcut could not be registered';
      applyConfig(current);
      return snapshot(`${keysOf(next.accelerator)}: ${reason}`);
    }
    try {
      writeQuickLaunchConfig(next);
    } catch (err) {
      applyConfig(current);
      return snapshot(`Could not save: ${(err as Error).message}`);
    }
    if (next.enabled) prepareQuickLaunch();
    else hideQuickLaunch();
    return snapshot();
  });

  ipcMain.removeHandler(IPC.QUICK_LAUNCH_CONTEXT);
  ipcMain.handle(IPC.QUICK_LAUNCH_CONTEXT, async (event): Promise<QuickLaunchContext | null> => {
    if (!fromComposer(event)) return null;
    let context: RendererContext = { workspaces: [] };
    try {
      context = await rendererContext(deps.getMainWindow);
    } catch {
      // The composer says why it has nothing to offer.
    }
    return {
      ...context,
      ...quickLaunchAgentOptions(),
      accelerator: readQuickLaunchConfig().accelerator,
    };
  });

  ipcMain.removeHandler(IPC.QUICK_LAUNCH_SUBMIT);
  ipcMain.handle(IPC.QUICK_LAUNCH_SUBMIT, async (event, raw: unknown): Promise<QuickLaunchResult> => {
    if (!fromComposer(event)) return { ok: false, error: 'Only the quick-launch composer can start agents here.' };
    const req = normalizeQuickLaunchRequest(raw);
    if ('error' in req) return { ok: false, error: req.error };
    const result = await launchQuick(req, deps);
    if (result.ok) hideQuickLaunch();
    return result;
  });

  ipcMain.removeHandler(IPC.QUICK_LAUNCH_DISMISS);
  ipcMain.handle(IPC.QUICK_LAUNCH_DISMISS, (event) => {
    if (fromComposer(event)) hideQuickLaunch();
  });

  ipcMain.removeHandler(IPC.QUICK_LAUNCH_FIT);
  ipcMain.handle(IPC.QUICK_LAUNCH_FIT, (event, height: unknown) => {
    if (fromComposer(event) && typeof height === 'number') fitQuickLaunch(height);
  });

  return {
    dispose() {
      clearTimeout(prepareTimer);
      hotkey.release();
      destroyQuickLaunch();
      for (const channel of [
        IPC.QUICK_LAUNCH_SETTINGS_GET,
        IPC.QUICK_LAUNCH_SETTINGS_SET,
        IPC.QUICK_LAUNCH_CONTEXT,
        IPC.QUICK_LAUNCH_SUBMIT,
        IPC.QUICK_LAUNCH_DISMISS,
        IPC.QUICK_LAUNCH_FIT,
      ]) ipcMain.removeHandler(channel);
    },
  };
}
