import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../shared/constants';
import { AUTOMATION_EVENT, AUTOMATION_RPC, type Automation, type AutomationRun } from '../../../shared/automation';
import {
  AutomationBridge,
  __resetAutomationBridgeForTest,
  setAutomationToastLabels,
  type AutomationToastFn,
} from '../AutomationBridge';
import { automationToastText } from '../toastText';

const PROMPT = 'Summarize the secret quarterly numbers in ~/finance';

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Morning report',
    enabled: true,
    revision: 1,
    trigger: { kind: 'schedule', weekdays: [1, 2, 3, 4, 5], time: '08:30', graceMinutes: 180 },
    action: { kind: 'launch', cwd: '/work', agent: 'claude', prompt: PROMPT },
    permission: { mode: 'approval' },
    policy: { overlap: 'skip_if_active' },
    nextRunAt: null,
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'desktop-ui',
    ...over,
  };
}

function run(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'r1', automationId: 'a1', revision: 1, effectiveMode: 'approval',
    scheduledFor: 0, trigger: 'scheduled', state: 'running', ptyId: 'auto-1', ...over,
  };
}

class FakeClient extends EventEmitter {
  isConnected = true;
  list: Automation[] = [];
  runs: AutomationRun[] = [];
  rpc = vi.fn(async (method: string) => {
    if (method === AUTOMATION_RPC.list) return { automations: this.list };
    if (method === AUTOMATION_RPC.runs) return { runs: this.runs };
    throw new Error(`Unknown method: ${method}`);
  });
}

function setup() {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } };
  const toast = vi.fn<AutomationToastFn>();
  const bridge = new AutomationBridge(() => win as never, toast);
  const client = new FakeClient();
  return { send, toast, bridge, client };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetAutomationBridgeForTest());

describe('automationToastText', () => {
  it('is exactly "<name> · <status>" and flattens control characters', () => {
    expect(automationToastText('Morning report', 'awaiting')).toBe('Morning report · Needs your response');
    expect(automationToastText('a\nb\u0007c', 'failed')).toBe('a b c · Failed');
  });
});

describe('AutomationBridge', () => {
  it('forwards daemon automation events to the renderer and ignores other broadcasts', async () => {
    const { send, bridge, client } = setup();
    bridge.start(client);
    await flush();
    send.mockClear();
    client.emit('event', { type: 'session.created', data: {} });
    client.emit('event', { type: AUTOMATION_EVENT, data: { type: 'automations-changed' } });
    client.emit('event', { type: AUTOMATION_EVENT, data: { type: 'bogus' } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(IPC.AUTOMATION_PUSH, { kind: 'event', event: { type: 'automations-changed' } });
  });

  it('pulls list + runs on every (re)connect and pushes a snapshot', async () => {
    const { send, bridge, client } = setup();
    client.list = [automation()];
    client.runs = [run({ state: 'completed' })];
    bridge.start(client);
    await flush();
    expect(send).toHaveBeenCalledWith(IPC.AUTOMATION_PUSH, {
      kind: 'snapshot', automations: client.list, runs: client.runs,
    });
    bridge.stop();
    // Reconnect: a fresh start pulls again.
    const second = new FakeClient();
    second.list = client.list;
    bridge.start(second);
    await flush();
    expect(second.rpc).toHaveBeenCalledWith(AUTOMATION_RPC.list, {});
    expect(second.rpc).toHaveBeenCalledWith(AUTOMATION_RPC.runs, {});
  });

  it('toasts awaiting and failed runs once, never completed, and never the prompt', async () => {
    const { toast, bridge, client } = setup();
    bridge.start(client);
    await flush();
    const emitRun = (state: AutomationRun['state']) =>
      client.emit('event', { type: AUTOMATION_EVENT, data: { type: 'run-changed', run: run({ state }), automationName: 'Morning report' } });
    emitRun('awaiting');
    emitRun('awaiting');
    emitRun('completed');
    emitRun('failed');
    expect(toast.mock.calls.map((c) => c[0])).toEqual([
      'Morning report · Needs your response',
      'Morning report · Failed',
    ]);
    for (const [text] of toast.mock.calls) expect(text).not.toContain('quarterly');
  });

  it('restores a still-awaiting run and a pending draft after an app restart, once per process', async () => {
    const { toast, bridge, client } = setup();
    client.list = [automation(), automation({ id: 'a2', name: 'Draft', proposed: true, enabled: false })];
    client.runs = [run({ state: 'awaiting' }), run({ id: 'r0', state: 'failed' })];
    bridge.start(client);
    await flush();
    expect(toast.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['Morning report · Needs your response', { ignoreToastSetting: false }],
      ['Draft · Draft to review', { ignoreToastSetting: true }],
    ]);
    // A pipe blip re-creates the bridge; nothing toasts twice.
    bridge.start(client);
    await flush();
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('opens the run from a toast click and uses the renderer-supplied labels', async () => {
    const { send, toast, bridge, client } = setup();
    setAutomationToastLabels({ awaiting: '응답 대기', failed: '실패', proposed: '검토할 초안', grantRaised: '권한 상승' });
    bridge.start(client);
    await flush();
    client.emit('event', { type: AUTOMATION_EVENT, data: { type: 'run-changed', run: run({ state: 'awaiting' }), automationName: '리포트' } });
    expect(toast.mock.calls[0][0]).toBe('리포트 · 응답 대기');
    toast.mock.calls[0][1]();
    expect(send).toHaveBeenCalledWith(IPC.AUTOMATION_OPEN_RUN, { automationId: 'a1', runId: 'r1' });
  });

  it('stays quiet against a daemon without automation.*', async () => {
    const { send, toast, bridge } = setup();
    const old = new FakeClient();
    old.rpc.mockImplementation(async () => { throw new Error('Unknown method'); });
    bridge.start(old);
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
