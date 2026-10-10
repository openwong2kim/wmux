import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import {
  AUTOMATION_AGENT_CAPS,
  AUTOMATION_CAPABILITY_BROWSER_IDENTITY,
  type Automation,
  type AutomationBrowserIdentity,
  type AutomationDraft,
  type AutomationMutationResult,
  type AutomationOkResult,
  type AutomationPermissionMode,
  type AutomationRunNowResult,
  type AutomationRun,
} from '../../../shared/automation';
import {
  browserIdentitySources,
  forgetRunIdentity,
  panePolicyFingerprint,
  pruneRunIdentities,
  recordRunIdentity,
} from '../../automation/runIdentity';
import { isTrustedMainFrameSender, UNTRUSTED_SENDER_ERROR } from './browserPolicy.handler';
import { getWorkspaceMirror } from '../../workspace/WorkspaceMirror';
import { AutomationClient } from '../../automation/AutomationClient';
import { getAutomationUiLocale, setAutomationUiLocale } from '../../automation/AutomationBridge';
import { bypassConfirmCopy, type AutomationUiLocale } from '../../automation/toastText';

const NO_DAEMON = 'daemon unavailable';
const MODES: readonly AutomationPermissionMode[] = ['approval', 'scoped', 'auto', 'bypass'];

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isDraft(value: unknown): value is AutomationDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return typeof d.name === 'string'
    && !!d.trigger && typeof d.trigger === 'object'
    && !!d.action && typeof d.action === 'object';
}

/**
 * Scheduled runs — renderer ⇄ daemon `automation.*` pass-throughs. Registered
 * in both modes (like web.handler): with no daemon every read resolves empty
 * and every mutation `{ ok:false }`, so the renderer never meets a missing
 * handler across the connect/disconnect handler swap. Validation of what a
 * draft may contain lives daemon-side; this only rejects malformed shapes.
 * `automation.propose` is deliberately absent — that is the MCP path.
 */
/** The modes that run with no human answering prompts, so main confirms them natively. */
export type ConfirmedGrantMode = Extract<AutomationPermissionMode, 'auto' | 'bypass'>;

/**
 * Native confirmation for an Auto or Bypass grant, owned by main so no
 * renderer path (editor, "Grant again", a direct IPC call) can raise a
 * schedule to either without the human seeing it. A mode pre-selected in the
 * editor is not consent; this prompt is. Resolves true only on an explicit
 * confirm.
 */
export type GrantConfirmFn = (win: BrowserWindow | null, automationName: string, mode: ConfirmedGrantMode) => Promise<boolean>;

/** Main-owned copy for the native Auto confirmation (en / ko, like Bypass). */
export function autoConfirmCopy(locale: AutomationUiLocale, automationName: string): {
  message: string; detail: string; confirm: string; cancel: string;
} {
  const { cancel } = bypassConfirmCopy(locale, automationName);
  // One line, bounded by code point, like the Bypass copy's name.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const flat = automationName.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  const name = (points.length > 80 ? `${points.slice(0, 79).join('')}…` : flat) || 'wmux';
  return locale === 'ko'
    ? {
      message: `"${name}"을(를) Claude 자동 모드로 실행할까요?`,
      detail: '정한 시각에, 자리에 없을 때도 Claude가 일상적인 작업은 스스로 승인하고 위험한 작업은 막습니다. 이 실행에서는 wmux 도구가 꺼집니다.',
      confirm: '자동 모드 사용',
      cancel,
    }
    : {
      message: `Run "${name}" in Claude's auto mode?`,
      detail: "At the scheduled time, including while you are away, Claude approves routine actions itself and stops risky ones. The run gets none of wmux's own tools.",
      confirm: 'Use Auto',
      cancel,
    };
}

/** What the native confirm shows for a browser identity (all resolved by main). */
export interface BrowserIdentityConfirmView {
  paneLabel: string;
  profileId: string;
  hosts: string[];
  mode: AutomationPermissionMode;
}

/**
 * Native confirmation for binding a browser identity to a schedule: the pane,
 * its Chrome profile and its allowed sites, as main resolved them. Shown in
 * every permission mode — the identity is a grant of its own.
 */
