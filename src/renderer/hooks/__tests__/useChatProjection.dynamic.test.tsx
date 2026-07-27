// @vitest-environment jsdom
//
// Dynamic verification for the Chat View subscription bridge (plan PR-5).
//
// The preload `chat` surface does not exist yet (it lands in PR-4), so the
// hook must feature-detect it. These tests mount the real hook against the
// real store with a hand-rolled bridge:
//
//   • no `window.electronAPI.chat` at all → mounts and unmounts, no throw
//   • available pane → subscribe + snapshot seed the store as a reset
//   • unavailable pane → status recorded, no subscribe, no snapshot
//   • live appends land only for the matching ptyId
//   • unmount unsubscribes and stops applying appends
//   • daemon:connected re-seeds
//   • loadEarlier pages backward from the held head offset
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useChatProjection } from '../useChatProjection';
import { useStore } from '../../stores';
import type {
  TranscriptAppendData,
  TranscriptCursor,
  TranscriptPage,
  TranscriptStatus,
} from '../../../shared/transcript/turnEvents';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function cursor(headOffset: number, tailOffset: number): TranscriptCursor {
  return { headOffset, tailOffset, fileSize: tailOffset, mtimeMs: 1 };
}

function pageOf(ids: string[], head: number, tail: number): TranscriptPage {
  return {
    events: ids.map((id) => ({ id, kind: 'user_text' as const, text: id })),
    cursor: cursor(head, tail),
    hasMore: head > 0,
    truncatedHead: false,
  };
}

interface Harness {
  status: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  emitAppend: (ptyId: string, data: TranscriptAppendData) => void;
  emitConnected: () => void;
  appendListeners: number;
}

function installBridge(opts: {
  status?: TranscriptStatus;
  snapshot?: TranscriptPage | null;
}): Harness {
  const appendCbs: ((ptyId: string, data: TranscriptAppendData) => void)[] = [];
  const connectedCbs: (() => void)[] = [];
  const h: Harness = {
    status: vi.fn(async () => opts.status ?? { available: true, reason: 'ok' }),
    snapshot: vi.fn(async () => (opts.snapshot === undefined ? pageOf(['u1'], 0, 100) : opts.snapshot)),
    subscribe: vi.fn(async () => ({ ok: true })),
    unsubscribe: vi.fn(async () => ({ ok: true })),
    emitAppend: (ptyId, data) => appendCbs.forEach((cb) => cb(ptyId, data)),
    emitConnected: () => connectedCbs.forEach((cb) => cb()),
    get appendListeners() {
      return appendCbs.length;
    },
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    chat: {
      status: h.status,
      snapshot: h.snapshot,
      subscribe: h.subscribe,
      unsubscribe: h.unsubscribe,
      onAppend: (cb: (ptyId: string, data: TranscriptAppendData) => void) => {
        appendCbs.push(cb);
        return () => {
          const i = appendCbs.indexOf(cb);
          if (i >= 0) appendCbs.splice(i, 1);
        };
      },
    },
    daemon: {
      onConnected: (cb: () => void) => {
        connectedCbs.push(cb);
        return () => {
          const i = connectedCbs.indexOf(cb);
          if (i >= 0) connectedCbs.splice(i, 1);
        };
      },
    },
  };
  return h;
}

let container: HTMLDivElement;
let root: Root;
let controls: ReturnType<typeof useChatProjection> | undefined;

function Probe({ ptyId, enabled }: { ptyId: string; enabled: boolean }): null {
  controls = useChatProjection(ptyId, enabled);
  return null;
}

async function mount(ptyId: string, enabled = true): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe, { ptyId, enabled }));
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

