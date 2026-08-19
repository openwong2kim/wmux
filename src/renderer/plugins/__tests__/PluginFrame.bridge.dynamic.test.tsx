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

  // #922 — every plugin request carries the workspace the HOST is showing, on
  // its own channel, so main can tell what this caller IS from what it ASKED
  // for. Read at request time rather than captured at load: the same port must
  // report ws-2 after the user switches, without the bridge being rebuilt
  // (making it an effect dependency is what #928 fixed).
  it('sends the host workspace with each request and follows a switch', async () => {
    act(() => {
      root.render(React.createElement(PluginFrame, {
        pluginName: 'demo',
        entry: 'index.html',
        forwardEvents: false,
      }));
    });

    const iframe = container.querySelector('iframe')!;
    const framePostMessage = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get: () => ({ postMessage: framePostMessage }),
    });

    await act(async () => { iframe.dispatchEvent(new Event('load')); });
    const port = pluginPort(framePostMessage);
    port.start();

    await settledOrTimedOut(request(port, 'before', 'browser.navigate'));
    expect(rpc).toHaveBeenLastCalledWith('demo', 'browser.navigate', {}, 'ws-1');

    await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-2' }); });

    // Same port, no reload, no re-render of the bridge — only the store moved.
    await settledOrTimedOut(request(port, 'after', 'browser.navigate'));
    expect(rpc).toHaveBeenLastCalledWith('demo', 'browser.navigate', {}, 'ws-2');
  });

  // A response belongs to the document that ASKED. The reload window is what
  // makes that observable: an rpc started on the old port resolves after the
  // new one exists, and answering on the current port hands the fresh document
  // a response to an id it never sent.
  //
  // The rpc is held open deliberately — resolving it before the reload would
  // make this pass no matter which port the answer went to.
  it('does not deliver a pre-reload response to the reloaded document', async () => {
    let settleFirst: ((v: unknown) => void) | null = null;
    rpc.mockImplementation(() => new Promise((resolve) => { settleFirst = resolve; }));

    act(() => {
      root.render(React.createElement(PluginFrame, {
        pluginName: 'demo',
        entry: 'index.html',
        forwardEvents: false,
      }));
    });
    const iframe = container.querySelector('iframe')!;
    const framePostMessage = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get: () => ({ postMessage: framePostMessage }),
    });

    await act(async () => { iframe.dispatchEvent(new Event('load')); });
    const firstPort = pluginPort(framePostMessage);
    firstPort.start();

    // Ask on the OLD port. The host's rpc is now pending.
    firstPort.postMessage({ v: PLUGIN_BRIDGE_VERSION, id: 'stale', kind: 'request', method: 'workspace.current' });
    await act(async () => { await Promise.resolve(); });
    expect(settleFirst, 'the host never called rpc for the pre-reload request').not.toBeNull();

    // The frame reloads; the host mints a second port for the new document.
    framePostMessage.mockClear();
    await act(async () => { iframe.dispatchEvent(new Event('load')); });
    const secondPort = pluginPort(framePostMessage);
    const onSecond = vi.fn();
    secondPort.addEventListener('message', onSecond);
    secondPort.start();

    // NOW the old request resolves.
    await act(async () => {
      settleFirst!({ ok: true, result: { id: 'ws-1' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));

    // 양성 통제: 새 포트가 정상 요청에는 응답을 받는가
    rpc.mockImplementation(() => Promise.resolve({ ok: true, result: {} }));
    secondPort.postMessage({ v: PLUGIN_BRIDGE_VERSION, id: 'live', kind: 'request', method: 'workspace.current' });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));
    const allIds = onSecond.mock.calls.map((c) => (c[0] as MessageEvent).data?.id);
    expect(allIds, '새 포트가 아무것도 못 받음 — 리스너 배선 문제').toContain('live');
    const idsSeen = allIds;
    expect(
      idsSeen,
      'the reloaded document was handed a response to an id it never sent',
    ).not.toContain('stale');
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

      expect(rpc).toHaveBeenCalledWith('demo', 'events.poll', { workspaceId: 'ws-1' }, 'ws-1');

      await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-2' }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

      expect(rpc).toHaveBeenCalledWith('demo', 'events.poll', { workspaceId: 'ws-2' }, 'ws-2');
      // ...and never keeps polling the workspace the user left.
      const pollsAfterSwitch = rpc.mock.calls
        .slice(rpc.mock.calls.findIndex((c) => c[2]?.workspaceId === 'ws-2'))
        .filter((c) => c[1] === 'events.poll');
      expect(pollsAfterSwitch.every((c) => c[2]?.workspaceId === 'ws-2')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // `bridgeEpoch === 0` is the poll's "there is nowhere to deliver" gate. It
  // has to go back to 0 when the bridge is torn down, or the gate only works
  // once: swapping the plugin nulls the port but leaves the epoch high, and
  // the loop spends the window before the new `load` polling into nothing —
  // events fetched from the ring and dropped, with no way to notice.
  it('stops polling between a plugin swap and the new frame load', async () => {
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
      expect(rpc).toHaveBeenCalledWith('demo', 'events.poll', { workspaceId: 'ws-1' }, 'ws-1');

      // Swap the plugin: the bridge effect tears down and the new frame has
      // not loaded yet, so there is no port.
      rpc.mockClear();
      act(() => {
        root.render(React.createElement(PluginFrame, {
          pluginName: 'other',
          entry: 'index.html',
          forwardEvents: true,
        }));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

      const polls = rpc.mock.calls.filter((c) => c[1] === 'events.poll');
      expect(
        polls,
        'polled while no port existed — the events it fetched went nowhere',
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