export type IdentityConfirmFn = (win: BrowserWindow | null, automationName: string, view: BrowserIdentityConfirmView) => Promise<boolean>;

/** Main-owned copy for the browser identity confirmation (en / ko, like Bypass). */
export function identityConfirmCopy(locale: AutomationUiLocale, automationName: string, view: BrowserIdentityConfirmView): {
  message: string; detail: string; confirm: string; cancel: string;
} {
  const { cancel } = bypassConfirmCopy(locale, automationName);
  const flat = (v: string, max: number) => {
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    const one = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
    const points = Array.from(one);
    return points.length > max ? `${points.slice(0, max - 1).join('')}…` : one;
  };
  const name = flat(automationName, 80) || 'wmux';
  const pane = flat(view.paneLabel, 80) || 'pane';
  const profile = flat(view.profileId, 80);
  const shown = view.hosts.slice(0, 8).map((h) => flat(h, 80));
  const more = view.hosts.length > shown.length ? view.hosts.length - shown.length : 0;
  const unattended = view.mode !== 'approval';
  // This prompt replaces the Auto / Bypass confirm, so it states the mode too.
  const modeLine = (lang: AutomationUiLocale): string => {
    if (view.mode === 'bypass') return bypassConfirmCopy(lang, automationName).detail;
    if (view.mode === 'auto') {
      return lang === 'ko'
        ? 'Claude 자동 모드로 실행합니다: 일상적인 작업은 Claude가 스스로 승인하고 위험한 작업은 막습니다.'
        : "It runs in Claude's auto mode: Claude approves routine actions itself and stops risky ones.";
    }
    if (view.mode === 'scoped') return lang === 'ko' ? '지정한 도구만 묻지 않고 실행합니다.' : 'Only the tools you listed run without asking.';
    return lang === 'ko' ? '각 작업은 승인을 묻습니다.' : 'Each action asks for approval.';
  };
  if (locale === 'ko') {
    const sites = view.hosts.length === 0 ? '(허용된 사이트 없음)' : `${shown.join(', ')}${more ? ` 외 ${more}개` : ''}`;
    return {
      message: `"${name}"이(가) "${pane}" 창의 브라우저를 쓰도록 할까요?`,
      detail: `Chrome 프로필: ${profile}\n허용 사이트: ${sites}\n\n${modeLine('ko')}\n정한 시각에${unattended ? ', 자리에 없을 때도' : ''} 이 계정으로 위 사이트만 엽니다. 이 실행에서는 wmux 도구 중 브라우저만 쓸 수 있습니다. 창의 정책이 바뀌면 다시 허용할 때까지 브라우저 호출이 거부됩니다.`,
      confirm: view.mode === 'bypass' ? '바이패스와 브라우저 허용' : view.mode === 'auto' ? '자동 모드와 브라우저 허용' : '브라우저 허용',
      cancel,
    };
  }
  const sites = view.hosts.length === 0 ? '(no allowed sites)' : `${shown.join(', ')}${more ? ` and ${more} more` : ''}`;
  return {
    message: `Let "${name}" use the browser of pane "${pane}"?`,
    detail: `Chrome profile: ${profile}\nAllowed sites: ${sites}\n\n${modeLine('en')}\nAt the scheduled time${unattended ? ', including while you are away,' : ''} it opens only these sites as this account. The run gets wmux's browser tools and nothing else of wmux. If the pane's policy changes, its browser calls are refused until you grant it again.`,
    confirm: view.mode === 'bypass' ? 'Use Bypass and allow browser' : view.mode === 'auto' ? 'Use Auto and allow browser' : 'Allow browser',
    cancel,
  };
}

export const confirmIdentityNatively: IdentityConfirmFn = async (win, automationName, view) => {
  const copy = identityConfirmCopy(getAutomationUiLocale(), automationName, view);
  const opts = {
    type: 'question' as const,
    buttons: [copy.cancel, copy.confirm],
    defaultId: 0,
    cancelId: 0,
    message: copy.message,
    detail: copy.detail,
    noLink: true,
  };
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
};

/** The renderer's pick: a workspace and one of its protected panes. Labels are display only. */
interface IdentityPick {
  workspaceId: string;
  paneId: string;
  paneLabel: string;
}

