/**
 * Chat View composer gate — `surfaceNeedsInput` semantics (plan PR-6, A1/A2/A8).
 *
 * This is the safety gate: while it is engaged the Chat composer removes its
 * textarea, because a blind PTY write into an arrow-key permission menu selects
 * an option. The disqualified designs are asserted here as much as the accepted
 * one — every one of them was a real unlock-while-the-menu-is-up bug:
 *   - `'waiting'` is Claude Code's IDLE footer, not a prompt (A1);
 *   - byte-silence `'idle'` fires ~15s into every menu, because a menu emits no
 *     bytes (A2);
 *   - pane focus clears `surfaceAgentStatus` by design, so an agentStatus-derived
 *     gate unlocks exactly when the user is about to type (plan D5).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import {
  composerGateFromMetadata,
  type ComposerGateSignal,
} from '../../../hooks/composerGateFromMetadata';

type TestState = PaneSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pushToast: ReturnType<typeof vi.fn>;
  zoomedPaneId: string | null;
};

function createTestStore() {
  const ws = createWorkspace('Test');
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      pushToast: vi.fn(),
      zoomedPaneId: null,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
    })),
  );
}

/** Replays what useNotificationListener does with one METADATA_UPDATE payload. */
function applyMetadata(
  store: ReturnType<typeof createTestStore>,
  ptyId: string,
  payload: ComposerGateSignal,
): void {
  const action = composerGateFromMetadata(payload);
  if (action === 'lock') store.getState().lockSurfaceNeedsInput(ptyId);
  else if (action === 'unlock') store.getState().unlockSurfaceNeedsInput(ptyId);
}

/** Replays what the IPC.CHAT_GATE subscription does with one registry event. */
function applyGate(
  store: ReturnType<typeof createTestStore>,
  ptyId: string,
  kind: 'open' | 'closed',
): void {
  if (kind === 'open') store.getState().lockSurfaceNeedsInput(ptyId);
  else store.getState().unlockSurfaceNeedsInput(ptyId);
}

describe('surfaceNeedsInput — locking', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => { store = createTestStore(); });

  it('locks when the daemon ApprovalRegistry opens a request', () => {
    applyGate(store, 'pty-1', 'open');
    expect(store.getState().surfaceNeedsInput['pty-1']).toBe(true);
  });

  it('locks on an awaiting_input signal too (defense in depth, A8)', () => {
    applyMetadata(store, 'pty-1', { agentStatus: 'awaiting_input' });
    expect(store.getState().surfaceNeedsInput['pty-1']).toBe(true);
  });

  it('starts unlocked and ignores an empty ptyId', () => {
    expect(store.getState().surfaceNeedsInput['pty-1']).toBeUndefined();
    store.getState().lockSurfaceNeedsInput('');
    expect(Object.keys(store.getState().surfaceNeedsInput)).toEqual([]);
  });

  it('locks one pane only', () => {
    applyGate(store, 'pty-1', 'open');
    expect(store.getState().surfaceNeedsInput['pty-2']).toBeUndefined();
  });
});

describe('surfaceNeedsInput — what must NOT unlock it', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
    applyGate(store, 'pty-1', 'open');
  });

  it('survives a byte-silence idle broadcast (A2 — a menu emits no bytes)', () => {
    applyMetadata(store, 'pty-1', { agentStatus: 'idle' });
    expect(store.getState().surfaceNeedsInput['pty-1']).toBe(true);
  });

  it("survives 'waiting' — that is Claude Code's idle footer, not a prompt (A1)", () => {
    applyMetadata(store, 'pty-1', { agentStatus: 'waiting' });
    expect(store.getState().surfaceNeedsInput['pty-1']).toBe(true);
  });

  it('survives pane focus, which clears surfaceAgentStatus by design (D5)', () => {
    // Focus is modelled exactly as the app models it: the attention status is
    // cleared. The gate is a separate map and must not notice.
    store.getState().setSurfaceAgentStatus('pty-1', null);
    expect(store.getState().surfaceAgentStatus['pty-1']).toBeUndefined();
    expect(store.getState().surfaceNeedsInput['pty-1']).toBe(true);
  });

  it('survives a running/complete agentStatus transition on its own', () => {
    applyMetadata(store, 'pty-1', { agentStatus: 'running' });
    expect(store.getState().surfaceNeedsInput['pty-1']).toBe(true);
    applyMetadata(store, 'pty-1', { agentStatus: 'complete' });
    expect(store.getState().surfaceNeedsInput['pty-1']).toBe(true);
  });

  it('survives a byte-sourced running stamp (markSurfaceRunning)', () => {
    store.getState().markSurfaceRunning('pty-1');
    expect(store.getState().surfaceNeedsInput['pty-1']).toBe(true);
  });
});

