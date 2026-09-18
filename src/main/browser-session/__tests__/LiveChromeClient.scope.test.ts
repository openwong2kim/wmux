import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveChromeClient } from '../LiveChromeClient';

// Live-Chrome agent window: ownership is exact, borrows are session-scoped, and
// window grouping is best-effort in the one direction that matters — a grouping
// miss must never change who may write to a tab.

type Listener = (ev: { data?: string }) => void;

interface SentFrame {
  method: string;
  params: Record<string, unknown>;
}

/**
 * A WebSocket that answers CDP requests from a per-test responder, so a test can
 * describe what Chrome does (including "I put that tab in a different window")
 * instead of hand-replying to every frame in order.
 */
class ScriptedWebSocket {
  static OPEN = 1;
  static instances: ScriptedWebSocket[] = [];
  static sent: SentFrame[] = [];
  /** Throwing makes the request fail, which is how Chrome refuses a parameter. */
  static respond: (method: string, params: Record<string, unknown>) => unknown = () => ({});

  readyState = 0;
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    ScriptedWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = ScriptedWebSocket.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  emit(type: string, ev: { data?: string }): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> };
    ScriptedWebSocket.sent.push({ method: frame.method, params: frame.params });
    let result: unknown;
    try {
      result = ScriptedWebSocket.respond(frame.method, frame.params);
    } catch (err) {
      queueMicrotask(() =>
        this.emit('message', {
          data: JSON.stringify({ id: frame.id, error: { message: String(err) } }),
        }),
      );
      return;
    }
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: frame.id, result }) }));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
}

const methodsSent = (): string[] => ScriptedWebSocket.sent.map((f) => f.method);

function writeScopeOf(client: LiveChromeClient) {
  const scope = client.writeScope;
  // The property IS the live marker browser.rpc feature-detects, so its absence
  // would be the bug rather than a missing test fixture.
  expect(scope).toBeDefined();
  return scope;
}

