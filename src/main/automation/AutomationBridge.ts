import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/constants';
import {
  AUTOMATION_EVENT,
  type Automation,
  type AutomationEvent,
  type AutomationRun,
} from '../../shared/automation';
import { AutomationClient, type AutomationRpcTransport } from './AutomationClient';
import {
  automationToastText,
  coerceToastLabels,
  DEFAULT_AUTOMATION_TOAST_LABELS,
  type AutomationToastKind,
  type AutomationToastLabels,
} from './toastText';

/** What main pushes to the renderer on IPC.AUTOMATION_PUSH. */
export type AutomationPush =
  | { kind: 'event'; event: AutomationEvent }
  | { kind: 'snapshot'; automations: Automation[]; runs: AutomationRun[] };

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
) => void;

// Module scope, like RemoteInboxBridge's cursor: the bridge is re-created on
// every daemon (re)connect, but a run that already toasted must not toast
// again because the pipe blipped. A full app restart clears it on purpose —
// that is when a still-pending run should be surfaced once more.
const toasted = new Set<string>();
let labels: AutomationToastLabels = DEFAULT_AUTOMATION_TOAST_LABELS;

/** Renderer → main: its locale's status words. Ignores malformed input. */
export function setAutomationToastLabels(input: unknown): void {
  const next = coerceToastLabels(input);
  if (next) labels = next;
}

/** Test-only reset of the module-scope state. */
export function __resetAutomationBridgeForTest(): void {
  toasted.clear();
  labels = DEFAULT_AUTOMATION_TOAST_LABELS;
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
    if (ev.kind !== 'proposed' && ev.kind !== 'grant-raised') return null;
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
  }

  /** Connect-time (and renderer-requested) full pull. */
  async pull(): Promise<void> {
    const api = this.api;
    if (!api || !this.client?.isConnected) return;
    let automations: Automation[];
    let runs: AutomationRun[];
    try {
      [automations, runs] = await Promise.all([api.list(), api.runs()]);
    } catch {
      // A daemon without automation.* (older build) answers Unknown method:
      // there is nothing to show, and nothing to toast.
      return;
    }
    if (api !== this.api) return; // stopped or restarted meanwhile
    this.send({ kind: 'snapshot', automations, runs });
    const names = new Map(automations.map((a) => [a.id, a.name]));
    for (const run of runs) {
      // Restore only what still needs a human now. Historical failures toast
      // once, live, through run-changed — never again on every launch.
      if (run.state === 'awaiting') this.toastRun(run, names.get(run.automationId) ?? '');
    }
    for (const a of automations) {
      if (a.proposed) this.toastAttention(a.id, a.name, 'proposed');
    }
  }

  private handle(ev: AutomationEvent): void {
    this.send({ kind: 'event', event: ev });
    if (ev.type === 'run-changed') {
      this.toastRun(ev.run, ev.automationName);
    } else if (ev.type === 'attention') {
      this.toastAttention(ev.automationId, ev.automationName, ev.kind);
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
    toasted.add(key);
    const request: AutomationOpenRequest = { automationId: run.automationId, runId: run.id };
    this.toast(automationToastText(name, kind, labels), () => this.open(request), { ignoreToastSetting: false });
  }

  private toastAttention(automationId: string, name: string, kind: 'proposed' | 'grant-raised'): void {
    if (kind === 'proposed') {
      const key = `proposed:${automationId}`;
      if (toasted.has(key)) return;
      toasted.add(key);
    }
    // Detection is the control for drafts and raised grants (anyone holding the
    // daemon token could write them), so these ignore the toast toggle — the
    // same exemption the daemon's security notices get.
    this.toast(
      automationToastText(name, kind === 'proposed' ? 'proposed' : 'grantRaised', labels),
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
