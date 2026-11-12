import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDaemonStringRequestMock, startWebTransportMock } = vi.hoisted(() => ({
  sendDaemonStringRequestMock: vi.fn(),
  startWebTransportMock: vi.fn(),
}));

vi.mock('../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
}));

vi.mock('../tailscale', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tailscale')>()),
  startWebTransport: startWebTransportMock,
}));

import { handleWeb } from '../commands/web';

const TOKEN = '6f1c2d3e-0000-4000-8000-0123456789ab';
const LAN = `http://192.168.1.20:7681/?token=${TOKEN}`;
const LOCAL = `http://127.0.0.1:7681/?token=${TOKEN}`;
const TAILNET = { magicDns: 'box.tail1.ts.net', servePort: 443, url: 'https://box.tail1.ts.net' };

let out: string[];

function info(overrides: Record<string, unknown> = {}) {
  return {
    running: true,
    port: 7681,
    host: '0.0.0.0',
    allowInput: false,
    allowUpload: false,
    allowTranscript: false,
    tls: false,
    token: TOKEN,
    urls: [LOCAL, LAN],
    pairCode: '123456',
    ...overrides,
  };
}

const response = (result: Record<string, unknown>) => ({ id: 'web', ok: true as const, result });

beforeEach(() => {
  out = [];
  sendDaemonStringRequestMock.mockReset();
  startWebTransportMock.mockReset();
  const capture = (...args: unknown[]) => void out.push(args.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `wmux web` (a start) answered by the daemon with `result`, fronted by `tailnet`. */
async function start(args: string[], jsonMode: boolean, result: Record<string, unknown>, tailnet?: typeof TAILNET) {
  sendDaemonStringRequestMock.mockResolvedValue(response(result));
  startWebTransportMock.mockResolvedValue({ ok: true, value: response(result), warnings: [], ...(tailnet ? { tailnet } : {}) });
  await handleWeb(args, jsonMode);
}

describe('wmux web: the access token is hidden unless --show-token', () => {
  it.each([
    ['--status', (json: boolean) => (sendDaemonStringRequestMock.mockResolvedValue(response(info())), handleWeb(['--status'], json))],
    ['a start', (json: boolean) => start([], json, info())],
    ['a tailnet start', (json: boolean) => start(['--tailscale'], json, info({ host: '127.0.0.1', urls: [] }), TAILNET)],
    ['a status with only the token', (json: boolean) => (sendDaemonStringRequestMock.mockResolvedValue(response(info({ urls: [] }))), handleWeb(['--status'], json))],
  ])('prints no token by default: %s', async (_case, run) => {
    await run(false);
    const text = out.join('\n');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('token=');
    expect(text).toContain('--show-token');

    out = [];
    await run(true);
    expect(out.join('\n')).not.toContain(TOKEN);
  });

  it('still prints the addresses, without the token', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response(info()));
    await handleWeb(['--status'], false);
    const text = out.join('\n');
    expect(text).toContain('http://192.168.1.20:7681/');
    expect(text).toContain('open  http://192.168.1.20:7681/pair');
    expect(text).toContain('enter code  123456');
  });

  it('prints the working token addresses with --show-token', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response(info()));
    await handleWeb(['--status', '--show-token'], false);
    expect(out).toContain(`    ${LAN}`);
    expect(out).toContain(`    ${LOCAL}`);

    out = [];
    sendDaemonStringRequestMock.mockResolvedValue(response(info({ urls: [] })));
    await handleWeb(['--status', '--show-token'], false);
    expect(out).toContain(`  token: ${TOKEN}`);

    out = [];
    await start(['--tailscale', '--show-token'], false, info({ host: '127.0.0.1', urls: [] }), TAILNET);
    expect(out).toContain(`    ${TAILNET.url}/?token=${TOKEN}`);
  });

  it('JSON leaves out the token and marks it hidden; --show-token keeps today\'s document', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response(info()));
    await handleWeb(['--status'], true);
    const hidden = JSON.parse(out.join('\n'));
    expect(hidden).not.toHaveProperty('token');
    expect(hidden.tokenHidden).toBe(true);
    expect(hidden.urls).toEqual(['http://127.0.0.1:7681/', 'http://192.168.1.20:7681/']);
    expect(hidden.pairCode).toBe('123456');

    out = [];
    await handleWeb(['--status', '--show-token'], true);
    expect(JSON.parse(out.join('\n'))).toEqual(info());
  });

  it('says nothing about a token the daemon did not report', async () => {
    sendDaemonStringRequestMock.mockResolvedValue(response({ running: false }));
    await handleWeb(['--status'], true);
    expect(JSON.parse(out.join('\n'))).toEqual({ running: false });
  });
});
