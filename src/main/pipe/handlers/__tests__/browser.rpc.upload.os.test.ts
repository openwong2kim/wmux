import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { dispatchAsClaimedCaller } from './claimedCaller';
import type { BrowserBackendStore } from '../../../browser-session/BrowserBackendStore';
import { deliberateSleep } from '../../../../test-utils/waitFor';

/**
 * browser.upload.cdp, called directly: main checks every path itself, and the
 * page is touched only through commands that leave the shared debugger as
 * every other user of it found it.
 */

const WMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-upload-rpc-'));
const UPLOADS = path.join(WMUX_DIR, 'uploads');
const OUTSIDE = path.join(WMUX_DIR, 'outside');
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(UPLOADS, 'clip.mp4'), 'x');
fs.writeFileSync(path.join(OUTSIDE, 'id_rsa'), 'secret');

vi.mock('../../../../daemon/config', async () => ({
  ...(await vi.importActual<object>('../../../../daemon/config')),
  getWmuxDir: () => WMUX_DIR,
}));

type Listener = (event: unknown, method: string, params: unknown) => void;
const { guest } = vi.hoisted(() => {
  const listeners: Listener[] = [];
  return {
    guest: {
      listeners,
      /** What Runtime.evaluate answers for the lookup. */
      lookup: { result: { type: 'object', subtype: 'node', objectId: 'obj-1' } } as unknown,
      wc: {
        isDestroyed: () => false,
        getURL: () => 'about:blank',
        once: () => undefined,
        on: () => undefined,
        debugger: {
          isAttached: () => true,
          attach: () => undefined,
          on: (event: string, fn: Listener) => {
            if (event === 'message') listeners.push(fn);
          },
          removeListener: () => undefined,
          sendCommand: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({})),
        },
      },
    },
  };
});

vi.mock('electron', () => ({
  webContents: { fromId: () => guest.wc },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn(async () => ({ ok: true })) }));

import { registerBrowserRpc, setFilesInIsolatedWorld } from '../browser.rpc';

const TARGET = { surfaceId: 'surface-1', webContentsId: 42, targetId: 'target-1', workspaceId: 'ws-1' };

function answer(method: string): unknown {
  switch (method) {
    case 'Page.getFrameTree':
      return { frameTree: { frame: { id: 'frame-top' } } };
    case 'Page.createIsolatedWorld':
      return { executionContextId: 7 };
    case 'Runtime.evaluate':
      return guest.lookup;
    default:
      return {};
  }
}

function register() {
  const router = dispatchAsClaimedCaller(new RpcRouter());
  const cdp = {
    getTarget: vi.fn(() => TARGET),
    listTargets: vi.fn(() => [TARGET]),
    isDiscarded: vi.fn(() => false),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
  };
  const store = { get: () => 'builtin' as const, set: vi.fn() };
  registerBrowserRpc(router, () => null as unknown as BrowserWindow, cdp as never, store as unknown as BrowserBackendStore);
  return router;
}

async function call(router: RpcRouter, method: string, params: Record<string, unknown>) {
  const res = await router.dispatch({ id: '1', method, params: { surfaceId: 'surface-1', workspaceId: 'ws-1', ...params } } as never);
  return res.ok ? { result: (res as { result?: unknown }).result } : { error: String((res as { error?: unknown }).error) };
}

const sent = () => guest.wc.debugger.sendCommand.mock.calls.map((c) => c[0]);

beforeEach(() => {
  guest.wc.debugger.sendCommand.mockReset();
  guest.wc.debugger.sendCommand.mockImplementation(async (method: string) => answer(method));
  guest.lookup = { result: { type: 'object', subtype: 'node', objectId: 'obj-1' } };
});

afterAll(() => {
  fs.rmSync(WMUX_DIR, { recursive: true, force: true });
});