describe('LiveChromeClient write scope (agent window)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-live-scope-'));
    writeFileSync(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/abc\n');
    ScriptedWebSocket.instances = [];
    ScriptedWebSocket.sent = [];
    ScriptedWebSocket.respond = () => ({});
    vi.stubGlobal('WebSocket', ScriptedWebSocket);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  /** Chrome that opens tabs t1, t2, … and reports one window for all of them. */
  function respondWithWindow(windowId: number, ids = ['t1', 't2', 't3']): void {
    let next = 0;
    ScriptedWebSocket.respond = (method) => {
      if (method === 'Target.createTarget') return { targetId: ids[next++] ?? `extra-${next}` };
      if (method === 'Browser.getWindowForTarget') return { windowId };
      return {};
    };
  }

  it('ownership is exact: a tab opened for one workspace is a user tab to another', async () => {
    respondWithWindow(7);
    const client = new LiveChromeClient(dir);
    const scope = writeScopeOf(client);

    const opened = await client.openTab('https://a.test/', 'ws-a');
    expect(scope.ownerOf(opened.targetId, 'ws-a')).toBe('agent');
    // The same tab, asked about by the OTHER workspace. Answering 'agent' here
    // would make one agent's window writable by every other workspace.
    expect(scope.ownerOf(opened.targetId, 'ws-b')).toBe('user');
    // A tab nothing in wmux opened — the user's own.
    expect(scope.ownerOf('user-tab', 'ws-a')).toBe('user');
    // hasSurface stays true for every id: addressable (readable) is not writable.
    expect(client.hasSurface('user-tab')).toBe(true);
  });

  it('borrow lifecycle: pending once, granted, returned, and refused a second time', async () => {
    respondWithWindow(7);
    const client = new LiveChromeClient(dir);
    const scope = writeScopeOf(client);

    expect(scope.beginBorrow('user-tab', 'ws-a')).toBe(true);
    // A second request for the SAME tab must not stack another prompt on the
    // user, whoever asks.
    expect(scope.beginBorrow('user-tab', 'ws-a')).toBe(false);
    expect(scope.beginBorrow('user-tab', 'ws-b')).toBe(false);
    // Still not writable while the question is open.
    expect(scope.ownerOf('user-tab', 'ws-a')).toBe('user');

    scope.settleBorrow('user-tab', 'ws-a', true);
    expect(scope.ownerOf('user-tab', 'ws-a')).toBe('borrowed');
    // Lent to ws-a, not to the machine.
    expect(scope.ownerOf('user-tab', 'ws-b')).toBe('user');
    // The slot is free again, so a later request is possible at all.
    expect(scope.beginBorrow('other-tab', 'ws-a')).toBe(true);

    expect(scope.returnBorrow('user-tab', 'ws-a')).toBe(true);
    expect(scope.ownerOf('user-tab', 'ws-a')).toBe('user');
    // Returning what you do not hold is not an error, it is already true.
    expect(scope.returnBorrow('user-tab', 'ws-a')).toBe(false);
  });

  it('a denied borrow grants nothing and releases the prompt slot', async () => {
    respondWithWindow(7);
    const client = new LiveChromeClient(dir);
    const scope = writeScopeOf(client);

    expect(scope.beginBorrow('user-tab', 'ws-a')).toBe(true);
    scope.settleBorrow('user-tab', 'ws-a', false);
    expect(scope.ownerOf('user-tab', 'ws-a')).toBe('user');
    // Asking again is allowed — a "no" now is not a "no" forever.
    expect(scope.beginBorrow('user-tab', 'ws-a')).toBe(true);
  });

  it('clearBorrows(workspaceId) drops only that workspace grants', async () => {
    respondWithWindow(7);
    const client = new LiveChromeClient(dir);
    const scope = writeScopeOf(client);

    scope.beginBorrow('tab-a', 'ws-a');
    scope.settleBorrow('tab-a', 'ws-a', true);
    scope.beginBorrow('tab-b', 'ws-b');
    scope.settleBorrow('tab-b', 'ws-b', true);

    scope.clearBorrows('ws-a');
    expect(scope.ownerOf('tab-a', 'ws-a')).toBe('user');
    expect(scope.ownerOf('tab-b', 'ws-b')).toBe('borrowed');
  });

  it('dispose clears every borrow and closes NO tab', async () => {
    respondWithWindow(7);
    const client = new LiveChromeClient(dir);
    const scope = writeScopeOf(client);
    await client.openTab('https://a.test/', 'ws-a');
    scope.beginBorrow('user-tab', 'ws-a');
    scope.settleBorrow('user-tab', 'ws-a', true);
    expect(scope.ownerOf('user-tab', 'ws-a')).toBe('borrowed');

    client.dispose();

    expect(scope.ownerOf('user-tab', 'ws-a')).toBe('user');
    // The whole point of live mode: wmux never closes the user's tabs, and an
    // agent-owned live tab is a window on their desktop too.
    expect(methodsSent()).not.toContain('Target.closeTarget');
  });

  it('a Chrome disconnect clears every borrow (the tab is gone with the window)', async () => {
    respondWithWindow(7);
    const client = new LiveChromeClient(dir);
    const scope = writeScopeOf(client);
    await client.openTab('https://a.test/', 'ws-a');
    scope.beginBorrow('user-tab', 'ws-a');
    scope.settleBorrow('user-tab', 'ws-a', true);

    // Chrome quit: the socket closes on its own, nobody called dispose().
    ScriptedWebSocket.instances[0].close();

    expect(scope.ownerOf('user-tab', 'ws-a')).toBe('user');
  });

  it('a Chrome RESTART (endpoint moved) clears every borrow too', async () => {
    respondWithWindow(7);
    const client = new LiveChromeClient(dir);
    const scope = writeScopeOf(client);
    await client.openTab('https://a.test/', 'ws-a');
    scope.beginBorrow('user-tab', 'ws-a');
    scope.settleBorrow('user-tab', 'ws-a', true);

    // Chrome restarted: the DevToolsActivePort file now names a different secret
    // path, so the next send replaces the socket rather than reusing it. This
    // path tears the old socket down from the inside (detach), where the socket's
    // own close listener no longer applies — the grants must still go.
    writeFileSync(join(dir, 'DevToolsActivePort'), '9444\n/devtools/browser/def\n');
    await client.listTargets();

    expect(scope.ownerOf('user-tab', 'ws-a')).toBe('user');
    expect(ScriptedWebSocket.instances).toHaveLength(2);
  });

  it('closing an agent tab drops its ownership and any grant on that id', async () => {
    respondWithWindow(7);
    const client = new LiveChromeClient(dir);
    const scope = writeScopeOf(client);
    const opened = await client.openTab('https://a.test/', 'ws-a');

    expect(await client.closeSurface(opened.targetId)).toBe(true);
    // Chrome reuses target ids; a stale grant would follow the id to a new tab.
    expect(scope.ownerOf(opened.targetId, 'ws-a')).toBe('user');
  });

  describe('window grouping (best-effort)', () => {
    it('the first tab asks for a new window and the window is recorded', async () => {
      respondWithWindow(7);
      const client = new LiveChromeClient(dir);
      const scope = writeScopeOf(client);

      await client.openTab('https://a.test/', 'ws-a');

      const create = ScriptedWebSocket.sent.find((f) => f.method === 'Target.createTarget');
      expect(create?.params).toMatchObject({ url: 'https://a.test/', newWindow: true });
      expect(methodsSent()).toContain('Browser.getWindowForTarget');
      expect(scope.agentWindowFor('ws-a')).toBe(7);
    });

    it('later tabs activate one of the workspace own tabs first, without newWindow', async () => {
      respondWithWindow(7);
      const client = new LiveChromeClient(dir);
      const first = await client.openTab('https://a.test/', 'ws-a');
      ScriptedWebSocket.sent = [];

      await client.openTab('https://b.test/', 'ws-a');

      expect(methodsSent()).toEqual([
        'Target.activateTarget',
        'Target.createTarget',
        'Browser.getWindowForTarget',
      ]);
      expect(ScriptedWebSocket.sent[0].params).toEqual({ targetId: first.targetId });
      // No newWindow on a later tab: activating our own tab is what asks Chrome
      // to put this one beside it.
      expect(ScriptedWebSocket.sent[1].params).toEqual({ url: 'https://b.test/' });
    });

    it('a tab Chrome puts in ANOTHER window is still fully agent-owned', async () => {
      // Chrome honours neither the activation nor the grouping: the second tab
      // lands in window 9. There is no CDP command to move it back, so the
      // recorded window follows reality — and ownership does not move at all.
      let next = 0;
      const ids = ['t1', 't2'];
      ScriptedWebSocket.respond = (method, params) => {
        if (method === 'Target.createTarget') return { targetId: ids[next++] };
        if (method === 'Browser.getWindowForTarget') {
          return { windowId: params['targetId'] === 't1' ? 7 : 9 };
        }
        return {};
      };
      const client = new LiveChromeClient(dir);
      const scope = writeScopeOf(client);

      const a = await client.openTab('https://a.test/', 'ws-a');
      const b = await client.openTab('https://b.test/', 'ws-a');

      expect(scope.agentWindowFor('ws-a')).toBe(9);
      expect(scope.ownerOf(a.targetId, 'ws-a')).toBe('agent');
      expect(scope.ownerOf(b.targetId, 'ws-a')).toBe('agent');
      // …and the stray window buys no-one else write access to either tab.
      expect(scope.ownerOf(b.targetId, 'ws-b')).toBe('user');
    });

    it('a Chrome that refuses newWindow still gets the tab open', async () => {
      ScriptedWebSocket.respond = (method, params) => {
        if (method === 'Target.createTarget') {
          if (params['newWindow'] === true) throw new Error('Invalid parameters');
          return { targetId: 't1' };
        }
        if (method === 'Browser.getWindowForTarget') return { windowId: 3 };
        return {};
      };
      const client = new LiveChromeClient(dir);

      const opened = await client.openTab('https://a.test/', 'ws-a');

      expect(opened.targetId).toBe('t1');
      expect(writeScopeOf(client).ownerOf('t1', 'ws-a')).toBe('agent');
    });

    it('a Chrome that will not answer getWindowForTarget still gets the tab open', async () => {
      ScriptedWebSocket.respond = (method) => {
        if (method === 'Target.createTarget') return { targetId: 't1' };
        if (method === 'Browser.getWindowForTarget') throw new Error('not supported');
        return {};
      };
      const client = new LiveChromeClient(dir);

      const opened = await client.openTab('https://a.test/', 'ws-a');

      expect(opened.targetId).toBe('t1');
      expect(writeScopeOf(client).agentWindowFor('ws-a')).toBeUndefined();
      expect(writeScopeOf(client).ownerOf('t1', 'ws-a')).toBe('agent');
    });
  });

  describe('cdpInfoTargets owner labels', () => {
    it('seeds the workspace own tabs and its lent ones, each labelled', async () => {
      let next = 0;
      const ids = ['t1'];
      ScriptedWebSocket.respond = (method) => {
        if (method === 'Target.createTarget') return { targetId: ids[next++] };
        if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              { targetId: 't1', type: 'page', title: 'Agent', url: 'https://a.test/' },
              { targetId: 'lent', type: 'page', title: 'Lent', url: 'https://lent.test/' },
              { targetId: 'theirs', type: 'page', title: 'Theirs', url: 'https://theirs.test/' },
            ],
          };
        }
        return {};
      };
      const client = new LiveChromeClient(dir);
      const scope = writeScopeOf(client);
      await client.openTab('https://a.test/', 'ws-a');
      scope.beginBorrow('lent', 'ws-a');
      scope.settleBorrow('lent', 'ws-a', true);

      expect(await client.cdpInfoTargets('ws-a')).toEqual([
        {
          surfaceId: 't1',
          targetId: 't1',
          workspaceId: 'ws-a',
          url: 'https://a.test/',
          title: 'Agent',
          owner: 'agent',
        },
        {
          surfaceId: 'lent',
          targetId: 'lent',
          workspaceId: 'ws-a',
          url: 'https://lent.test/',
          title: 'Lent',
          owner: 'borrowed',
        },
      ]);
      // The user's third tab is never seeded: it can be listed and read, but it
      // must never become a write target or a default pin.
      expect(await client.cdpInfoTargets('ws-b')).toEqual([]);
    });

    it('a lent tab that has since closed is pruned rather than reported', async () => {
      ScriptedWebSocket.respond = (method) => {
        if (method === 'Target.getTargets') return { targetInfos: [] };
        return {};
      };
      const client = new LiveChromeClient(dir);
      const scope = writeScopeOf(client);
      scope.beginBorrow('lent', 'ws-a');
      scope.settleBorrow('lent', 'ws-a', true);

      expect(await client.cdpInfoTargets('ws-a')).toEqual([]);
      expect(scope.ownerOf('lent', 'ws-a')).toBe('user');
    });
  });
});
