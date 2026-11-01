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
import { deliberateSleep } from '../../../test-utils/waitFor';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let rpc: ReturnType<typeof vi.fn>;
let frameReady: ReturnType<typeof vi.fn>;
let notifyNavigation: (name: string) => void;

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
  frameReady = vi.fn(async (_plugin, frameName, nonce) => {
    const iframe = container.querySelector('iframe')!;
    expect(iframe.name).toBe(frameName);
    const source = iframe.contentWindow;
    const channel = new MessageChannel();
    // Simulate main's document-local bootstrap; this is not a host transfer.
    source!.postMessage({ v: 1, kind: 'init' }, '*', [channel.port2]);
    window.dispatchEvent(new MessageEvent('message', { source, data: { kind: 'wmux-plugin-bridge', nonce }, ports: [channel.port1] }));
    return true;
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = { plugins: {
    rpc, frameReady, onFrameNavigation: (fn: (name: string) => void) => { notifyNavigation = fn; return () => { /* test subscription cleanup */ }; },
  } };
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
      value: { postMessage: framePostMessage },
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
      value: { postMessage: framePostMessage },
    });

    await act(async () => { iframe.dispatchEvent(new Event('load')); });
    const port = pluginPort(framePostMessage);
    port.start();

    await settledOrTimedOut(request(port, 'before', 'browser.navigate'));
    expect(rpc).toHaveBeenLastCalledWith('demo', 'browser.navigate', {}, 'ws-1', false);

    await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-2' }); });

    // Same port, no reload, no re-render of the bridge — only the store moved.
    await settledOrTimedOut(request(port, 'after', 'browser.navigate'));
    expect(rpc).toHaveBeenLastCalledWith('demo', 'browser.navigate', {}, 'ws-2', false);
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
      value: { postMessage: framePostMessage },
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
    await deliberateSleep(20, 'negative: the stale port delivers nothing');

    // 양성 통제: 새 포트가 정상 요청에는 응답을 받는가
    rpc.mockImplementation(() => Promise.resolve({ ok: true, result: {} }));
    secondPort.postMessage({ v: PLUGIN_BRIDGE_VERSION, id: 'live', kind: 'request', method: 'workspace.current' });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(onSecond.mock.calls.map((c) => (c[0] as MessageEvent).data?.id)).toContain('live'), { timeout: 5_000 });
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
        value: { postMessage: vi.fn() },
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

  // A retired bridge must stop polling until the next document offers a port.
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
        value: { postMessage: vi.fn() },
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


it('refuses an explicit agent-state response after switching away and back', async () => {
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  rpc.mockImplementation(() => new Promise((resolve) => { release = resolve; entered(); }));
  act(() => root.render(<PluginFrame pluginName="demo" entry="index.html" />));
  const frame = container.querySelector('iframe')!;
  const post = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  const port = pluginPort(post); port.start();
  const response = request(port, 'slow', 'agent.state');
  await started;
  act(() => { useStore.setState({ activeWorkspaceId: 'ws-2' }); useStore.setState({ activeWorkspaceId: 'ws-1' }); });
  release({ ok: true, result: { activity: 'private old workspace' } });
  expect(await settledOrTimedOut(response)).toMatchObject({ error: { code: 'scope-changed' } });
});


it('does not navigate for a focus response from an earlier workspace epoch', async () => {
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  rpc.mockImplementation(() => new Promise((resolve) => { release = resolve; entered(); }));
  useStore.setState({ appRoute: 'plugin:demo' });
  act(() => root.render(<PluginFrame pluginName="demo" entry="index.html" railPage />));
  const frame = container.querySelector('iframe')!;
  const post = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  const port = pluginPort(post); port.start();
  const response = request(port, 'focus-slow', 'pane.focus');
  await started;
  act(() => { useStore.setState({ activeWorkspaceId: 'ws-2' }); useStore.setState({ activeWorkspaceId: 'ws-1' }); });
  release({ ok: true, result: { ok: true } });
  await settledOrTimedOut(response);
  expect(useStore.getState().appRoute).toBe('plugin:demo');
});

it('forwards the retryable startup flag on an explicit read failure', async () => {
  rpc.mockResolvedValue({ ok: false, error: 'Still starting', retryable: true });
  act(() => root.render(React.createElement(PluginFrame, { pluginName: 'demo', entry: 'index.html' })));
  const iframe = container.querySelector('iframe')!;
  const framePostMessage = vi.fn();
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: { postMessage: framePostMessage } });
  await act(async () => { iframe.dispatchEvent(new Event('load')); });
  const port = pluginPort(framePostMessage);
  port.start();
  expect(await settledOrTimedOut(request(port, 'retry', 'agent.state'))).toMatchObject({
    kind: 'response', error: { code: 'rpc-rejected', message: 'Still starting', retryable: true },
  });
  port.close();
});

