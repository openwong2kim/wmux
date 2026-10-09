import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDaemonStringRequestMock } = vi.hoisted(() => ({
  sendDaemonStringRequestMock: vi.fn(),
}));

vi.mock('../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
}));

import { handleWeb, resolveGitWriteLogin } from '../commands/web';

let lines: string[];

beforeEach(() => {
  lines = [];
  sendDaemonStringRequestMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const response = (gitWrite: { allowGitWrite?: boolean; gitWriteLogin?: string } = {}) => ({
  id: 'web',
  ok: true as const,
  result: {
    running: true, port: 7681, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: false,
    allowDangerousLaunch: false, ...gitWrite, tls: false, token: 'token-for-test',
    urls: ['http://127.0.0.1:7681/?token=token-for-test'],
  },
});

describe('wmux web --allow-git-write', () => {
  it('sends the ceiling and the login, and says so', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response({ allowGitWrite: true, gitWriteLogin: 'octocat' }));
    await handleWeb(['--allow-input', '--allow-git-write', '--git-write-login', 'octocat'], false);
    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith(
      'daemon.web.start',
      expect.objectContaining({ allowGitWrite: true, gitWriteLogin: 'octocat' }),
    );
    expect(lines.join('\n')).toContain('GIT WRITE ENABLED');
    expect(lines.join('\n')).toContain('@octocat');
  });

  it('keeps a running ceiling on a re-run that does not name it, and turns it off with --no-allow-git-write', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response({ allowGitWrite: true }));
    await handleWeb(['--allow-input'], false);
    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith('daemon.web.start', expect.objectContaining({ allowGitWrite: true }));
    sendDaemonStringRequestMock.mockClear();
    await handleWeb(['--no-allow-git-write'], false);
    const start = sendDaemonStringRequestMock.mock.calls.find((c) => c[0] === 'daemon.web.start');
    // An explicit off is never sent as on; the daemon reads an absent grant as off.
    expect((start?.[1] as Record<string, unknown>).allowGitWrite).not.toBe(true);
  });

  it('validates the login', () => {
    expect(resolveGitWriteLogin([])).toEqual({});
    expect(resolveGitWriteLogin(['--git-write-login', 'octo-cat'])).toEqual({ gitWriteLogin: 'octo-cat' });
    expect(() => resolveGitWriteLogin(['--git-write-login'])).toThrow();
    expect(() => resolveGitWriteLogin(['--git-write-login', 'bad login'])).toThrow();
  });
});
