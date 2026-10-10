import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_EVENT, AUTOMATION_RPC, type AutomationRun } from '../../../shared/automation';
import { AutomationBridge, __resetAutomationBridgeForTest } from '../AutomationBridge';

// runOwnership: whether a PTY is a daemon-owned scheduled run. Three states;
// the `auto-` prefix alone is never proof; an older snapshot never overwrites
// a newer run event.

function run(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'r1', automationId: 'a1', revision: 1, effectiveMode: 'approval',
    scheduledFor: 0, trigger: 'scheduled', state: 'running', ptyId: 'auto-1', ...over,
  };
}

class FakeClient extends EventEmitter {
  isConnected = true;
  runs: AutomationRun[] = [];
  /** When set, `automation.runs` waits for it (a snapshot in flight). */
  gate: Promise<void> | null = null;
  fail = false;
  rpc = vi.fn(async (method: string) => {
    if (this.fail) throw new Error('daemon busy');
    if (method === AUTOMATION_RPC.list) return { automations: [], pendingAttention: [] };
    if (method === AUTOMATION_RPC.runs) {
      const snapshot = [...this.runs];
      if (this.gate) await this.gate;
      return { runs: snapshot };
    }
    return { ok: true };
  });
}

function setup() {
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } };
  const bridge = new AutomationBridge(() => win as never, vi.fn(() => true));
  return { bridge, client: new FakeClient() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const runEvent = (r: AutomationRun) => ({ type: AUTOMATION_EVENT, data: { type: 'run-changed', run: r, automationName: 'x' } });

beforeEach(() => __resetAutomationBridgeForTest());

describe('AutomationBridge.runOwnership', () => {
  it('a PTY outside the reserved auto- namespace is never a run', () => {
    const { bridge } = setup();
    expect(bridge.runOwnership('pty-7')).toBe('not-owned');
    expect(bridge.runOwnership(undefined)).toBe('not-owned');
  });

  it('an auto- PTY is unknown until the run list is known', async () => {
    const { bridge, client } = setup();
    expect(bridge.runOwnership('auto-1')).toBe('unknown');
    client.fail = true;
    bridge.start(client as never);
    await flush();
    expect(bridge.runOwnership('auto-1')).toBe('unknown');
  });

  it('after the snapshot: a reported run is owned, an auto- PTY the daemon did not report is not', async () => {
    const { bridge, client } = setup();
    client.runs = [run()];
    bridge.start(client as never);
    await flush();
    expect(bridge.runOwnership('auto-1')).toBe('owned');
    expect(bridge.runOwnership('auto-spoofed')).toBe('not-owned');
  });

  it('run events keep it current, and an older snapshot never overwrites a newer event', async () => {
    const { bridge, client } = setup();
    client.runs = [run({ ptyId: 'auto-old' })];
    let open!: () => void;
    client.gate = new Promise<void>((r) => { open = r; });
    bridge.start(client as never);
    await flush();
    // While the snapshot is in flight, the run moves to a new PTY.
    client.emit('event', runEvent(run({ ptyId: 'auto-new' })));
    open();
    await flush();
    expect(bridge.runOwnership('auto-new')).toBe('owned');
    expect(bridge.runOwnership('auto-old')).toBe('not-owned');
  });

  it('a disconnect makes it unknown again', async () => {
    const { bridge, client } = setup();
    client.runs = [run()];
    bridge.start(client as never);
    await flush();
    bridge.stop();
    expect(bridge.runOwnership('auto-1')).toBe('unknown');
  });
});
