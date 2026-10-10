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
  setWorkspaceToken: vi.fn(),
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendRequest, setWorkspaceToken } from '../../client';
import { getParentPidDefault, resolveSelfContext } from '../../identity';
import { handleBrowser, handleOpen } from '../browser';

const rpc = sendRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  selfContext.mockResolvedValue({ ptyId: 'pty-self', workspaceId: 'ws-self', workspaceToken: 'claim-self' });
  rpc.mockResolvedValue({ id: 'rpc-ok', ok: true, result: { ok: true } });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

/** Run a command that must exit; `process.exit` throws so the test can see it. */
async function expectRefusedOutsidePane(run: () => Promise<void>): Promise<string> {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
    errors.push(String(msg));
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  await expect(run()).rejects.toThrow('exit 1');
  return errors.join('\n');
}

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
      callerPid: process.pid,
    });
    expect(rpc).toHaveBeenCalledWith('browser.navigate', {
      url: 'https://example.com',
      workspaceId: 'ws-self',
    });
  });

  it('refuses outside a wmux pane and says how to run it, sending nothing', async () => {
    selfContext.mockResolvedValue({});
    const message = await expectRefusedOutsidePane(() => handleBrowser(['navigate', 'https://example.com/outside'], false));
    expect(message).toContain('Run the command from a wmux pane terminal');
    expect(rpc).not.toHaveBeenCalled();
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
 * Same shape as the navigate tests above, deliberately: one rule for the three
 * commands — the pane they run in, or a refusal that says so.
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
    ['open', handleOpen, ['https://example.com']],
    ['browser close', handleBrowser, ['close']],
    ['browser close --workspace', handleBrowser, ['close', '--workspace', 'ws-named']],
  ])('%s refuses outside a wmux pane, sending nothing', async (_label, run, argv) => {
    selfContext.mockResolvedValue({});
    const message = await expectRefusedOutsidePane(() => run(argv, false));
    expect(message).toContain('wmux pane');
    expect(rpc).not.toHaveBeenCalled();
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

  it('browser close sends an explicit --workspace, still resolving the pane claim it narrows', async () => {
    await handleBrowser(['close', '--workspace', 'ws-named'], false);
    expect(rpc).toHaveBeenCalledWith('browser.close', { workspaceId: 'ws-named' });
    expect(selfContext).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalledWith('workspace.current', expect.anything());
  });

  it('carries the pane claim main minted on every browser request', async () => {
    await handleBrowser(['navigate', 'https://example.com'], false);
    expect(setWorkspaceToken).toHaveBeenCalledWith('claim-self');
  });
});
