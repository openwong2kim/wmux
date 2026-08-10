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
import { handleBrowser } from '../browser';

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

  it('preserves active-target fallback when no caller workspace resolves', async () => {
    selfContext.mockResolvedValue({});

    await handleBrowser(['navigate', 'https://example.com/outside'], false);

    expect(rpc).toHaveBeenCalledWith('browser.navigate', {
      url: 'https://example.com/outside',
    });
  });
});