it('does not transfer a bridge when the committed document is refused', async () => {
  frameReady.mockResolvedValue(false);
  await act(async () => root.render(React.createElement(PluginFrame, { pluginName: 'demo', entry: 'index.html' })));
  const frame = container.querySelector('iframe')!;
  const post = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  expect(frameReady).toHaveBeenCalledWith('demo', frame.name, expect.any(String));
  expect(post).not.toHaveBeenCalled();
  expect(container.querySelector('iframe')).toBeNull();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

it('drops a pending handshake when navigation starts', async () => {
  let finish!: (ready: boolean) => void;
  frameReady.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await act(async () => root.render(React.createElement(PluginFrame, { pluginName: 'demo', entry: 'index.html' })));
  const frame = container.querySelector('iframe')!;
  const post = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  await act(async () => { notifyNavigation(frame.name); finish(true); });
  expect(post).not.toHaveBeenCalled();
});

it('closes the active bridge on document navigation', async () => {
  await act(async () => root.render(React.createElement(PluginFrame, { pluginName: 'demo', entry: 'index.html' })));
  const frame = container.querySelector('iframe')!;
  const post = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  const port = pluginPort(post);
  await act(async () => { notifyNavigation(frame.name); });
  expect(await settledOrTimedOut(request(port, 'after-navigation', 'workspace.current'))).toBe('no-reply');
  expect(rpc).not.toHaveBeenCalled();
  port.close();
});

it('restarts agent-state streaming after a batched reload handshake', async () => {
  useStore.setState({ appRoute: 'plugin:demo' });
  rpc.mockResolvedValue({ ok: true, result: { workspaceId: 'ws-1', panes: [], truncated: false } });
  await act(async () => root.render(<PluginFrame pluginName="demo" entry="index.html" railPage agentStateEvents />));
  const frame = container.querySelector('iframe')!;
  const post = vi.fn();
  const received: Array<Array<{ kind?: string; status?: string }>> = [];
  post.mockImplementation((_message, _origin, ports: MessagePort[]) => {
    const events: Array<{ kind?: string; status?: string }> = [];
    received.push(events);
    ports[0].onmessage = (event) => events.push(event.data);
    ports[0].start();
  });
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  await vi.waitFor(() => expect(received[0]).toContainEqual(expect.objectContaining({ kind: 'agent-state', status: 'ready' })), { timeout: 5000 });
  rpc.mockClear();
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  await vi.waitFor(() => expect(received[1]).toContainEqual(expect.objectContaining({ kind: 'agent-state', status: 'ready' })), { timeout: 5000 });
  expect(rpc).toHaveBeenCalledWith('demo', 'agent.state', {}, 'ws-1');
  for (const call of post.mock.calls) (call[2] as MessagePort[])[0].close();
});

it('streams every workspace to an all-workspaces page without restarting on a switch', async () => {
  useStore.setState({ appRoute: 'plugin:demo' });
  const all = { truncated: false, workspaces: [{ workspaceId: 'ws-1', name: 'one', truncated: false, panes: [] }] };
  rpc.mockResolvedValue({ ok: true, result: all });
  await act(async () => root.render(<PluginFrame pluginName="demo" entry="index.html" railPage agentStateEvents agentStateScope="all" />));
  const frame = container.querySelector('iframe')!;
  const events: Array<{ kind?: string; status?: string; workspaceId?: string; epoch?: string; allWorkspaces?: unknown; snapshot?: unknown }> = [];
  const post = vi.fn((_message, _origin, ports: MessagePort[]) => {
    ports[0].onmessage = (event) => events.push(event.data);
    ports[0].start();
  });
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ status: 'ready', workspaceId: 'ws-1', allWorkspaces: all })), { timeout: 5000 });
  expect(rpc).toHaveBeenCalledWith('demo', 'agent.state.all', {}, 'ws-1');
  expect(rpc).not.toHaveBeenCalledWith('demo', 'agent.state', expect.anything(), expect.anything());
  expect(events.some((e) => 'snapshot' in e)).toBe(false);
  const epoch = events.find((e) => e.status === 'ready')!.epoch;
  await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-2' }); });
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ status: 'ready', workspaceId: 'ws-2', epoch })), { timeout: 5000 });
  // One stream: the switch did not reset it, and later reads carry the new binding.
  expect(events.filter((e) => e.status === 'reset')).toHaveLength(1);
  expect(rpc).toHaveBeenCalledWith('demo', 'agent.state.all', {}, 'ws-2');
  for (const call of post.mock.calls) (call[2] as MessagePort[])[0].close();
});

