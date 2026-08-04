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
});

afterEach(() => {
  vi.restoreAllMocks();
});

function statusResponse(allowTranscript?: boolean) {
  return {
    id: 'web-status',
    ok: true as const,
    result: {
      running: true,
      port: 7681,
      host: '127.0.0.1',
      allowInput: false,
      allowUpload: false,
      ...(allowTranscript === undefined ? {} : { allowTranscript }),
      tls: false,
      urls: [],
    },
  };
}

describe('wmux web --status transcript access', () => {
  it('makes enabled full-transcript access visible', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(statusResponse(true));

    await handleWeb(['--status'], false);

    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith('daemon.web.status', {});
    const output = lines.join('\n');
    expect(output).toContain('transcript ENABLED');
    expect(output).toContain('Transcript access is ENABLED');
    expect(output).toContain('thinking, tool inputs, and file contents');
  });

  it.each([
    ['disabled', false],
    ['unreported by an older daemon', undefined],
  ])('reports transcript access as off when it is %s', async (_case, allowTranscript) => {
    sendDaemonStringRequestMock.mockResolvedValue(statusResponse(allowTranscript));

    await handleWeb(['--status'], false);

    const output = lines.join('\n');
    expect(output).not.toContain('transcript ENABLED');
    expect(output).toContain('Transcript access is off');
    expect(output).toContain('--allow-transcript');
  });
});
