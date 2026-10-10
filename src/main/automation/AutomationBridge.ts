import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/constants';
import {
  AUTOMATION_EVENT,
  type Automation,
  type AutomationAttention,
  type AutomationAttentionKind,
  type AutomationEvent,
  type AutomationRun,
} from '../../shared/automation';
import { AutomationClient, type AutomationRpcTransport } from './AutomationClient';
import {
  automationToastText,
  coerceUiLocale,
  toastLabelsFor,
  type AutomationToastKind,
  type AutomationUiLocale,
} from './toastText';
import { noteRunForIdentity, resetIdentityRuns, setRunIdentityTransport } from './runIdentity';

const ATTENTION_TOAST_KIND: Record<AutomationAttentionKind, AutomationToastKind> = {
  proposed: 'proposed',
  'grant-raised': 'grantRaised',
  'needs-regrant': 'needsRegrant',
};

function isAttentionKind(kind: unknown): kind is AutomationAttentionKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ATTENTION_TOAST_KIND, kind);
}

/** What main pushes to the renderer on IPC.AUTOMATION_PUSH. */
export type AutomationPush =
  | { kind: 'event'; event: AutomationEvent }
  | { kind: 'snapshot'; automations: Automation[]; runs: AutomationRun[] }
  /** Queued attention no OS toast could show: surface it in-app instead. */
  | { kind: 'attention'; items: AutomationAttention[] };

/** What a toast click asks the renderer to open. */
export interface AutomationOpenRequest {
  automationId: string;
  runId?: string;
}

/** The DaemonClient surface the bridge needs: its rpc and its event stream. */
export interface AutomationBridgeClient extends AutomationRpcTransport {
  readonly isConnected: boolean;
  on(event: 'event', listener: (ev: { type?: unknown; data?: unknown }) => void): unknown;
  off(event: 'event', listener: (ev: { type?: unknown; data?: unknown }) => void): unknown;
}

export type AutomationToastFn = (
  text: string,
  onClick: () => void,
  opts: { ignoreToastSetting: boolean },
) => boolean;

// Module scope, like RemoteInboxBridge's cursor: the bridge is re-created on
// every daemon (re)connect, but a run that already toasted must not toast
// again because the pipe blipped. A full app restart clears it on purpose —
// that is when a still-pending run should be surfaced once more.
// Capped: a long-running app sees a run key per state change, forever.
const TOASTED_MAX = 500;
const toasted = new Set<string>();
let locale: AutomationUiLocale = 'en';

function remember(key: string): void {
  toasted.delete(key);
  toasted.add(key);
  while (toasted.size > TOASTED_MAX) {
    const oldest = toasted.values().next().value;
    if (oldest === undefined) break;
    toasted.delete(oldest);
  }
}

/** Test-only view of the dedupe set's size. */
export function __toastedSizeForTest(): number {
  return toasted.size;
}

/** Renderer → main: its UI locale id. Main picks the words (en / ko). */
export function setAutomationUiLocale(input: unknown): void {
  locale = coerceUiLocale(input);
}

export function getAutomationUiLocale(): AutomationUiLocale {
  return locale;
}

/** Test-only reset of the module-scope state. */
export function __resetAutomationBridgeForTest(): void {
  toasted.clear();
  locale = 'en';
}

const RUN_STATES = new Set(['launching', 'running', 'awaiting', 'completed', 'failed', 'skipped', 'unknown']);

/** Shape-check a broadcast `data` payload before it crosses into the renderer. */
export function parseAutomationEvent(data: unknown): AutomationEvent | null {
  if (!data || typeof data !== 'object') return null;
  const ev = data as Record<string, unknown>;
  if (ev.type === 'automations-changed') return { type: 'automations-changed' };
  if (ev.type === 'run-changed') {
    const run = ev.run as Record<string, unknown> | undefined;
    if (!run || typeof run.id !== 'string' || typeof run.automationId !== 'string') return null;
    if (typeof run.state !== 'string' || !RUN_STATES.has(run.state)) return null;
    return {
      type: 'run-changed',
      run: run as unknown as AutomationRun,
      automationName: typeof ev.automationName === 'string' ? ev.automationName : '',
    };
  }
  if (ev.type === 'attention') {
    if (typeof ev.automationId !== 'string') return null;
    if (!isAttentionKind(ev.kind)) return null;
    return {
      type: 'attention',
      automationId: ev.automationId,
      automationName: typeof ev.automationName === 'string' ? ev.automationName : '',
      kind: ev.kind,
    };
  }
  return null;
}

/**
 * Main-side half of scheduled runs: forwards the daemon's `automation.event`
 * broadcasts to the renderer, raises the OS toasts (awaiting / failed /
 * attention — never completed, which stays in-app), and on every (re)connect
 * pulls `automation.list` + `automation.runs` so the sidebar counts and a
 * still-awaiting run survive an app restart.
 */
