// A person's pane in the worker fence (main/agents/paneFence.ts): the tab's
// switch, the launches typed into an opted-in tab, and main's answers.
//
// The switch lives on the tab (Surface.workerFence, in session.json) and in
// main's record per session (factory/pane-fence-sessions.json), which decides.
// The renderer tells main whenever the switch moves, and once per app run for
// every opted-in tab, so a lost main record never leaves a tab unfenced.

import { useStore } from '../stores';
import { t } from '../i18n';
import { paneFenceRefusalReason, type PaneFenceState } from '../../shared/paneFence';
import { launcherStem, tokenize } from '../../shared/agentResume';
import { AGENT_ROWS, agentLauncherStem } from '../../shared/agentIdentity';

const AGENT_STEMS: ReadonlySet<string> = new Set(AGENT_ROWS.map(agentLauncherStem));

/** Whether main refused a fenced launch: notes the refusal on the tab's
 *  chip and returns true. Any other error returns false. */
export function notePaneFenceError(ptyId: string, err: unknown): boolean {
  const reason = paneFenceRefusalReason(err instanceof Error ? err.message : String(err));
  if (!reason) return false;
  useStore.getState().setPaneFenceNotice(ptyId, { kind: 'refused', reason });
  return true;
}

/** A toast with a fence refusal's own sentence, not the IPC error wrapper
 *  around it. Returns false (no toast) for any other error. */
export function toastPaneFenceRefusal(err: unknown): boolean {
  const reason = paneFenceRefusalReason(err instanceof Error ? err.message : String(err));
  if (!reason) return false;
  useStore.getState().pushToast({ level: 'error', message: t('paneFence.refusedTitle', { reason }) });
  return true;
}

/** Main's answer to a typed launch: a fenced launch clears the tab's notice. */
export function notePaneFenceResult(ptyId: string, res: unknown): void {
  const fence = (res as { fence?: PaneFenceState } | undefined)?.fence;
  if (fence?.launched) useStore.getState().setPaneFenceNotice(ptyId, null);
}

/** A keybinding's command in this tab goes through main (typeFencedLaunch)
 *  instead of straight to the shell: the tab is opted in and the command is
 *  one line. Pure. */
export function keybindingGoesThroughFence(surface: { workerFence?: boolean }, command: string): boolean {
  return surface.workerFence === true && !/[\r\n]/.test(command);
}

/** A multi-line keybinding in an opted-in tab that starts an agent: main's
 *  fenced launch takes one line, and the raw write would start it unfenced,
 *  so it is refused (chip and toast) and nothing is typed. True when refused. */
export function refuseMultilineFencedKeybinding(surface: { workerFence?: boolean }, ptyId: string, command: string): boolean {
  if (surface.workerFence !== true || !/[\r\n]/.test(command)) return false;
  // Any word naming an agent (also behind a wrapper such as `command`).
  if (!command.split(/[\r\n]+/).some((l) => tokenize(l).some((tok) => AGENT_STEMS.has(launcherStem(tok.value))))) return false;
  const reason = t('paneFence.multiline');
  useStore.getState().setPaneFenceNotice(ptyId, { kind: 'refused', reason });
  useStore.getState().pushToast({ level: 'error', message: t('paneFence.refusedTitle', { reason }) });
  return true;
}

/** Type a launch line into an opted-in tab through main, which fences an
 *  agent line or refuses it (then the chip and a toast say why). */
export function typeFencedLaunch(ptyId: string, line: string, submit: boolean): void {
  window.electronAPI.pty.writeLaunch(ptyId, line, submit, 'human').then(
    (res: unknown) => notePaneFenceResult(ptyId, res),
    (err: unknown) => {
      notePaneFenceError(ptyId, err);
      if (!toastPaneFenceRefusal(err)) useStore.getState().pushToast({ level: 'error', message: err instanceof Error ? err.message : String(err) });
    },
  );
}

/** The pane menu's switch for one tab: its next agent launch is fenced or
 *  not. `agentRunning`: an agent runs in the tab now, which keeps the state
 *  it started with, so the chip says the change waits for the next launch. */
export function setTabWorkerFence(surfaceId: string, ptyId: string | undefined, on: boolean, agentRunning: boolean): void {
  const store = useStore.getState();
  store.setSurfaceWorkerFence(surfaceId, on);
  if (!ptyId) return;
  store.setPaneFenceNotice(ptyId, agentRunning ? { kind: 'pending' } : null);
  asserted.add(ptyId);
  window.electronAPI.pty.setFence?.(ptyId, on).catch((err: unknown) => {
    // Not recorded in main: the next assertion tries again.
    asserted.delete(ptyId);
    store.pushToast({ level: 'error', message: `${t('paneFence.switchFailed')} (${err instanceof Error ? err.message : String(err)})` });
  });
}

const asserted = new Set<string>();

/** Once per app run per session: tell main an opted-in tab is on (a record
 *  main lost would otherwise let its next launch start unfenced). */
export function assertTabWorkerFence(ptyId: string): void {
  if (!ptyId || asserted.has(ptyId)) return;
  asserted.add(ptyId);
  void window.electronAPI.pty.setFence?.(ptyId, true).catch(() => { asserted.delete(ptyId); });
}

/** Test-only. */
export function __resetPaneFenceForTesting(): void {
  asserted.clear();
}
