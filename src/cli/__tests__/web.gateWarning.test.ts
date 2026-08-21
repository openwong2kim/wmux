import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDaemonStringRequestMock, isPermissionGateInstalledMock } = vi.hoisted(() => ({
  sendDaemonStringRequestMock: vi.fn(),
  isPermissionGateInstalledMock: vi.fn(),
}));

vi.mock('../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
}));

vi.mock('../commands/setupHooks', () => ({
  isPermissionGateInstalled: isPermissionGateInstalledMock,
}));

import { handleWeb } from '../commands/web';

let lines: string[];

beforeEach(() => {
  lines = [];
  sendDaemonStringRequestMock.mockReset();
  isPermissionGateInstalledMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function statusResponse(allowInput: boolean) {
  return {
    id: 'web-status',
    ok: true as const,
    result: {
      running: true,
      port: 7681,
      host: '127.0.0.1',
      allowInput,
      allowUpload: false,
      tls: false,
      urls: [],
    },
  };
}

/**
 * #970 — `--allow-input` is the only thing that ARMS the permission gate, so it
 * is the only place that can notice the gate HOOK is missing. On the
 * signals-only profile no tool call ever raises an approval and nothing else
 * reports it: the phone just never rings. That silence is the failure mode this
 * warning exists to break.
 */
describe('wmux web --allow-input permission-gate warning (#970)', () => {
  it('warns when input is enabled but the gate hook is not installed', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(statusResponse(true));
    isPermissionGateInstalledMock.mockReturnValue(false);

    await handleWeb(['--status'], false);

    const output = lines.join('\n');
    expect(output).toContain('Input is ENABLED');
    expect(output).toContain('permission gate hook is NOT installed');
    expect(output).toContain('wmux setup-hooks --with-gate');
  });

  it('stays quiet when the gate hook is installed', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(statusResponse(true));
    isPermissionGateInstalledMock.mockReturnValue(true);

    await handleWeb(['--status'], false);

    const output = lines.join('\n');
    expect(output).toContain('Input is ENABLED');
    expect(output).not.toContain('permission gate hook is NOT installed');
  });

  it('does not check, or warn, on a read-only server', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(statusResponse(false));
    isPermissionGateInstalledMock.mockReturnValue(false);

    await handleWeb(['--status'], false);

    const output = lines.join('\n');
    expect(output).toContain('Read-only');
    expect(output).not.toContain('permission gate hook is NOT installed');
    // Read-only can never arm the gate, so the check is pure cost there.
    expect(isPermissionGateInstalledMock).not.toHaveBeenCalled();
  });

  it('says nothing in --json mode, which is a machine contract', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(statusResponse(true));
    isPermissionGateInstalledMock.mockReturnValue(false);

    await handleWeb(['--status'], true);

    expect(lines.join('\n')).not.toContain('permission gate hook is NOT installed');
  });
});
