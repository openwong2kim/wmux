// Agent markers in ComputerService: every input request carries the agent's
// marker, a helper that lists `markerWait` is told when an agent's input waits
// for another agent's foreground lease, and agents never see the marker methods.

import { describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import { AGENT_MARKER_COLORS } from '../../../shared/computer/agentMarker';
import type { ActionResult, AppInfo, AppState, HelperCapabilities, HelperMethod, WindowInfo } from '../../../shared/computer/protocol';
import { AgentMarkers } from '../agentMarkers';
import { CONTROL_RATE_PER_MINUTE, ComputerService, capabilitiesForAgent, type ComputerAgent, type HelperLike } from '../ComputerService';

const notepad: AppInfo = { id: 'c:\\windows\\notepad.exe', name: 'Notepad', pid: 10, path: 'C:\\Windows\\notepad.exe' };
const notepadWindow: WindowInfo = { id: 'w-10', appId: notepad.id, pid: 10, title: 'Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 } };

const agent = (n: number): ComputerAgent => ({
  key: `claude-code @ ws-a/pty-${n}`,
  label: 'claude-code in workspace "api"',
  ptyId: `pty-${n}`,
  client: 'claude-code',
  workspaceName: 'api',
});
const A = agent(1);
const B = agent(2);

/** `actions`: what the hello lists (`supports`); omit `supports` entirely with `noSupports`. */
function setup(opts: { actions?: string[]; noSupports?: boolean; defer?: boolean } = {}) {
  const actions = opts.actions ?? [];
  const calls: Array<{ method: HelperMethod; params: Record<string, unknown> }> = [];
  let seq = 0;
  const helper: HelperLike = {
    request: (async (method: HelperMethod, params: Record<string, unknown>) => {
      calls.push({ method, params });
      switch (method) {
        case 'resolveTarget':
          return { app: notepad, window: notepadWindow };
        case 'getAppState': {
          const state: AppState = { snapshotId: `s${++seq}`, app: notepad, window: notepadWindow, tree: '0 window', screenshotStatus: { status: 'skipped' } };
          return state;
        }
        case 'openApp':
          return { app: notepad, window: notepadWindow };
        case 'markerWait':
          return { ok: true };
        default: {
          const result: ActionResult = { method: 'synthetic', verification: 'unverified' };
          return result;
        }
      }
    }) as HelperLike['request'],
    ...(!opts.noSupports && { supports: (method: HelperMethod) => actions.includes(method) }),
    abort: vi.fn(),
    dispose: vi.fn(),
    ...(opts.defer !== undefined && { defersForeground: async () => opts.defer as boolean }),
  };
  const markers = new AgentMarkers({ paneTag: (ptyId) => (ptyId === 'pty-1' ? '#api-1' : null) });
  const service = new ComputerService({
    isEnabled: () => true,
    askPerApp: () => false,
    createHelper: () => helper,
    requestConsent: async () => 'approved',
    stopKey: { arm: () => true, release: vi.fn() },
    blockContext: () => ({ selfPids: new Set([1]) }),
    now: () => 1_000_000,
    platform: 'win32',
    markers,
  });
  const snapshot = async (who: ComputerAgent) => (await service.getAppState(who, { app: 'Notepad', mode: 'ax' })).snapshotId;
  const click = async (who: ComputerAgent, snapshotId: string) => service.control(who, { action: 'click', snapshotId, index: 1 });
  const sentTo = (method: HelperMethod) => calls.filter((c) => c.method === method).map((c) => c.params);
  return { service, calls, snapshot, click, sentTo };
}

async function refusal(promise: Promise<unknown>): Promise<ComputerError> {
  try {
    await promise;
  } catch (err) {
    return err as ComputerError;
  }
  throw new Error('expected a refusal');
}

/** The fire-and-forget markerWait goes out on a later tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ComputerService agent markers', () => {
  it('attaches the agent\'s marker to every input request, whatever its lane', async () => {
    for (const defer of [undefined, true]) {
      const { snapshot, click, service, sentTo } = setup({ actions: ['openApp'], defer });
      await click(A, await snapshot(A));
      await service.control(A, { action: 'type', snapshotId: await snapshot(A), text: 'hi' });
      await service.openApp(A, { app: 'Notepad' });
      const marker = { id: expect.stringMatching(/^[0-9a-f]{12}$/), label: '#api-1 · Claude Code', color: AGENT_MARKER_COLORS[0] };
      for (const method of ['click', 'type', 'openApp'] as const) {
        expect(sentTo(method), `${method} defer=${String(defer)}`).toEqual([expect.objectContaining({ marker })]);
      }
      // Observation carries none.
      expect(sentTo('getAppState').every((p) => !('marker' in p))).toBe(true);
    }
  });

  it('shows a waiting marker on a helper that lists markerWait when another agent holds the lease', async () => {
    const { snapshot, click, sentTo } = setup({ actions: ['markerWait', 'markerClear'] });
    const a = await snapshot(A);
    const b = await snapshot(B);
    await click(A, a);
    const busy = await refusal(click(B, b));
    expect(busy.code).toBe('input_busy');
    // markerWait is not the action: the refused input still sent nothing.
    expect(busy.disposition).toBe('not_delivered');
    await settle();
    expect(sentTo('markerWait')).toEqual([{
      marker: { id: expect.any(String), label: 'api · Claude Code', color: AGENT_MARKER_COLORS[1] },
      pid: notepadWindow.pid,
      windowId: notepadWindow.id,
      waitingFor: '#api-1 · Claude Code',
    }]);
    expect(sentTo('click')).toHaveLength(1);
  });

  it('sends no markerWait to a helper that does not list it, or for its own rate cap', async () => {
    for (const opts of [{ actions: [] }, { noSupports: true }]) {
      const { snapshot, click, sentTo } = setup(opts);
      const b = await snapshot(B);
      await click(A, await snapshot(A));
      expect((await refusal(click(B, b))).code).toBe('input_busy');
      await settle();
      expect(sentTo('markerWait')).toEqual([]);
    }

    const { snapshot, click, sentTo } = setup({ actions: ['markerWait'] });
    const a = await snapshot(A);
    for (let i = 0; i < CONTROL_RATE_PER_MINUTE; i++) await click(A, a);
    const capped = await refusal(click(A, a));
    expect(capped.code).toBe('input_busy');
    await settle();
    expect(sentTo('markerWait')).toEqual([]);
  });
});

describe('capabilitiesForAgent', () => {
  it('never lists the methods only main sends (configure, markers), with or without every permission', () => {
    const caps: HelperCapabilities = {
      actions: ['getAppState', 'click', 'openApp', 'configure', 'markerWait', 'markerClear'],
      modes: ['ax', 'vision', 'both'],
      permissions: { accessibility: true, screenRecording: true },
    };
    expect(capabilitiesForAgent(caps).actions).toEqual(['getAppState', 'click', 'openApp']);
    expect(capabilitiesForAgent({ ...caps, permissions: { accessibility: true, screenRecording: false } }).actions)
      .toEqual(['getAppState', 'click', 'openApp']);
    // The helper's own answer is left as it was.
    expect(caps.actions).toContain('markerWait');
  });
});