function parseIdentityPick(raw: unknown): IdentityPick | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  if (!ok(r.workspaceId) || !ok(r.paneId)) return null;
  return {
    workspaceId: r.workspaceId,
    paneId: r.paneId,
    paneLabel: typeof r.paneLabel === 'string' ? r.paneLabel.slice(0, 200) : '',
  };
}

/**
 * Resolve a pick against main's own state: the pane must live in that
 * workspace now, be protected and confirmed for that workspace, and resolve to
 * its own exclusive profile — the one its policy was confirmed for.
 */
export function resolveIdentityPick(
  pick: IdentityPick,
  paneWorkspace: (paneId: string) => string | null,
): { ok: true; profileId: string; hosts: string[]; fingerprint: string } | { ok: false; error: string } {
  const src = browserIdentitySources();
  if (!src) return { ok: false, error: 'The browser policy is not available' };
  if (paneWorkspace(pick.paneId) !== pick.workspaceId) return { ok: false, error: 'That pane is not in the chosen workspace' };
  const entry = src.entryFor(pick.paneId);
  if (!entry || !entry.protected || entry.needsConfirm || entry.workspaceId !== pick.workspaceId) {
    return { ok: false, error: 'That pane is not a protected browser pane with a confirmed site list' };
  }
  const profile = src.profileFor(pick.workspaceId, pick.paneId);
  const binding = src.paneBindings()[pick.paneId];
  if (
    !profile || profile.toLowerCase() !== entry.profileId.toLowerCase()
    || !binding || binding.workspaceId !== pick.workspaceId || binding.profile.toLowerCase() !== profile.toLowerCase()
  ) {
    return { ok: false, error: "That pane's Chrome profile changed; confirm its browser protection again" };
  }
  const hosts = entry.hosts.mode === 'allowlist' ? [...entry.hosts.allow] : ['*'];
  return { ok: true, profileId: entry.profileId, hosts, fingerprint: panePolicyFingerprint(entry, binding.profile) };
}

export const confirmGrantNatively: GrantConfirmFn = async (win, automationName, mode) => {
  const locale = getAutomationUiLocale();
  const copy = mode === 'auto' ? autoConfirmCopy(locale, automationName) : bypassConfirmCopy(locale, automationName);
  const opts = {
    type: 'question' as const,
    buttons: [copy.cancel, copy.confirm],
    defaultId: 0,
    cancelId: 0,
    message: copy.message,
    detail: copy.detail,
    noLink: true,
  };
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
};