describe('useChatProjection', () => {
  beforeEach(() => {
    useStore.getState().clearChatSurface('pty-a');
    useStore.getState().clearChatSurface('pty-b');
    controls = undefined;
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.restoreAllMocks();
  });

  it('is a no-op when the preload chat surface is absent', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    await mount('pty-a');
    expect(useStore.getState().chatEvents['pty-a']).toBeUndefined();
    await unmount();
  });

  it('is a no-op when electronAPI itself is absent', async () => {
    await mount('pty-a');
    expect(useStore.getState().chatEvents['pty-a']).toBeUndefined();
    await unmount();
  });

  it('records status, subscribes, and seeds from the snapshot as a reset', async () => {
    const h = installBridge({ snapshot: pageOf(['u1', 'u2'], 0, 200) });
    await mount('pty-a');
    expect(h.status).toHaveBeenCalledWith('pty-a');
    expect(h.subscribe).toHaveBeenCalledWith('pty-a');
    expect(useStore.getState().chatStatus['pty-a']).toEqual({ available: true, reason: 'ok' });
    expect(useStore.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1', 'u2']);
    expect(useStore.getState().chatCursor['pty-a']?.tailOffset).toBe(200);
    await unmount();
  });

  it('does not subscribe when the pane has no structured transcript', async () => {
    const h = installBridge({ status: { available: false, reason: 'not-claude' } });
    await mount('pty-a');
    expect(useStore.getState().chatStatus['pty-a']?.reason).toBe('not-claude');
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.snapshot).not.toHaveBeenCalled();
    await unmount();
  });

  it('does nothing while disabled (an unopened Chat surface costs no watcher)', async () => {
    const h = installBridge({});
    await mount('pty-a', false);
    expect(h.status).not.toHaveBeenCalled();
    expect(h.subscribe).not.toHaveBeenCalled();
    await unmount();
  });

  it('applies live appends for its own pane and ignores other panes', async () => {
    const h = installBridge({ snapshot: pageOf(['u1'], 0, 100) });
    await mount('pty-a');
    await act(async () => {
      h.emitAppend('pty-b', { seq: 1, events: [{ id: 'x', kind: 'user_text', text: 'x' }], cursor: cursor(0, 10) });
      h.emitAppend('pty-a', { seq: 1, events: [{ id: 'u2', kind: 'user_text', text: 'u2' }], cursor: cursor(0, 300) });
    });
    expect(useStore.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1', 'u2']);
    expect(useStore.getState().chatEvents['pty-b']).toBeUndefined();
    await unmount();
  });

  it('unsubscribes and stops applying appends on unmount', async () => {
    const h = installBridge({ snapshot: pageOf(['u1'], 0, 100) });
    await mount('pty-a');
    await unmount();
    expect(h.unsubscribe).toHaveBeenCalledWith('pty-a');
    expect(h.appendListeners).toBe(0);
    await act(async () => {
      h.emitAppend('pty-a', { seq: 1, events: [{ id: 'late', kind: 'user_text', text: 'late' }], cursor: cursor(0, 9) });
    });
    expect(useStore.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1']);
  });

  it('re-seeds on daemon:connected (a respawn loses the subscription)', async () => {
    const h = installBridge({ snapshot: pageOf(['u1'], 0, 100) });
    await mount('pty-a');
    h.snapshot.mockResolvedValueOnce(pageOf(['u1', 'u2', 'u3'], 0, 400));
    await act(async () => {
      h.emitConnected();
    });
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    expect(useStore.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1', 'u2', 'u3']);
    await unmount();
  });

  it('loadEarlier pages backward from the held head offset', async () => {
    const h = installBridge({ snapshot: pageOf(['u5'], 500, 900) });
    await mount('pty-a');
    h.snapshot.mockResolvedValueOnce(pageOf(['u1'], 100, 500));
    await act(async () => {
      await controls!.loadEarlier();
    });
    expect(h.snapshot).toHaveBeenLastCalledWith('pty-a', 500);
    expect(useStore.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1', 'u5']);
    await unmount();
  });

  it('loadEarlier is a no-op at the head of the file', async () => {
    const h = installBridge({ snapshot: pageOf(['u1'], 0, 100) });
    await mount('pty-a');
    h.snapshot.mockClear();
    await act(async () => {
      await controls!.loadEarlier();
    });
    expect(h.snapshot).not.toHaveBeenCalled();
    await unmount();
  });

  // The liveness token used to be ONE ref shared by every effect run: the
  // cleanup set it false and the very next run set it back to true, so a
  // `seed(oldPtyId)` awaiting across a ptyId swap resumed — subscribing a
  // watcher on the pane we just left and writing its rows over the new one.
  it('does not resurrect an in-flight seed for the OLD pane after a ptyId swap', async () => {
    const h = installBridge({});
    // Hold the first pane's status probe open across the swap.
    let releaseA: (v: TranscriptStatus) => void = () => {};
    h.status.mockImplementationOnce(
      () => new Promise<TranscriptStatus>((resolve) => { releaseA = resolve; }),
    );

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Probe, { ptyId: 'pty-a', enabled: true }));
    });
    // Swap the pane before pty-a's probe answers.
    await act(async () => {
      root.render(React.createElement(Probe, { ptyId: 'pty-b', enabled: true }));
    });
    h.subscribe.mockClear();
    h.snapshot.mockClear();

    await act(async () => {
      releaseA({ available: true, reason: 'ok' });
    });

    // The stale continuation is dead: no watcher for pty-a, no rows for pty-a.
    expect(h.subscribe).not.toHaveBeenCalledWith('pty-a');
    expect(h.snapshot).not.toHaveBeenCalledWith('pty-a');
    expect(useStore.getState().chatStatus['pty-a']).toBeUndefined();
    expect(useStore.getState().chatEvents['pty-a']).toBeUndefined();
    // …and the live pane is unaffected.
    expect(useStore.getState().chatEvents['pty-b'].map((e) => e.id)).toEqual(['u1']);
    await unmount();
  });

  it('survives a rejecting bridge without throwing', async () => {
    const h = installBridge({});
    h.status.mockRejectedValueOnce(new Error('pipe down'));
    await mount('pty-a');
    expect(useStore.getState().chatEvents['pty-a']).toBeUndefined();
    await unmount();
  });
});
