import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDaemonStringRequestMock } = vi.hoisted(() => ({ sendDaemonStringRequestMock: vi.fn() }));

vi.mock('../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
  isDefinitelyNotRunning: () => false,
}));

import { handleWeb } from '../commands/web';
import { handleDaemon } from '../commands/daemon';

const OPERATOR_TOKEN = 'operator-token-never-printed';
let out: string[];

const status = (result: Record<string, unknown>) => ({ id: 's', ok: true as const, result });
const runningWeb = status({
  running: true, port: 7681, host: '127.0.0.1', allowInput: true, token: OPERATOR_TOKEN, pairCode: 'OLDCODE1',
});

beforeEach(() => {
  out = [];
  sendDaemonStringRequestMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('wmux web pair --json (E1)', () => {
  it('prints only the WebPairCliResult and asks for the grant for a desktop', async () => {
    sendDaemonStringRequestMock.mockImplementation(async (method: string) =>
      method === 'daemon.web.status' ? runningWeb : status({ ok: true, code: 'NEWCODE2', expiresAt: 1_700_000_000_000 }));
    await handleWeb(['pair', '--name', 'Laptop', '--kind', 'desktop'], true);

    expect(JSON.parse(out.join('\n'))).toEqual({ code: 'NEWCODE2', expiresAt: 1_700_000_000_000, port: 7681, allowInput: true });
    expect(out.join('\n')).not.toContain(OPERATOR_TOKEN);
    expect(sendDaemonStringRequestMock).toHaveBeenCalledWith('daemon.web.pairStart', {
      name: 'Laptop', flow: 'computer', grantCreateWorkspace: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('never starts a server that is not running', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(status({ running: false }));
    await handleWeb(['pair', '--name', 'Laptop', '--kind', 'desktop'], true);

    expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: false });
    expect(sendDaemonStringRequestMock.mock.calls.map(([method]) => method)).toEqual(['daemon.web.status']);
    expect(process.exitCode).toBe(1);
  });
});

describe('wmux daemon status --json', () => {
  it('adds the web summary without the operator token', async () => {
    sendDaemonStringRequestMock.mockImplementation(async (method: string) =>
      method === 'daemon.ping'
        ? status({ status: 'ok', version: '3.70.0', spawnedByVersion: '3.70.0', liveSessions: 2 })
        : runningWeb);
    await handleDaemon('status', [], true);

    const printed = out.join('\n');
    expect(JSON.parse(printed)).toMatchObject({
      running: true, version: '3.70.0', spawnedByVersion: '3.70.0', liveSessions: 2,
      web: { running: true, port: 7681, allowInput: true },
    });
    expect(printed).not.toContain(OPERATOR_TOKEN);
    expect(printed).not.toContain('OLDCODE1');
  });
});