describe('browser.upload.cdp: main decides what the page may open', () => {
  const root = fs.realpathSync(UPLOADS);

  it('hands the page the checked real path, and nothing else', async () => {
    // Spelled with a `..` and through a link, so only the checked value matches.
    const alias = path.join(UPLOADS, 'alias.mp4');
    if (!fs.existsSync(alias)) fs.symlinkSync(path.join(UPLOADS, 'clip.mp4'), alias);
    const res = await call(register(), 'browser.upload.cdp', { files: [`${UPLOADS}${path.sep}sub${path.sep}..${path.sep}alias.mp4`] });
    expect(res).toEqual({ result: { uploaded: true, count: 1 } });
    const setFiles = guest.wc.debugger.sendCommand.mock.calls.find((c) => c[0] === 'DOM.setFileInputFiles');
    expect(setFiles?.[1]).toEqual({ files: [path.join(root, 'clip.mp4')], objectId: 'obj-1' });
  });

  const refused: Array<[string, () => string]> = [
    ['a path outside the root', () => path.join(OUTSIDE, 'id_rsa')],
    ['`..` out of the root', () => path.join(UPLOADS, '..', 'outside', 'id_rsa')],
    ['a symlink in the root pointing out', () => {
      const link = path.join(UPLOADS, 'escape');
      if (!fs.existsSync(link)) fs.symlinkSync(OUTSIDE, link, 'junction');
      return path.join(link, 'id_rsa');
    }],
    ['a UNC path', () => '\\\\attacker\\share\\x.png'],
    ['the root itself', () => UPLOADS],
    ['a directory under the root', () => {
      fs.mkdirSync(path.join(UPLOADS, 'folder'), { recursive: true });
      return path.join(UPLOADS, 'folder');
    }],
    ['a file that does not exist (yet)', () => path.join(UPLOADS, 'later.mp4')],
    ['an empty path', () => ''],
  ];
  for (const [label, file] of refused) {
    it(`refuses ${label} before touching the page`, async () => {
      const res = await call(register(), 'browser.upload.cdp', { files: [file()] });
      expect(res.error).toMatch(/browser\.upload\.cdp (blocked|: )/);
      expect(guest.wc.debugger.sendCommand).not.toHaveBeenCalled();
    });
  }

  it('refuses the whole call when one path of several escapes', async () => {
    const res = await call(register(), 'browser.upload.cdp', {
      files: [path.join(UPLOADS, 'clip.mp4'), path.join(OUTSIDE, 'id_rsa')],
    });
    expect(res.error).toContain('outside the upload root');
    expect(guest.wc.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('refuses names Windows opens as another file', async () => {
    for (const name of ['escape.\\id_rsa', 'escape \\id_rsa', 'con', 'clip.mp4.']) {
      const res = await call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, name)] });
      expect(res.error, name).toContain('Windows opens as a different file');
    }
    expect(guest.wc.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('refuses a missing, empty or oversized file list', async () => {
    const router = register();
    for (const files of [undefined, [], Array.from({ length: 65 }, () => path.join(UPLOADS, 'clip.mp4'))]) {
      expect((await call(router, 'browser.upload.cdp', { files })).error).toContain('"files" must hold');
    }
    expect(guest.wc.debugger.sendCommand).not.toHaveBeenCalled();
  });
});

describe('browser.upload.cdp: the shared debugger', () => {
  it('sends only the isolated-world lookup, the set and the release', async () => {
    await call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')] });
    expect(sent()).toEqual([
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
      'DOM.setFileInputFiles',
      'Runtime.releaseObjectGroup',
    ]);
    const evaluate = guest.wc.debugger.sendCommand.mock.calls.find((c) => c[0] === 'Runtime.evaluate')?.[1];
    expect(evaluate).toMatchObject({ contextId: 7 });
  });

  it('leaves console and network capture working, and never enables the DOM agent', async () => {
    const router = register();
    // Capture starts first, as it does when a guest registers.
    expect((await call(router, 'browser.console.get', { clear: true })).error).toBeUndefined();
    guest.wc.debugger.sendCommand.mockClear();

    expect((await call(router, 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')] })).result)
      .toEqual({ uploaded: true, count: 1 });
    const upload = sent();
    expect(upload.filter((m) => m.startsWith('DOM.') && m !== 'DOM.setFileInputFiles')).toEqual([]);
    expect(upload.filter((m) => /\.(enable|disable)$/.test(m))).toEqual([]);

    for (const fn of guest.listeners) {
      fn({}, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'after-upload' }] });
      fn({}, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://after.test/', method: 'POST' } });
    }
    const consoleRes = await call(router, 'browser.console.get', {});
    expect(JSON.stringify(consoleRes.result)).toContain('after-upload');
    const networkRes = await call(router, 'browser.network.get', {});
    expect(JSON.stringify(networkRes.result)).toContain('https://after.test/');
    // Neither read had to re-enable anything: capture was never disturbed.
    expect(sent().filter((m) => /\.enable$/.test(m))).toEqual([]);
  });

  it('reports a miss without setting anything, and still releases the lookup', async () => {
    guest.lookup = { result: { type: 'string', value: 'none' } };
    expect((await call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')] })).result)
      .toEqual({ uploaded: false, missing: 'match' });
    guest.lookup = { result: { type: 'string', value: 'anchor' } };
    expect((await call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')], near: true })).result)
      .toEqual({ uploaded: false, missing: 'near' });
    guest.lookup = { result: { type: 'string', value: 'many' } };
    expect((await call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')], near: true })).result)
      .toEqual({ uploaded: false, missing: 'ambiguous' });
    expect(sent()).not.toContain('DOM.setFileInputFiles');
    expect(sent().filter((m) => m === 'Runtime.releaseObjectGroup')).toHaveLength(3);
  });

  it('answers a selector the page cannot parse as a miss, first line only', async () => {
    guest.lookup = { exceptionDetails: { exception: { description: "SyntaxError: '[[' is not a valid selector.\n    at x" } } };
    const res = await call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')], selector: '[[' });
    expect(res.result).toEqual({ uploaded: false, missing: 'invalid', detail: "SyntaxError: '[[' is not a valid selector." });
    expect(sent()).not.toContain('DOM.setFileInputFiles');
  });

  it('keeps each call\'s remote objects in a group of its own', async () => {
    const router = register();
    await call(router, 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')] });
    await call(router, 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')] });
    const calls = guest.wc.debugger.sendCommand.mock.calls as Array<[string, Record<string, unknown>?]>;
    const evaluated = calls.filter((c) => c[0] === 'Runtime.evaluate').map((c) => c[1]?.objectGroup);
    const released = calls.filter((c) => c[0] === 'Runtime.releaseObjectGroup').map((c) => c[1]?.objectGroup);
    expect(evaluated).toHaveLength(2);
    expect(new Set(evaluated).size).toBe(2);
    expect(released).toEqual(evaluated);
  });

  it('gives up on a page that never answers the lookup, sending nothing', async () => {
    guest.wc.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'Runtime.evaluate' ? new Promise(() => undefined) : answer(method));
    const res = await call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')], timeoutMs: 50 });
    expect(res.result).toEqual({ uploaded: false, missing: 'unanswered' });
    expect(sent()).not.toContain('DOM.setFileInputFiles');
  });

  it('never sends the files once it has answered "unanswered", even when the lookup lands late', async () => {
    let answerLookup: (value: unknown) => void = () => undefined;
    guest.wc.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'Runtime.evaluate' ? new Promise((resolve) => { answerLookup = resolve; }) : answer(method));
    const res = await call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')], timeoutMs: 50 });
    expect(res.result).toEqual({ uploaded: false, missing: 'unanswered' });
    // The page wakes up (a dialog closed, a slow load finished) after the
    // caller was told nothing was set.
    answerLookup({ result: { type: 'object', subtype: 'node', objectId: 'obj-late' } });
    // The release comes after the point where a set would have gone out.
    await vi.waitFor(() => expect(sent()).toContain('Runtime.releaseObjectGroup'), { timeout: 5_000 });
    await deliberateSleep(50, 'a negative check: no set may follow the late lookup');
    expect(sent()).not.toContain('DOM.setFileInputFiles');
  });

  it('reports a page that does not take the files in time as an error, since it still may', async () => {
    guest.wc.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'DOM.setFileInputFiles' ? new Promise(() => undefined) : answer(method));
    const res = await call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')], timeoutMs: 50 });
    expect(res.error).toBe('browser.upload.cdp: the page did not take the files within 50 ms');
  });

  it('caps the wait at two minutes', async () => {
    vi.useFakeTimers();
    try {
      guest.wc.debugger.sendCommand.mockImplementation(async (method: string) =>
        method === 'Runtime.evaluate' ? new Promise(() => undefined) : answer(method));
      const pending = call(register(), 'browser.upload.cdp', { files: [path.join(UPLOADS, 'clip.mp4')], timeoutMs: 10_000_000 });
      await vi.advanceTimersByTimeAsync(120_000);
      expect((await pending).result).toEqual({ uploaded: false, missing: 'unanswered' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('setFilesInIsolatedWorld: the lookup it injects', () => {
  /** Runs the injected expression against a stand-in document. */
  async function lookupWith(document: unknown, selector: string, near: boolean): Promise<unknown> {
    let expression = '';
    await setFilesInIsolatedWorld(async (method, params) => {
      if (method === 'Runtime.evaluate') expression = String((params as { expression: string }).expression);
      return answer(method);
    }, ['/x'], selector, near);
    return new Function('document', `return ${expression}`)(document);
  }

  const node = (tagName: string, type?: string) => ({
    nodeType: 1,
    tagName,
    children: [] as unknown[],
    parentElement: null as unknown,
    getAttribute: (name: string) => (name === 'type' ? type ?? null : null),
    closest: () => null,
  });

  it('finds the hidden input beside a styled button, standing alone (no closure)', async () => {
    const parent = node('DIV');
    const button = node('BUTTON');
    const input = node('INPUT', 'file');
    parent.children = [button, input];
    button.parentElement = parent;
    input.parentElement = parent;
    const asked: string[] = [];
    const doc = { querySelectorAll: (s: string) => (asked.push(s), [button]) };
    expect(await lookupWith(doc, '[data-wmux-ref="7"]', true)).toBe(input);
    expect(asked).toEqual(['[data-wmux-ref="7"]']);
  });

  it('answers the first match without the search, and misses by name', async () => {
    const button = node('BUTTON');
    const other = node('BUTTON');
    const doc = (...found: unknown[]) => ({ querySelectorAll: () => found });
    expect(await lookupWith(doc(button, other), 'button', false)).toBe(button);
    expect(await lookupWith(doc(button), 'button', true)).toBe('anchor');
    expect(await lookupWith(doc(), 'input', false)).toBe('none');
  });

  it('refuses a ref anchor found on more than one element', async () => {
    const input = node('INPUT', 'file');
    expect(await lookupWith({ querySelectorAll: () => [input, node('INPUT', 'file')] }, '[data-wmux-upload="n"]', true))
      .toBe('many');
  });
});
