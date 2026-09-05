// The INTERRUPT edge. Live finding (Claude Code 2.1.236): the operator stops a
// running turn with Ctrl+C (or ESC ESC), Claude prints "Interrupted · What
// should Claude do instead?" and returns to its prompt — but fires NO Stop
// hook, and the `claude` process is still the pane's foreground command, so
// OSC 133 never reports the shell back at its prompt either. Both existing
// settle edges are blind, and the turn latch held the pane amber ("Running" in
// the roster) until its 30-minute expiry.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const lastBroadcastAgentStatus = new Map<string, string>();
  const broadcastMetadataUpdate = vi.fn(
    (_win: unknown, payload: { ptyId?: string; agentStatus?: string }) => {
      if (payload.ptyId && payload.agentStatus !== undefined) {
        lastBroadcastAgentStatus.set(payload.ptyId, payload.agentStatus);
      }
    },
  );
  return { broadcastMetadataUpdate, lastBroadcastAgentStatus };
});

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  updateCwd: vi.fn(),
  removeCwd: vi.fn(),
  updateBranch: vi.fn(),
  removeBranch: vi.fn(),
  broadcastMetadataUpdate: mocks.broadcastMetadataUpdate,
  getLastBroadcastAgentStatus: (ptyId: string) => mocks.lastBroadcastAgentStatus.get(ptyId),
  clearLastBroadcastAgentStatus: (ptyId: string) => { mocks.lastBroadcastAgentStatus.delete(ptyId); },
}));

import { PTYBridge } from '../PTYBridge';
import type { PTYManager } from '../PTYManager';
import { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { SignalLatencyMeter } from '../../../shared/hooks/SignalLatencyMeter';

function makeBridge() {
  const manager = {
    get: vi.fn(() => undefined),
    remove: vi.fn(),
    onDispose: vi.fn(),
  } as unknown as PTYManager;
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  const router = new HookSignalRouter({ latencyMeter: new SignalLatencyMeter() });
  const bridge = new PTYBridge(manager, () => win as never, () => router);
  return { bridge, router };
}

function idleBroadcasts(ptyId: string): number {
  return mocks.broadcastMetadataUpdate.mock.calls.filter(
    (c) => (c[1] as { ptyId?: string }).ptyId === ptyId
      && (c[1] as { agentStatus?: string }).agentStatus === 'idle',
  ).length;
}

describe('PTYBridge interrupt edge (Ctrl+C / ESC ESC settles a latched pane)', () => {
  beforeEach(() => {
    mocks.broadcastMetadataUpdate.mockClear();
    mocks.lastBroadcastAgentStatus.clear();
  });

  it('releases the latch and broadcasts idle on 0x03', () => {
    const { bridge, router } = makeBridge();
    router.noteHookTurnStart('p1', Date.now(), 'claude');
    expect(router.governsRunningState('p1')).toBe(true);

    bridge.noteInterruptInput('p1', '\x03');

    expect(router.governsRunningState('p1')).toBe(false);
    expect(idleBroadcasts('p1')).toBe(1);
  });

  it('leaves an unlatched pane alone — a plain shell Ctrl+C broadcasts nothing', () => {
    const { bridge } = makeBridge();

    bridge.noteInterruptInput('p1', '\x03');

    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('ignores a lone ESC (arrow keys and CSI reports start with one)', () => {
    const { bridge, router } = makeBridge();
    router.noteHookTurnStart('p1', Date.now(), 'claude');

    bridge.noteInterruptInput('p1', '\x1b');
    bridge.noteInterruptInput('p1', '\x1b[A');

    expect(router.governsRunningState('p1')).toBe(true);
    expect(mocks.broadcastMetadataUpdate).not.toHaveBeenCalled();
  });

  it('releases the latch on ESC ESC', () => {
    const { bridge, router } = makeBridge();
    router.noteHookTurnStart('p1', Date.now(), 'claude');

    bridge.noteInterruptInput('p1', '\x1b\x1b');

    expect(router.governsRunningState('p1')).toBe(false);
    expect(idleBroadcasts('p1')).toBe(1);
  });

  it('releases the latch on two consecutive lone ESC chunks', () => {
    const { bridge, router } = makeBridge();
    router.noteHookTurnStart('p1', Date.now(), 'claude');

    bridge.noteInterruptInput('p1', '\x1b');
    bridge.noteInterruptInput('p1', '\x1b');

    expect(router.governsRunningState('p1')).toBe(false);
    expect(idleBroadcasts('p1')).toBe(1);
  });

  it('withholds the broadcast (but still releases) when the pane holds an unread result', () => {
    const { bridge, router } = makeBridge();
    // The F5 guard, shared with the OSC 133 settle: an interrupt does not
    // un-finish a turn whose result the operator has not read yet.
    mocks.lastBroadcastAgentStatus.set('p1', 'awaiting_input');
    router.noteHookTurnStart('p1', Date.now(), 'claude');

    bridge.noteInterruptInput('p1', '\x03');

    expect(router.governsRunningState('p1')).toBe(false);
    expect(idleBroadcasts('p1')).toBe(0);
  });
});
