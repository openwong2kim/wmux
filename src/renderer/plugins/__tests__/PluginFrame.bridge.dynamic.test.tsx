// @vitest-environment jsdom
//
// PluginFrame — the postMessage bridge must outlive a workspace switch.
//
// The bridge port is created exactly once, inside the iframe's `load` handler.
// #719 added `activeWorkspaceId` to the bridge effect's dependency list so the
// events.poll loop re-subscribes when the user switches workspace. That is the
// right behaviour for the poll, but the effect's cleanup also closes the
// MessagePort and unregisters the palette-command frame — and `load` does not
// fire a second time for an iframe whose `src` never changed. So after the
// first workspace switch the plugin holds a port whose peer is closed: every
// request it posts is dropped, and the promise it is waiting on never settles.
//
// This mounts the REAL <PluginFrame/> via react-dom/client so its effects run,
// captures the transferred port from the `contentWindow.postMessage` call
// (jsdom does not deliver a transfer list to a cross-document frame, and the
// spy is the load-bearing observation either way), and drives a request across
// it before and after the switch. It affects every mounted plugin, not only the
// ones that poll events: `forwardEvents` is false here and the teardown still
// happens.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PluginFrame from '../PluginFrame';
import { useStore } from '../../stores';
import { PLUGIN_BRIDGE_VERSION } from '../../../shared/pluginHost';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let rpc: ReturnType<typeof vi.fn>;

/** The port the host transferred to the frame, i.e. the plugin's own end. */
function pluginPort(postMessage: ReturnType<typeof vi.fn>): MessagePort {
  const init = postMessage.mock.calls.find((c) => (c[0] as { kind?: string })?.kind === 'init');
  expect(init, 'host never posted the init envelope').toBeDefined();
  const transferred = (init![2] as MessagePort[])[0];
  expect(transferred, 'init envelope carried no MessagePort').toBeDefined();
  return transferred;
}

/** Post a request from the plugin side and resolve with the host's reply. */
function request(port: MessagePort, id: string, method: string): Promise<unknown> {
  return new Promise((resolve) => {
    port.addEventListener('message', function onMessage(e: MessageEvent) {
      const msg = e.data as { id?: string; kind?: string };
      if (msg?.kind === 'response' && msg.id === id) {
        port.removeEventListener('message', onMessage);
        resolve(msg);
      }
    });
    port.postMessage({ v: PLUGIN_BRIDGE_VERSION, id, kind: 'request', method, params: {} });
  });
}

/** Resolve once the port's peer has had a chance to answer, answered or not. */
function settledOrTimedOut(p: Promise<unknown>, ms = 50): Promise<unknown | 'no-reply'> {
  return Promise.race([p, new Promise((r) => setTimeout(() => r('no-reply'), ms))]);
}

beforeEach(() => {
  rpc = vi.fn(async () => ({ ok: true, result: { id: 'ws-1' } }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { plugins: { rpc } };
  useStore.setState({ activeWorkspaceId: 'ws-1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

describe('PluginFrame — bridge lifetime across a workspace switch', () => {
  it('keeps answering plugin requests after the active workspace changes', async () => {
    act(() => {
      root.render(React.createElement(PluginFrame, {
        pluginName: 'demo',
        entry: 'index.html',
        forwardEvents: false,
      }));
    });

    const iframe = container.querySelector('iframe');
    expect(iframe, 'PluginFrame rendered no iframe').not.toBeNull();

    // Stand in for the frame's window: jsdom will not load a wmux-plugin:// URL,
    // and the transfer list is what we need to observe anyway.
    const framePostMessage = vi.fn();
    Object.defineProperty(iframe!, 'contentWindow', {
      configurable: true,
      get: () => ({ postMessage: framePostMessage }),
    });

    await act(async () => { iframe!.dispatchEvent(new Event('load')); });

    const port = pluginPort(framePostMessage);
    port.start();

    // Baseline: the bridge answers before any workspace switch.
    expect(await settledOrTimedOut(request(port, 'before', 'workspace.current')))
      .toMatchObject({ kind: 'response', id: 'before' });

    // The user switches workspace. Nothing about the plugin changed.
    await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-2' }); });

    expect(await settledOrTimedOut(request(port, 'after', 'workspace.current')))
      .toMatchObject({ kind: 'response', id: 'after' });
  });

  // The reason #719 put activeWorkspaceId on the effect in the first place. It
  // has to keep holding once the bridge stops depending on the workspace,
  // otherwise the poll would keep reading the workspace that was active at
  // mount after the user switched away.
  it('re-scopes the events.poll loop to the workspace the user switched to', async () => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(PluginFrame, {
          pluginName: 'demo',
          entry: 'index.html',
          forwardEvents: true,
        }));
      });

      const iframe = container.querySelector('iframe')!;
      Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        get: () => ({ postMessage: vi.fn() }),
      });
      rpc.mockResolvedValue({ ok: true, result: { events: [], nextCursor: 7 } });

      await act(async () => { iframe.dispatchEvent(new Event('load')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

      expect(rpc).toHaveBeenCalledWith('demo', 'events.poll', { workspaceId: 'ws-1' });

      await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-2' }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

      expect(rpc).toHaveBeenCalledWith('demo', 'events.poll', { workspaceId: 'ws-2' });
      // ...and never keeps polling the workspace the user left.
      const pollsAfterSwitch = rpc.mock.calls
        .slice(rpc.mock.calls.findIndex((c) => c[2]?.workspaceId === 'ws-2'))
        .filter((c) => c[1] === 'events.poll');
      expect(pollsAfterSwitch.every((c) => c[2]?.workspaceId === 'ws-2')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