export class AutomationBridge {
  private client: AutomationBridgeClient | null = null;
  private api: AutomationClient | null = null;
  private cleanups: Array<() => void> = [];

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly toast: AutomationToastFn,
  ) {}

  start(client: AutomationBridgeClient): void {
    this.stop();
    this.client = client;
    this.api = new AutomationClient(client);
    setRunIdentityTransport(client);
    const onEvent = (ev: { type?: unknown; data?: unknown }): void => {
      if (ev?.type !== AUTOMATION_EVENT) return;
      const parsed = parseAutomationEvent(ev.data);
      if (parsed) this.handle(parsed);
    };
    client.on('event', onEvent);
    this.cleanups.push(() => client.off('event', onEvent));
    void this.pull();
  }

  stop(): void {
    for (const off of this.cleanups) {
      try { off(); } catch { /* a cleanup must never throw out of stop() */ }
    }
    this.cleanups = [];
    this.client = null;
    this.api = null;
    setRunIdentityTransport(null);
  }

  /** Connect-time full pull: snapshot to the renderer, then what needs a human. */
  async pull(): Promise<void> {
    const api = this.api;
    if (!api || !this.client?.isConnected) return;
    let listed: { automations: Automation[]; pendingAttention: AutomationAttention[] };
    let runs: AutomationRun[];
    try {
      [listed, runs] = await Promise.all([api.list(), api.runs()]);
    } catch {
      // A daemon without automation.* (older build) answers Unknown method:
      // there is nothing to show, and nothing to toast.
      return;
    }
    if (api !== this.api) return; // stopped or restarted meanwhile
    resetIdentityRuns(runs);
    this.send({ kind: 'snapshot', automations: listed.automations, runs });
    const names = new Map(listed.automations.map((a) => [a.id, a.name]));
    for (const run of runs) {
      // Restore only what still needs a human now. Historical failures toast
      // once, live, through run-changed — never again on every launch.
      if (run.state === 'awaiting') this.toastRun(run, names.get(run.automationId) ?? '');
    }
    await this.surfaceAttention(api, listed.pendingAttention);
  }

  /**
   * Drafts and raised grants come from the daemon's attention queue, which
   * keeps them until a first-party client acknowledges them — so one that
   * arrived while no desktop was connected still surfaces here. Toast each
   * queued item once, then ack what was shown so the next launch stays quiet.
   */
  private async surfaceAttention(api: AutomationClient, items: AutomationAttention[]): Promise<void> {
    const shown: string[] = [];
    const inApp: AutomationAttention[] = [];
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || typeof item.automationId !== 'string') continue;
      if (!isAttentionKind(item.kind)) continue;
      const key = `attention:${item.id}`;
      if (toasted.has(key)) continue;
      remember(key);
      if (this.toastAttention(item.automationId, item.automationName ?? '', item.kind)) shown.push(item.id);
      else inApp.push(item);
    }
    // No OS toast (unsupported platform, window-less): keep it queued so a
    // later launch can still toast it, and show it in the app now.
    if (inApp.length > 0) this.send({ kind: 'attention', items: inApp });
    if (shown.length === 0) return;
    // Refused or failed: the items stay queued and resurface on the next
    // connect; the per-process key set keeps this process from repeating them.
    await api.ackAttention(shown);
  }

  private async pullAttention(): Promise<void> {
    const api = this.api;
    if (!api || !this.client?.isConnected) return;
    let pending: AutomationAttention[];
    try {
      pending = (await api.list()).pendingAttention;
    } catch {
      return;
    }
    if (api !== this.api) return;
    await this.surfaceAttention(api, pending);
  }

  private handle(ev: AutomationEvent): void {
    this.send({ kind: 'event', event: ev });
    if (ev.type === 'run-changed') {
      noteRunForIdentity(ev.run);
      this.toastRun(ev.run, ev.automationName);
    } else if (ev.type === 'attention') {
      // The live event carries no queue id; read the queue so the toast and
      // its ack refer to the same item.
      void this.pullAttention();
    }
  }

  private toastRun(run: AutomationRun, name: string): void {
    const awaitingKey = `${run.id}:awaiting`;
    if (run.state !== 'awaiting') toasted.delete(awaitingKey); // the next wait toasts again
    let kind: AutomationToastKind | null = null;
    if (run.state === 'awaiting') kind = 'awaiting';
    else if (run.state === 'failed') kind = 'failed';
    if (!kind) return;
    const key = `${run.id}:${run.state}`;
    if (toasted.has(key)) return;
    remember(key);
    const request: AutomationOpenRequest = { automationId: run.automationId, runId: run.id };
    this.toast(automationToastText(name, kind, toastLabelsFor(locale)), () => this.open(request), { ignoreToastSetting: false });
  }

  private toastAttention(automationId: string, name: string, kind: AutomationAttentionKind): boolean {
    // Detection is the control for drafts and raised grants (anyone holding the
    // daemon token could write them), so these ignore the toast toggle — the
    // same exemption the daemon's security notices get. A stale grant rides
    // along: its schedule's runs are being skipped until a human acts.
    return this.toast(
      automationToastText(name, ATTENTION_TOAST_KIND[kind], toastLabelsFor(locale)),
      () => this.open({ automationId }),
      { ignoreToastSetting: true },
    );
  }

  private open(request: AutomationOpenRequest): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(IPC.AUTOMATION_OPEN_RUN, request);
  }

  private send(push: AutomationPush): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(IPC.AUTOMATION_PUSH, push);
  }
}
