/**
 * `wmux browser navigate` — issue #810.
 *
 * The main-process target lookup scopes only when the request carries a
 * workspaceId. The CLI used to omit it unconditionally, so a command run from
 * workspace A could navigate the first registered browser target in workspace
 * B. These tests pin verified self-context routing while preserving the
 * outside-wmux active-target fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendRequest } from '../../client';
import { getParentPidDefault, resolveSelfContext } from '../../identity';
import { handleBrowser, handleOpen } from '../browser';

const rpc = sendRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  selfContext.mockResolvedValue({ ptyId: 'pty-self', workspaceId: 'ws-self' });
  rpc.mockResolvedValue({ id: 'rpc-ok', ok: true, result: { ok: true } });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wmux browser navigate caller scoping (#810)', () => {
  it('routes navigation to the verified caller workspace', async () => {
    await handleBrowser(['navigate', 'https://example.com'], false);

    expect(selfContext).toHaveBeenCalledWith({
      sendRequest,
      env: process.env,
      ppid: process.ppid,
      getParentPid: getParentPidDefault,
    });
    expect(rpc).toHaveBeenCalledWith('browser.navigate', {
      url: 'https://example.com',
      workspaceId: 'ws-self',
    });
  });

  it('names the active workspace when no caller workspace resolves', async () => {
    // Outside a wmux pane there is no pane identity to walk to. This used to
    // send no workspace and let the main process fall back to whichever target
    // registered first; #810 removed that fallback, so the CLI asks which
    // workspace is active and says so. Same workspace the old fallback picked,
    // now chosen explicitly by the caller.
    selfContext.mockResolvedValue({});
    rpc.mockImplementation(async (method: string) =>
      method === 'workspace.current'
        ? { id: 'rpc-cur', ok: true, result: { id: 'ws-active', name: 'Active' } }
        : { id: 'rpc-ok', ok: true, result: { ok: true } },
    );

    await handleBrowser(['navigate', 'https://example.com/outside'], false);

    expect(rpc).toHaveBeenCalledWith('browser.navigate', {
      url: 'https://example.com/outside',
      workspaceId: 'ws-active',
    });
  });

  it('omits the field when the active workspace cannot be read', async () => {
    // Do not invent a workspace to get past the gate — send nothing and let the
    // server's own refusal explain itself. Guessing here would reintroduce the
    // "some workspace, who knows which" routing #810 is about.
    selfContext.mockResolvedValue({});
    rpc.mockImplementation(async (method: string) =>
      method === 'workspace.current'
        ? { id: 'rpc-cur', ok: false, error: 'renderer unavailable' }
        : { id: 'rpc-ok', ok: true, result: { ok: true } },
    );

    await handleBrowser(['navigate', 'https://example.com/outside'], false);

    expect(rpc).toHaveBeenCalledWith('browser.navigate', {
      url: 'https://example.com/outside',
    });
  });

  it('does not spend a round trip when the caller workspace already resolved', async () => {
    await handleBrowser(['navigate', 'https://example.com'], false);

    expect(rpc).not.toHaveBeenCalledWith('workspace.current', expect.anything());
  });
});

/**
 * `wmux open` and `wmux browser close` — issue #922 PR-C.
 *
 * PR-C folded `browser.open` / `browser.close` into the same caller-scope table
 * `browser.navigate` already used, which means an omitted workspaceId is now
 * refused instead of falling back to the active workspace. `navigate` got the
 * `workspace.current` fallback when #810 did the same to it; these two did not,
 * so outside a wmux pane both documented paths — "otherwise the active
 * workspace is used" / "defaults to your own workspace" — broke under enforce.
 *
 * Same shape as the navigate tests above, deliberately: one fallback, three
 * commands, and no third variant to drift.
 */
describe('wmux open / browser close caller scoping (#922 PR-C)', () => {
  it.each([
    ['open', handleOpen, ['https://example.com'], 'browser.open', { url: 'https://example.com' }],
    ['browser close', handleBrowser, ['close'], 'browser.close', {}],
  ])('%s routes to the verified caller workspace', async (_label, run, argv, method, extra) => {
    await run(argv, false);
    expect(rpc).toHaveBeenCalledWith(method, { ...extra, workspaceId: 'ws-self' });
  });

  it.each([
    ['open', handleOpen, ['https://example.com'], 'browser.open', { url: 'https://example.com' }],
    ['browser close', handleBrowser, ['close'], 'browser.close', {}],
  ])('%s names the active workspace when no caller workspace resolves', async (
    _label, run, argv, method, extra,
  ) => {
    // The regression PR-C would otherwise have shipped: outside a pane this
    // sent no workspace at all and was refused as `workspace-unresolved`.
    selfContext.mockResolvedValue({});
    rpc.mockImplementation(async (m: string) =>
      m === 'workspace.current'
        ? { id: 'rpc-cur', ok: true, result: { id: 'ws-active', name: 'Active' } }
        : { id: 'rpc-ok', ok: true, result: { ok: true } },
    );

    await run(argv, false);

    expect(rpc).toHaveBeenCalledWith(method, { ...extra, workspaceId: 'ws-active' });
  });

  it.each([
    ['open', handleOpen, ['https://example.com'], 'browser.open', { url: 'https://example.com' }],
    ['browser close', handleBrowser, ['close'], 'browser.close', {}],
  ])('%s omits the field when the active workspace cannot be read', async (
    _label, run, argv, method, extra,
  ) => {
    // Do not invent a workspace to get past the gate — let the server's own
    // refusal explain itself, which now carries the remedy text.
    selfContext.mockResolvedValue({});
    rpc.mockImplementation(async (m: string) =>
      m === 'workspace.current'
        ? { id: 'rpc-cur', ok: false, error: 'renderer unavailable' }
        : { id: 'rpc-ok', ok: true, result: { ok: true } },
    );

    await run(argv, false);

    expect(rpc).toHaveBeenCalledWith(method, extra);
  });

  it.each([
    ['open', handleOpen, ['https://example.com']],
    ['browser close', handleBrowser, ['close']],
  ])('%s spends no round trip when the caller workspace already resolved', async (
    _label, run, argv,
  ) => {
    await run(argv, false);
    expect(rpc).not.toHaveBeenCalledWith('workspace.current', expect.anything());
  });

  it('browser close still honours an explicit --workspace without any lookup', async () => {
    await handleBrowser(['close', '--workspace', 'ws-named'], false);
    expect(rpc).toHaveBeenCalledWith('browser.close', { workspaceId: 'ws-named' });
    expect(selfContext).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('workspace.current', expect.anything());
  });
});
