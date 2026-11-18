// The renderer half of `app.action` (shared/appActions.ts).
//
// Main has already checked the caller and the arguments' shape; it sends the
// caller's workspace as `callerWorkspaceId`. Here the target is resolved in
// the live store and must lie in that workspace. Every handler is told its
// workspace explicitly and never reads `activeWorkspaceId` (the workspace the
// human is looking at), and every handler sets a final state, so running an
// action twice is the same as running it once.
//
// The settings actions are app-wide and need no workspace. Main marks a call
// from a terminal outside any wmux pane with `source: 'command-line'`; only
// those actions run for it, and the change is labelled as made there.

import { useStore } from '../stores';
import type { Notification, Pane, PaneLeaf, Workspace } from '../../shared/types';
import { findParent, findPane, getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { isShadowWorkspaceId } from '../../shared/pcRail';
import {
  appActionRefusal,
  checkAppActionArgs,
  findAppAction,
  type AppActionArgs,
  type AppActionErrorCode,
  type AppActionSpec,
} from '../../shared/appActions';
import {
  APP_SETTING_KEYS,
  describeAppSetting,
  parseAppSetting,
  type AppSettingKey,
  type AppSettingValue,
} from '../../shared/appSettings';
import { resolvePaneName } from '../utils/paneNameResolver';
import { nameRefusalMessage, tabNameRefusal, workspaceNameRefusal } from '../utils/addressableNames';
import { UI_THEME_TOKENS } from '../themes';
import { LOCALE_LOADERS } from '../i18n/localeLoaders';
import { t, type Locale } from '../i18n';
import { sanitizeFontFamily } from '../utils/terminalFont';

type Store = ReturnType<typeof useStore.getState>;
type Refusal = { ok: false; code: AppActionErrorCode; error: string };
type Answer = { ok: true } & Record<string, unknown>;

const refuse = (code: AppActionErrorCode, error: string): Refusal => appActionRefusal(code, error);

/** What a target names: always a workspace, sometimes a pane and a tab in it. */
interface Located {
  ws: Workspace;
  paneId?: string;
  surfaceId?: string;
}

function localWorkspaces(store: Store): Workspace[] {
  return store.workspaces.filter((w) => !isShadowWorkspaceId(w.id));
}

/** Another computer's workspace: a PC rail shadow or an attached remote mirror. */
function isMirrored(store: Store, id: string): boolean {
  if (isShadowWorkspaceId(id)) return true;
  return (store.remoteWorkspaces ?? []).some((r) => r.key === id || r.workspaceId === id);
}

/** The caller's own workspace, or why the action cannot run for it. */
function callerWorkspace(store: Store, callerWorkspaceId: string): Workspace | Refusal {
  if (isMirrored(store, callerWorkspaceId)) {
    return refuse('not_owned', `workspace ${callerWorkspaceId} is another computer's; act on it there`);
  }
  // A cold-parked workspace is not refused: parking only unmounts its
  // terminals' view (the store row and the PTYs stay), and every action is a
  // store write that renders when the workspace is shown again.
  const ws = localWorkspaces(store).find((w) => w.id === callerWorkspaceId);
  return ws ?? refuse('not_found', `your workspace ${callerWorkspaceId} is gone`);
}

/** Resolve a target string anywhere local, then hold it to the caller's workspace. */
function locate(store: Store, target: string, caller: Workspace): Located | Refusal {
  const workspaces = localWorkspaces(store);
  let found: Located | null = null;
  if (target.startsWith('#')) {
    let res = resolvePaneName(workspaces, store.paneLabel, store.surfaceAgent, target);
    // Ambiguous across workspaces can still be one pane in the caller's own.
    if (!res.ok && res.reason === 'ambiguous') {
      const own = resolvePaneName([caller], store.paneLabel, store.surfaceAgent, target);
      if (own.ok) res = own;
    }
    if (!res.ok) return refuse('not_found', res.error);
    const ws = workspaces.find((w) => w.id === res.target.workspaceId);
    if (ws) found = { ws, paneId: res.target.paneId, surfaceId: res.target.surfaceId || undefined };
  } else {
    for (const ws of workspaces) {
      if (ws.id === target) { found = { ws }; break; }
      for (const leaf of getWorkspaceLeafPanes(ws)) {
        if (leaf.id === target) { found = { ws, paneId: leaf.id }; break; }
        if (leaf.surfaces.some((s) => s.id === target)) { found = { ws, paneId: leaf.id, surfaceId: target }; break; }
      }
      if (found) break;
    }
    if (!found && isMirrored(store, target)) {
      return refuse('not_owned', `${target} is another computer's workspace; act on it there`);
    }
  }
  if (!found) return refuse('not_found', `nothing called ${target} (workspace_list, pane_list and surface_list list ids)`);
  if (found.ws.id !== caller.id) {
    return refuse('not_owned', `${target} is in another workspace; an action reaches only your own (${caller.id})`);
  }
  return found;
}

/** The caller's own pane and tab, from the pty of its pane claim. */
function ownPane(caller: Workspace, callerPtyId: string | undefined): { paneId: string; surfaceId: string } | null {
  if (!callerPtyId) return null;
  for (const leaf of getWorkspaceLeafPanes(caller)) {
    const s = leaf.surfaces.find((x) => x.ptyId === callerPtyId);
    if (s) return { paneId: leaf.id, surfaceId: s.id };
  }
  return null;
}

/** The target for this action's kind, defaulting to the caller's own. */
function resolveTarget(
  store: Store,
  spec: AppActionSpec,
  caller: Workspace,
  target: string,
  callerPtyId: string | undefined,
): Located | Refusal {
  if (!target) {
    if (spec.target === 'workspace' || spec.target === 'none') return { ws: caller };
    const own = ownPane(caller, callerPtyId);
    if (!own) {
      return refuse('invalid_args', `${spec.id}: name a --target; wmux could not tell which ${spec.target === 'pane' ? 'pane' : 'tab'} you run in`);
    }
    return { ws: caller, ...own };
  }
  const located = locate(store, target, caller);
  if ('code' in located) return located;
  if (spec.target === 'pane' && !located.paneId) {
    return refuse('invalid_args', `${spec.id}: ${target} is a workspace; name a pane`);
  }
  if (spec.target === 'surface' && !located.surfaceId) {
    if (!located.paneId) return refuse('invalid_args', `${spec.id}: ${target} is a workspace; name a tab`);
    const leaf = getWorkspaceLeafPanes(located.ws).find((l) => l.id === located.paneId);
    if (!leaf?.activeSurfaceId) return refuse('not_found', `${spec.id}: pane ${located.paneId} has no tab`);
    return { ...located, surfaceId: leaf.activeSurfaceId };
  }
  return located;
}

// ─── Settings ────────────────────────────────────────────────────────────────

const SUPPORTED_LOCALES: readonly string[] = ['en', ...Object.keys(LOCALE_LOADERS)];
/** Built-in themes; `custom` is made in Settings, not named here. */
const SETTABLE_THEMES: readonly string[] = Object.keys(UI_THEME_TOKENS).filter((id) => id !== 'custom');

/** Each setting's store field, read as the value `settings.get` reports. */
function readSetting(store: Store, key: AppSettingKey): AppSettingValue {
  switch (key) {
    case 'theme': return store.theme;
    case 'locale': return store.locale;
    case 'terminal.fontSize': return store.terminalFontSize;
    case 'terminal.fontFamily': return store.terminalFontFamily;
    case 'terminal.cursorStyle': return store.terminalCursorStyle;
    case 'terminal.scrollbackLines': return store.scrollbackLines;
    case 'terminal.openFileLinksIn': return store.terminalOpenFileLinksIn;
    case 'terminal.imagePaste': return store.imagePasteMode;
    case 'terminal.splitInheritsCwd': return store.splitInheritsCwd;
    case 'terminal.closeTabOnExit': return store.closeTabOnShellExit;
    case 'ui.scale': return store.uiScale;
    case 'sidebar.position': return store.sidebarPosition;
    case 'sidebar.sort': return store.sidebarSortMode;
    case 'fleet.layout': return store.fleetLayout;
    case 'multiview.arrangement': return store.multiviewArrangement;
    case 'attention.blink': return store.attentionBlink;
    case 'attention.remindMs': return store.attentionBlinkRemindMs;
    case 'attention.finished': return store.attentionBlinkFinished;
    case 'notifications.toast': return store.toastEnabled;
    case 'notifications.sound': return store.notificationSoundEnabled;
    case 'notifications.osRing': return store.notificationRingEnabled;
    case 'notifications.paneRing': return store.paneRingEnabled;
    case 'notifications.paneFlash': return store.paneFlashEnabled;
    case 'notifications.taskbarFlash': return store.taskbarFlashEnabled;
    case 'notifications.glowOpacity': return store.paneGlowOpacity;
    case 'power.keepAwake': return store.sleepPreventionMode;
    case 'titlebar.clock': return store.titlebarClockVisible;
  }
}

/** The value to store for `key`: the shared parse, then what only the renderer knows. */
function parseSetting(key: AppSettingKey, raw: string | number): { value: AppSettingValue } | Refusal {
  const parsed = parseAppSetting(key, raw);
  if (!parsed.ok) return refuse('invalid_args', `settings.set: ${parsed.error}`);
  const text = String(parsed.value);
  switch (key) {
    case 'theme':
      if (text === 'custom') return refuse('invalid_args', 'settings.set: theme "custom" is made in Settings › Appearance');
      if (!SETTABLE_THEMES.includes(text)) {
        return refuse('invalid_args', `settings.set: no theme "${text}" (one of ${SETTABLE_THEMES.join(', ')})`);
      }
      return { value: text };
    case 'locale':
      if (!SUPPORTED_LOCALES.includes(text)) {
        return refuse('invalid_args', `settings.set: no language "${text}" (one of ${SUPPORTED_LOCALES.join(', ')})`);
      }
      return { value: text };
    case 'terminal.fontFamily': {
      const safe = sanitizeFontFamily(text);
      if (!safe) return refuse('invalid_args', 'settings.set: terminal.fontFamily needs a font name');
      return { value: safe };
    }
    default:
      return { value: parsed.value };
  }
}

/** Apply a parsed value through the same store action Settings uses. */
function writeSetting(store: Store, key: AppSettingKey, value: AppSettingValue): void {
  switch (key) {
    case 'theme': store.setTheme(value as string); return;
    case 'locale': store.setLocale(value as Locale); return;
    case 'terminal.fontSize': store.setTerminalFontSize(value as number); return;
    case 'terminal.fontFamily': store.setTerminalFontFamily(value as string); return;
    case 'terminal.cursorStyle': store.setTerminalCursorStyle(value as Store['terminalCursorStyle']); return;
    case 'terminal.scrollbackLines': store.setScrollbackLines(value as number); return;
    case 'terminal.openFileLinksIn': store.setTerminalOpenFileLinksIn(value as Store['terminalOpenFileLinksIn']); return;
    case 'terminal.imagePaste': store.setImagePasteMode(value as Store['imagePasteMode']); return;
    case 'terminal.splitInheritsCwd': store.setSplitInheritsCwd(value as boolean); return;
    case 'terminal.closeTabOnExit': store.setCloseTabOnShellExit(value as boolean); return;
    case 'ui.scale': store.setUiScale(value as number); return;
    case 'sidebar.position': store.setSidebarPosition(value as Store['sidebarPosition']); return;
    case 'sidebar.sort': store.setSidebarSortMode(value as Store['sidebarSortMode']); return;
    case 'fleet.layout': store.setFleetLayout(value as Store['fleetLayout']); return;
    case 'multiview.arrangement': store.setMultiviewArrangement(value as Store['multiviewArrangement']); return;
    case 'attention.blink': store.setAttentionBlink(value as Store['attentionBlink']); return;
    case 'attention.remindMs': store.setAttentionBlinkRemindMs(value as Store['attentionBlinkRemindMs']); return;
    case 'attention.finished': store.setAttentionBlinkFinished(value as Store['attentionBlinkFinished']); return;
    case 'notifications.toast': store.setToastEnabled(value as boolean); return;
    case 'notifications.sound':
      // As the Settings switch does (applyNotificationSound): on also picks the default sound.
      store.setNotificationSoundEnabled(value as boolean);
      if (value) store.setNotificationSoundChoice('default');
      return;
    case 'notifications.osRing': store.setNotificationRingEnabled(value as boolean); return;
    case 'notifications.paneRing': store.setPaneRingEnabled(value as boolean); return;
    case 'notifications.paneFlash': store.setPaneFlashEnabled(value as boolean); return;
    case 'notifications.taskbarFlash': store.setTaskbarFlashEnabled(value as boolean); return;
    case 'notifications.glowOpacity': store.setPaneGlowOpacity(value as number); return;
    case 'power.keepAwake': store.setSleepPreventionMode(value as Store['sleepPreventionMode']); return;
    case 'titlebar.clock': store.setTitlebarClockVisible(value as boolean); return;
  }
}

/** What `key` takes, in words, for `settings.list`. */
function allowedValues(key: AppSettingKey): string {
  if (key === 'theme') return SETTABLE_THEMES.join('|');
  if (key === 'locale') return SUPPORTED_LOCALES.join('|');
  return describeAppSetting(key);
}

/** The settings actions. They need no workspace: a call from the command line has none. */
function runSettingsAction(store: Store, id: string, args: AppActionArgs, fromCommandLine: boolean): Answer | Refusal {
  switch (id) {
    case 'settings.list':
      return {
        ok: true,
        settings: APP_SETTING_KEYS.map((key) => ({ key, value: readSetting(store, key), allowed: allowedValues(key) })),
      };
    case 'settings.get': {
      const keys = args.key ? [args.key as AppSettingKey] : APP_SETTING_KEYS;
      return { ok: true, settings: Object.fromEntries(keys.map((k) => [k, readSetting(store, k)])) };
    }
    case 'settings.set': {
      const key = args.key as AppSettingKey;
      const parsed = parseSetting(key, args.value);
      if ('code' in parsed) return parsed;
      const before = readSetting(store, key);
      if (before === parsed.value) return { ok: true, key, value: parsed.value, changed: false };
      writeSetting(store, key, parsed.value);
      // The human sees that it changed and who changed it.
      const message = t(fromCommandLine ? 'appAction.settingChangedCli' : 'appAction.settingChanged', { setting: key, value: String(parsed.value) });
      store.pushToast({ level: 'info', message });
      return { ok: true, key, value: parsed.value, changed: true };
    }
    default:
      return refuse('unknown_action', `no action "${id}"`);
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function renameWorkspaceAction(store: Store, ws: Workspace, name: string): Answer | Refusal {
  if (ws.name === name) return { ok: true, workspaceId: ws.id, name, changed: false };
  const refusal = workspaceNameRefusal(store.workspaces, ws.id, name);
  if (refusal) return refuse('invalid_args', `workspace.rename: ${nameRefusalMessage(refusal)}`);
  if (!store.renameWorkspace(ws.id, name)) return refuse('not_found', `workspace.rename: workspace ${ws.id} is gone`);
  return { ok: true, workspaceId: ws.id, name, changed: true };
}

function renameTabAction(store: Store, ws: Workspace, surfaceId: string, name: string): Answer | Refusal {
  const surface = getWorkspaceLeafPanes(ws).flatMap((l) => l.surfaces).find((s) => s.id === surfaceId);
  if (!surface) return refuse('not_found', `tab.rename: no tab ${surfaceId}`);
  if (surface.title === name && surface.userName === name) {
    return { ok: true, surfaceId, name, changed: false };
  }
  const refusal = tabNameRefusal(store.workspaces, store.paneLabel, surfaceId, name);
  if (refusal) return refuse('invalid_args', `tab.rename: ${nameRefusalMessage(refusal)}`);
  store.renameSurface(surfaceId, name);
  return { ok: true, surfaceId, name, changed: true };
}

function inLayout(ws: Workspace, paneId: string): PaneLeaf | null {
  const pane = findPane(ws.rootPane, paneId);
  return pane && pane.type === 'leaf' ? pane : null;
}

/** Whether `source` already sits on `edge` of `beside`, alone with it in one split. */
function alreadyBeside(root: Pane, sourceId: string, besideId: string, edge: string): boolean {
  const parent = findParent(root, sourceId);
  if (!parent || parent.children.length !== 2) return false;
  const direction = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
  if (parent.direction !== direction) return false;
  const sourceFirst = edge === 'left' || edge === 'top';
  const [first, second] = parent.children;
  return sourceFirst ? first.id === sourceId && second.id === besideId : first.id === besideId && second.id === sourceId;
}

function movePaneAction(store: Store, ws: Workspace, sourceId: string, args: AppActionArgs): Answer | Refusal {
  const beside = locate(store, String(args.beside), ws);
  if ('code' in beside) return beside;
  if (!beside.paneId) return refuse('invalid_args', `pane.move: ${args.beside} is a workspace; name a pane`);
  const edge = String(args.edge) as 'left' | 'right' | 'top' | 'bottom';
  if (beside.paneId === sourceId) return refuse('invalid_args', 'pane.move: a pane cannot move beside itself');
  if (!inLayout(ws, sourceId)) return refuse('not_found', `pane.move: pane ${sourceId} is not in the layout (stashed?)`);
  if (!inLayout(ws, beside.paneId)) return refuse('not_found', `pane.move: pane ${beside.paneId} is not in the layout (stashed?)`);
  const result = { paneId: sourceId, beside: beside.paneId, edge };
  if (alreadyBeside(ws.rootPane, sourceId, beside.paneId, edge)) return { ok: true, ...result, changed: false };
  if (!findParent(ws.rootPane, sourceId)) return refuse('invalid_args', 'pane.move: the only pane in the workspace has nowhere to go');
  if (!store.movePane(ws.id, sourceId, beside.paneId, edge)) {
    return refuse('not_found', `pane.move: pane ${sourceId} could not be moved`);
  }
  return { ok: true, ...result, changed: true };
}

/**
 * A row that still asks the human for a decision: an approval prompt, or a
 * turn that ended on a question or a permission prompt still waiting. An
 * agent's mark-read or clear leaves these alone, whichever pane they came
 * from, so the badge and the record of the pending decision stay until the
 * human handles them. The human's own clear in the panel is not affected.
 */
function holdsDecision(store: Store, n: Notification): boolean {
  if (n.category === 'approval') return true;
  if (n.category !== 'agent-turn' || !n.ptyId) return false;
  return !!store.surfacePendingQuestion?.[n.ptyId]?.trim() || store.surfaceAgent?.[n.ptyId]?.status === 'awaiting_input';
}

/**
 * Run one `app.action` call the renderer bridge received. `params` is what
 * main sent: `{ id, args, target?, callerWorkspaceId, callerPtyId? }`.
 */
export function runAppAction(params: Record<string, unknown>): Answer | Refusal {
  const store = useStore.getState();
  const id = typeof params.id === 'string' ? params.id : '';
  const spec = findAppAction(id);
  if (!spec) return refuse('unknown_action', `no action "${id}"`);
  // Main checked these already; the bridge is also reachable from elsewhere
  // in the renderer, so they are checked again where they are used.
  const checked = checkAppActionArgs(spec, params.args);
  if (!checked.ok) return refuse('invalid_args', checked.error);
  const args = checked.args;
  const target = typeof params.target === 'string' ? params.target.trim() : '';
  // Only main sets `source`; a call from the command line has no workspace.
  const fromCommandLine = params.source === 'command-line';
  if (fromCommandLine && !id.startsWith('settings.')) return refuse('no_identity', `${id}: run this from a wmux pane`);
  if (fromCommandLine) {
    if (target) return refuse('invalid_args', `${id}: takes no target`);
    return runSettingsAction(store, id, args, true);
  }
  const callerWorkspaceId = typeof params.callerWorkspaceId === 'string' ? params.callerWorkspaceId : '';
  if (!callerWorkspaceId) return refuse('no_identity', `${id}: no caller workspace`);
  const callerPtyId = typeof params.callerPtyId === 'string' && params.callerPtyId ? params.callerPtyId : undefined;

  const caller = callerWorkspace(store, callerWorkspaceId);
  if ('code' in caller) return caller;
  if (spec.target === 'none' && target) return refuse('invalid_args', `${id}: takes no target`);
  const located = resolveTarget(store, spec, caller, target, callerPtyId);
  if ('code' in located) return located;
  const ws = located.ws;

  switch (spec.id) {
    case 'workspace.rename':
      return renameWorkspaceAction(store, ws, String(args.name));
    case 'tab.rename':
      return renameTabAction(store, ws, located.surfaceId as string, String(args.name));
    case 'layout.balance':
      if (!store.balanceWorkspaceLayout(ws.id)) return refuse('not_found', `layout.balance: workspace ${ws.id} is gone`);
      return { ok: true, workspaceId: ws.id };
    case 'pane.move':
      return movePaneAction(store, ws, located.paneId as string, args);
    case 'settings.list':
    case 'settings.get':
    case 'settings.set':
      return runSettingsAction(store, spec.id, args, false);
    case 'notifications.markRead': {
      const rows = store.notifications.filter((n) => n.workspaceId === ws.id && !n.read);
      const held = rows.filter((n) => holdsDecision(store, n));
      for (const n of rows) if (!holdsDecision(store, n)) store.markRead(n.id);
      return { ok: true, workspaceId: ws.id, marked: rows.length - held.length, kept: held.length };
    }
    case 'notifications.clear': {
      const rows = store.notifications.filter((n) => n.workspaceId === ws.id);
      const held = rows.filter((n) => holdsDecision(store, n)).length;
      store.clearNotificationsForWorkspace(ws.id, (n) => holdsDecision(store, n));
      return { ok: true, workspaceId: ws.id, cleared: rows.length - held, kept: held };
    }
    default:
      return refuse('unknown_action', `no action "${id}"`);
  }
}
