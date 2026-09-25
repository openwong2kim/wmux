import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDaemonStringRequestMock } = vi.hoisted(() => ({
  sendDaemonStringRequestMock: vi.fn(),
}));

vi.mock('../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
}));

import { handleWeb } from '../commands/web';

let lines: string[];

beforeEach(() => {
  lines = [];
  sendDaemonStringRequestMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const response = (allowDangerousLaunch?: boolean) => ({
  id: 'web',
  ok: true as const,
  result: {
    running: true,
    port: 7681,
    host: '127.0.0.1',
    allowInput: true,
    allowUpload: false,
    allowTranscript: true,
    ...(allowDangerousLaunch === undefined ? {} : { allowDangerousLaunch }),
    tls: false,
    token: 'token-for-test',
    urls: ['http://127.0.0.1:7681/?token=token-for-test'],
  },
});

describe('wmux web --allow-dangerous-launch', () => {
  it('sends the ceiling only when the flag is given, and says so loudly', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response(true));
    await handleWeb(['--allow-input', '--allow-transcript', '--allow-dangerous-launch'], false);
    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith('daemon.web.start', expect.objectContaining({ allowDangerousLaunch: true }));
    const output = lines.join('\n');
    expect(output).toContain('DANGEROUS LAUNCH ENABLED');
    expect(output).toContain('Dangerous launch is ENABLED');
  });

  it('omits the param without the flag and prints nothing about it', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response());
    await handleWeb(['--allow-input'], false);
    const params = sendDaemonStringRequestMock.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('allowDangerousLaunch');
    expect(lines.join('\n')).not.toMatch(/dangerous launch/i);
  });
});