it('returns to Workspaces after an all-workspaces page focused a pane in another workspace', async () => {
  const leaf = (id: string) => ({ id, type: 'leaf' as const, surfaces: [], activeSurfaceId: '' });
  useStore.setState({ appRoute: 'plugin:demo', workspaces: [
    { id: 'ws-1', name: 'one', rootPane: leaf('p1'), activePaneId: 'p1' },
    { id: 'ws-2', name: 'two', rootPane: leaf('p2'), activePaneId: 'p2' },
  ] as never });
  // The host's answer to the focus: it switched to the pane's workspace.
  rpc.mockImplementation(async (_plugin: string, method: string) => {
    if (method === 'pane.focus') { useStore.setState({ activeWorkspaceId: 'ws-2' }); return { ok: true, result: { ok: true } }; }
    return { ok: true, result: { truncated: false, workspaces: [] } };
  });
  act(() => root.render(<PluginFrame pluginName="demo" entry="index.html" railPage agentStateScope="all" />));
  const frame = container.querySelector('iframe')!;
  const post = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  const port = pluginPort(post); port.start();
  const answered = new Promise((resolve) => { port.onmessage = (e) => { if (e.data?.id === 'jump') resolve(e.data); }; });
  port.postMessage({ v: PLUGIN_BRIDGE_VERSION, id: 'jump', kind: 'request', method: 'pane.focus', params: { id: 'p2' } });
  await act(async () => { await answered; });
  expect(useStore.getState().appRoute).toBe('workspaces');
  port.close();
});

it('stays on the page when a single-workspace page\'s focus raced a workspace switch', async () => {
  const leaf = (id: string) => ({ id, type: 'leaf' as const, surfaces: [], activeSurfaceId: '' });
  useStore.setState({ appRoute: 'plugin:demo', workspaces: [
    { id: 'ws-1', name: 'one', rootPane: leaf('p1'), activePaneId: 'p1' },
    { id: 'ws-2', name: 'two', rootPane: leaf('p2'), activePaneId: 'p2' },
  ] as never });
  rpc.mockImplementation(async () => { useStore.setState({ activeWorkspaceId: 'ws-2' }); return { ok: true, result: { ok: true } }; });
  act(() => root.render(<PluginFrame pluginName="demo" entry="index.html" railPage />));
  const frame = container.querySelector('iframe')!;
  const post = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  const port = pluginPort(post); port.start();
  const answered = new Promise((resolve) => { port.onmessage = (e) => { if (e.data?.id === 'jump') resolve(e.data); }; });
  port.postMessage({ v: PLUGIN_BRIDGE_VERSION, id: 'jump', kind: 'request', method: 'pane.focus', params: { id: 'p2' } });
  await act(async () => { await answered; });
  expect(useStore.getState().appRoute).toBe('plugin:demo');
  port.close();
});

// The host says which kind of frame asked, from the frame it mounted: only a
// rail page may be widened to another workspace by main (pane.focus).
it.each([
  ['a rail page', true],
  ['a sidebar panel or status-bar widget', false],
])('marks requests from %s accordingly', async (_kind, railPage) => {
  act(() => root.render(<PluginFrame pluginName="demo" entry="index.html" railPage={railPage} />));
  const frame = container.querySelector('iframe')!;
  const post = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
  await act(async () => { frame.dispatchEvent(new Event('load')); });
  const port = pluginPort(post); port.start();
  await settledOrTimedOut(request(port, 'focus', 'pane.focus'));
  expect(rpc).toHaveBeenLastCalledWith('demo', 'pane.focus', {}, 'ws-1', railPage);
  port.close();
});

it('forwards theme tokens after connection and when the root theme changes', async () => {
  document.documentElement.style.setProperty('--bg-base', '#ffffff');
  try {
    await act(async () => { root.render(React.createElement(PluginFrame, { pluginName: 'commander', entry: 'index.html' })); });
    const frame = container.querySelector('iframe');
    if (!frame) throw new Error('Missing frame');
    const post = vi.fn();
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: post } });
    await act(async () => { frame.dispatchEvent(new Event('load')); });
    const port = pluginPort(post);
    const themes: { kind: string; variables: Record<string, string>; colorScheme: string }[] = [];
    port.addEventListener('message', (e: MessageEvent) => { if (e.data?.kind === 'theme') themes.push(e.data); });
    port.start();
    await vi.waitFor(() => expect(themes.at(-1)).toMatchObject({ colorScheme: 'light', variables: { '--bg-base': '#ffffff' } }), { timeout: 5_000 });
    await act(async () => { document.documentElement.style.setProperty('--bg-base', '#000000'); });
    await vi.waitFor(() => expect(themes.at(-1)).toMatchObject({ colorScheme: 'dark', variables: { '--bg-base': '#000000' } }), { timeout: 5_000 });
    port.close();
  } finally { document.documentElement.style.removeProperty('--bg-base'); }
});
