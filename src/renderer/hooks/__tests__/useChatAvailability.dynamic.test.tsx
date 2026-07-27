// @vitest-environment jsdom
//
// The probe that lets Chat View be ENTERED at all.
//
// Regression: the probe key froze on `pending:${agentStatus}`, so a pane whose
// transcript path was minted in the SAME tick its agent status settled never
// re-asked — the daemon reported `{available: true}` and the Terminal|Chat
// toggle stayed disabled until some LATER status change. Observed live as 2–3
// wasted operator turns. Nothing here hand-injects `chatStatus`: the store is
// filled only by the hook's own probes, exactly as in the app.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useChatAvailability, AVAILABILITY_RETRY_MS } from '../useChatAvailability';
import { useStore } from '../../stores';
import type { TranscriptStatus } from '../../../shared/transcript/turnEvents';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PTY = 'pty-probe';

let container: HTMLDivElement;
let root: Root;

/** The exact predicate the Terminal|Chat toggle disables itself on. */
const toggleEnabled = (): boolean => !!useStore.getState().chatStatus[PTY]?.available;

function Probe(): null {
  useChatAvailability(PTY);
  return null;
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe));
  });
}

async function unmount(): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}

/** Let the probe's promise chain settle inside the fake-timer world. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function installBridge(status: () => Promise<TranscriptStatus>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(status);
  (window as unknown as { electronAPI: unknown }).electronAPI = { chat: { status: fn } };
  return fn;
}

describe('useChatAvailability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.getState().clearChatSurface(PTY);
  });

  afterEach(() => {
    vi.useRealTimers();
    useStore.getState().clearChatSurface(PTY);
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.restoreAllMocks();
  });

  it('converges on availability WITHOUT another agent-status change', async () => {
    // The daemon flips to available right after the first probe — the same tick
    // the status settled, which is precisely the case the frozen key missed.
    let available = false;
    const status = installBridge(async () =>
      available
        ? { available: true, reason: 'ok', transcriptBasename: '920b9112.jsonl' }
        : { available: false, reason: 'no-transcript-path' },
    );

    await mount();
    expect(status).toHaveBeenCalledTimes(1);
    expect(toggleEnabled()).toBe(false);

    available = true; // …and nothing in the renderer observes this moment.
    await tick(AVAILABILITY_RETRY_MS);

    expect(toggleEnabled()).toBe(true);
    await unmount();
  });

  it('stops re-probing once the answer is positive', async () => {
    const status = installBridge(async () => ({ available: true, reason: 'ok' }));
    await mount();
    expect(toggleEnabled()).toBe(true);
    const calls = status.mock.calls.length;
    await tick(AVAILABILITY_RETRY_MS * 5);
    expect(status.mock.calls.length).toBe(calls);
    await unmount();
  });

  it('does not re-probe an agent that publishes no transcript at all', async () => {
    // 'not-claude' is a property of the agent, not a race: re-asking it every
    // couple of seconds would be pure IPC noise.
    const status = installBridge(async () => ({ available: false, reason: 'not-claude' }));
    await mount();
    const calls = status.mock.calls.length;
    await tick(AVAILABILITY_RETRY_MS * 5);
    expect(status.mock.calls.length).toBe(calls);
    await unmount();
  });

  it('stops probing after unmount', async () => {
    const status = installBridge(async () => ({ available: false, reason: 'no-transcript-path' }));
    await mount();
    await unmount();
    const calls = status.mock.calls.length;
    await tick(AVAILABILITY_RETRY_MS * 3);
    expect(status.mock.calls.length).toBe(calls);
  });
});