describe('surfaceNeedsInput — unlocking', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => {
    store = createTestStore();
    applyGate(store, 'pty-1', 'open');
  });

  it('unlocks when the registry resolves the request', () => {
    applyGate(store, 'pty-1', 'closed');
    expect(store.getState().surfaceNeedsInput['pty-1']).toBeUndefined();
  });

  it('unlocks on an agent.stop turn boundary (pendingQuestion always written)', () => {
    // buildTurnBoundaryMetadata: agent.stop → { activity:'', pendingQuestion, agentStatus:'complete' }
    applyMetadata(store, 'pty-1', {
      agentStatus: 'complete',
      activity: '',
      pendingQuestion: '',
    });
    expect(store.getState().surfaceNeedsInput['pty-1']).toBeUndefined();
  });

  it('unlocks on an agent.activity hook arrival (a tool label)', () => {
    applyMetadata(store, 'pty-1', { activity: '✎ fleet.ts' });
    expect(store.getState().surfaceNeedsInput['pty-1']).toBeUndefined();
  });

  it('re-locks after an unlock when a new request opens', () => {
    applyGate(store, 'pty-1', 'closed');
    applyGate(store, 'pty-1', 'open');
    expect(store.getState().surfaceNeedsInput['pty-1']).toBe(true);
  });
});

describe('composerGateFromMetadata — the rule in isolation', () => {
  it('maps every payload class to the right action', () => {
    expect(composerGateFromMetadata({ agentStatus: 'awaiting_input' })).toBe('lock');
    // Lock wins over a turn boundary in the same payload.
    expect(composerGateFromMetadata({ agentStatus: 'awaiting_input', activity: '' })).toBe('lock');
    expect(composerGateFromMetadata({ activity: 'Read package.json' })).toBe('unlock');
    expect(composerGateFromMetadata({ pendingQuestion: 'Which file?' })).toBe('unlock');
    expect(composerGateFromMetadata({ agentStatus: 'idle' })).toBeNull();
    expect(composerGateFromMetadata({ agentStatus: 'waiting' })).toBeNull();
    expect(composerGateFromMetadata({ agentStatus: 'running' })).toBeNull();
    expect(composerGateFromMetadata({ agentStatus: 'complete' })).toBeNull();
    expect(composerGateFromMetadata({})).toBeNull();
    // A cwd/git-only metadata tick carries neither field → no transition.
    expect(composerGateFromMetadata({ agentStatus: undefined })).toBeNull();
  });
});

describe('surfaceNeedsInput — teardown', () => {
  it('closePane drops the lock for every surface under the closing subtree', () => {
    const store = createTestStore();
    const ws = store.getState().workspaces[0];
    const rootId = ws.rootPane.id;
    store.getState().splitPane(rootId, 'horizontal');
    const leaves = store
      .getState()
      .workspaces[0].rootPane;
    // Give the first leaf a ptyId and lock it, then close that leaf.
    const firstLeafId = leaves.type === 'branch' ? leaves.children[0].id : rootId;
    store.setState((s) => {
      const root = s.workspaces[0].rootPane;
      if (root.type !== 'branch') return;
      const leaf = root.children[0];
      if (leaf.type !== 'leaf') return;
      leaf.surfaces.push({
        id: 'sf-1',
        title: 'Terminal',
        ptyId: 'pty-1',
        shell: '',
        cwd: '',
        surfaceType: 'terminal',
      });
    });
    store.getState().lockSurfaceNeedsInput('pty-1');
    store.getState().closePane(firstLeafId);
    expect(store.getState().surfaceNeedsInput['pty-1']).toBeUndefined();
  });
});