export function registerAutomationHandlers(
  getClient: () => DaemonClient | null,
  confirmGrant: GrantConfirmFn = confirmGrantNatively,
  /** The main window: a browser identity is granted from its top frame only. */
  getMainWindow: () => BrowserWindow | null = () => null,
  confirmIdentity: IdentityConfirmFn = confirmIdentityNatively,
  paneWorkspace: (paneId: string) => string | null = (paneId) => getWorkspaceMirror().getPaneWorkspaces()?.get(paneId) ?? null,
): () => void {
  const api = (): AutomationClient | null => {
    const client = getClient();
    return client && client.isConnected ? new AutomationClient(client) : null;
  };
  const refuse = (error = NO_DAEMON): { ok: false; error: string } => ({ ok: false, error });

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, async (_event, ...args: unknown[]) => fn(...(args as A))));
  };

  handle(IPC.AUTOMATION_LIST, async (): Promise<{ automations: Automation[]; available: boolean; error?: string }> => {
    const a = api();
    if (!a) return { automations: [], available: false };
    try {
      return { automations: (await a.list()).automations, available: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only an older daemon (Unknown method) means the feature is not there;
      // a timeout or a blip must not make the sidebar row vanish.
      if (message.includes('Unknown method')) return { automations: [], available: false };
      return { automations: [], available: true, error: message };
    }
  });

  handle(IPC.AUTOMATION_RUNS, async (automationId?: unknown): Promise<{ runs: AutomationRun[] }> => {
    const a = api();
    if (!a) return { runs: [] };
    try {
      // Absent = every run; present but malformed must not widen to "all".
      if (automationId !== undefined && !isId(automationId)) return { runs: [] };
      return { runs: await a.runs(automationId) };
    } catch {
      return { runs: [] };
    }
  });

  handle(IPC.AUTOMATION_SNAPSHOT, async (runId: unknown): Promise<{ text: string | null }> => {
    const a = api();
    if (!a || !isId(runId)) return { text: null };
    try {
      return { text: await a.snapshot(runId) };
    } catch {
      return { text: null };
    }
  });

  handle(IPC.AUTOMATION_CREATE, async (draft: unknown, enabled?: unknown): Promise<AutomationMutationResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isDraft(draft)) return refuse('invalid draft');
    return a.create({ draft, ...(typeof enabled === 'boolean' ? { enabled } : {}) });
  });

  handle(IPC.AUTOMATION_UPDATE, async (id: unknown, draft: unknown): Promise<AutomationMutationResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(id) || !isDraft(draft)) return refuse('invalid draft');
    return a.update({ id, draft });
  });

  handle(IPC.AUTOMATION_REMOVE, async (id: unknown): Promise<AutomationOkResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(id)) return refuse('invalid id');
    return a.remove({ id });
  });

  handle(IPC.AUTOMATION_SET_ENABLED, async (id: unknown, enabled: unknown): Promise<AutomationMutationResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(id) || typeof enabled !== 'boolean') return refuse('invalid request');
    return a.setEnabled({ id, enabled });
  });

  // Registered by hand: the Auto/Bypass prompt is parented to the invoking window.
  ipcMain.removeHandler(IPC.AUTOMATION_GRANT);
  ipcMain.handle(IPC.AUTOMATION_GRANT, wrapHandler(
    IPC.AUTOMATION_GRANT,
    async (
      event: Electron.IpcMainInvokeEvent,
      id: unknown,
      mode: unknown,
      allowedTools: unknown,
      rawIdentity?: unknown,
    ): Promise<AutomationMutationResult> => {
      const a = api();
      if (!a) return refuse();
      if (!isId(id) || !MODES.includes(mode as AutomationPermissionMode)) return refuse('invalid request');
      // A browser identity (a pick, or null to remove one) is the operator's
      // alone: only the main window's top frame may ask for it.
      const identityRequested = rawIdentity !== undefined;
      if (identityRequested && !isTrustedMainFrameSender(event, getMainWindow)) return refuse(UNTRUSTED_SENDER_ERROR);
      const pick = rawIdentity === undefined || rawIdentity === null ? null : parseIdentityPick(rawIdentity);
      if (identityRequested && rawIdentity !== null && !pick) return refuse('invalid browser identity');
      let expectedRevision: number | undefined;
      let browserIdentity: AutomationBrowserIdentity | null | undefined;
      if (mode === 'bypass' || mode === 'auto' || identityRequested) {
        const win = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
        if (identityRequested) {
          // Before anything is sent: an older daemon would drop the identity
          // and grant the schedule without it. Asked on every grant, so a
          // daemon replaced since the last one is caught too.
          if (!(await a.capabilities()).includes(AUTOMATION_CAPABILITY_BROWSER_IDENTITY)) {
            return refuse('The wmux background service is too old for a browser identity; restart wmux and try again');
          }
        }
        // Read BEFORE the prompt: the grant is pinned to the revision the
        // human is confirming, and the daemon refuses it if an edit lands
        // while the prompt is open.
        let target: Automation | undefined;
        try {
          target = (await a.list()).automations.find((x) => x.id === id);
        } catch { /* refused below */ }
        if (!target) return refuse('Not found');
        expectedRevision = target.revision;
        if (pick) {
          if (!AUTOMATION_AGENT_CAPS[target.action.agent]?.unattendedBrowserIdentity && mode !== 'approval') {
            return refuse('A Codex schedule with a browser identity runs in approval mode only');
          }
          const resolved = resolveIdentityPick(pick, paneWorkspace);
          if (!resolved.ok) return refuse(resolved.error);
          const view = { paneLabel: pick.paneLabel || pick.paneId, profileId: resolved.profileId, hosts: resolved.hosts, mode: mode as AutomationPermissionMode };
          // One prompt names the identity and, for Auto/Bypass, the mode.
          if (!(await confirmIdentity(win, target.name, view))) return refuse('cancelled');
          // What was confirmed must still be what is granted.
          const again = resolveIdentityPick(pick, paneWorkspace);
          if (!again.ok || again.fingerprint !== resolved.fingerprint || again.profileId !== resolved.profileId) {
            return refuse("The pane's browser policy changed while you were confirming; grant it again");
          }
          // The daemon may have been replaced while the prompt was open.
          if (!(await a.capabilities()).includes(AUTOMATION_CAPABILITY_BROWSER_IDENTITY)) {
            return refuse('The wmux background service is too old for a browser identity; restart wmux and try again');
          }
          // Main's own record of what the operator confirmed, written before
          // the daemon is told: the daemon keeps only a reference to it.
          const boundRevision = target.revision + 1;
          try {
            await recordRunIdentity({
              automationId: target.id,
              boundRevision,
              workspaceId: pick.workspaceId,
              paneId: pick.paneId,
              profileId: resolved.profileId,
              hosts: resolved.hosts,
              fingerprint: resolved.fingerprint,
              mode: mode as AutomationPermissionMode,
            });
          } catch (err) {
            return refuse(err instanceof Error ? err.message : String(err));
          }
          browserIdentity = { workspaceId: pick.workspaceId, paneId: pick.paneId, boundRevision };
        } else {
          if (identityRequested) browserIdentity = null;
          if ((mode === 'bypass' || mode === 'auto') && !(await confirmGrant(win, target.name, mode))) return refuse('cancelled');
        }
      }
      const tools = Array.isArray(allowedTools) && allowedTools.every((t) => typeof t === 'string')
        ? (allowedTools as string[])
        : undefined;
      const result = await a.grant({
        id,
        mode: mode as AutomationPermissionMode,
        ...(tools ? { allowedTools: tools } : {}),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        ...(browserIdentity !== undefined ? { browserIdentity } : {}),
      });
      // Main's store follows what the daemon actually took (best effort: a
      // snapshot that matches no grant never applies).
      if (browserIdentity) {
        const landed = result.ok && result.automation.action?.browserIdentity?.boundRevision === browserIdentity.boundRevision;
        if (!landed) {
          await forgetRunIdentity(id, browserIdentity.boundRevision).catch(() => undefined);
          return result.ok ? refuse('The background service did not keep the browser identity; restart wmux and grant it again') : result;
        }
        await pruneRunIdentities(id, browserIdentity.boundRevision).catch(() => undefined);
      } else if (browserIdentity === null && result.ok) {
        await forgetRunIdentity(id).catch(() => undefined);
      }
      return result;
    },
  ));

  handle(IPC.AUTOMATION_RUN_NOW, async (id: unknown, kind: unknown): Promise<AutomationRunNowResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(id) || (kind !== 'manual' && kind !== 'test')) return refuse('invalid request');
    return a.runNow({ id, kind });
  });

  handle(IPC.AUTOMATION_CANCEL_RUN, async (runId: unknown): Promise<AutomationOkResult> => {
    const a = api();
    if (!a) return refuse();
    if (!isId(runId)) return refuse('invalid id');
    return a.cancelRun({ runId });
  });

  const onLabels = (_event: Electron.IpcMainEvent, input: unknown): void => {
    setAutomationUiLocale(input);
  };
  ipcMain.removeAllListeners(IPC.AUTOMATION_TOAST_LABELS);
  ipcMain.on(IPC.AUTOMATION_TOAST_LABELS, onLabels);

  return () => {
    for (const channel of [
      IPC.AUTOMATION_LIST, IPC.AUTOMATION_RUNS, IPC.AUTOMATION_SNAPSHOT, IPC.AUTOMATION_CREATE,
      IPC.AUTOMATION_UPDATE, IPC.AUTOMATION_REMOVE, IPC.AUTOMATION_SET_ENABLED, IPC.AUTOMATION_GRANT,
      IPC.AUTOMATION_RUN_NOW, IPC.AUTOMATION_CANCEL_RUN,
    ]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.removeListener(IPC.AUTOMATION_TOAST_LABELS, onLabels);
  };
}
