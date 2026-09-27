import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDaemonStringRequestMock, loadWebStateMock } = vi.hoisted(() => ({
  sendDaemonStringRequestMock: vi.fn(),
  loadWebStateMock: vi.fn(),
}));

vi.mock('../client', () => ({
  sendDaemonStringRequest: sendDaemonStringRequestMock,
}));

// Never the developer's real ~/.wmux record.
vi.mock('../../daemon/web/webStateStore', () => ({
  loadWebState: loadWebStateMock,
}));

import { handleWeb } from '../commands/web';
import { planWebStart, type PreviousWebShape } from '../webStartPlan';

let lines: string[];

/** A daemon whose web server is `status`; a start echoes its params back as running. */
function daemon(status: Record<string, unknown>): void {
  sendDaemonStringRequestMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'daemon.web.status') return { id: 's', ok: true, result: status };
    return {
      id: 'w',
      ok: true,
      result: { running: true, token: 't', urls: ['http://127.0.0.1:7681/?token=t'], ...params },
    };
  });
}

function startParams(): Record<string, unknown> {
  const call = sendDaemonStringRequestMock.mock.calls.find((c) => c[0] === 'daemon.web.start');
  if (!call) throw new Error('no daemon.web.start');
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  lines = [];
  sendDaemonStringRequestMock.mockReset();
  loadWebStateMock.mockReset();
  loadWebStateMock.mockReturnValue({ enabled: false });
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

/** An exposed server with the phone Chat view on — the owner's real setup, minus tailscale. */
const exposedWithTranscript = {
  running: true,
  port: 7681,
  host: '0.0.0.0',
  tailscale: false,
  allowedHosts: ['box.example.test'],
  tls: false,
  allowInput: false,
  allowUpload: true,
  allowTranscript: true,
  allowDangerousLaunch: true,
};

describe('wmux web re-run keeps what it was not told to change', () => {
  it('an option-only re-run keeps the exposure scope and every grant', async () => {
    daemon(exposedWithTranscript);
    await handleWeb(['--allow-input'], false);
    expect(startParams()).toMatchObject({
      port: 7681,
      host: '0.0.0.0',
      allowedHosts: ['box.example.test'],
      tailscale: false,
      allowInput: true,
      allowUpload: true,
      allowTranscript: true,
      allowDangerousLaunch: true,
    });
    // Not decided on this command line, so not sent: the daemon keeps TLS as is.
    expect(startParams()).not.toHaveProperty('tls');
    const output = lines.join('\n');
    expect(output).toContain('Keeping previous settings');
    expect(output).toContain('--allow-transcript');
    expect(output).not.toContain('WARNING: this restart narrows access');
  });

  it('negative flags turn a grant off explicitly', async () => {
    daemon(exposedWithTranscript);
    await handleWeb(['--no-allow-transcript', '--no-allow-dangerous-launch'], false);
    const params = startParams();
    expect(params['allowTranscript']).toBe(false);
    expect(params).not.toHaveProperty('allowDangerousLaunch');
    // Untouched grants still carry over.
    expect(params['allowUpload']).toBe(true);
  });

  it('--loopback narrows the scope on purpose and says so', async () => {
    daemon(exposedWithTranscript);
    await handleWeb(['--loopback'], false);
    expect(startParams()).toMatchObject({ host: '127.0.0.1', allowedHosts: [], allowTranscript: true });
    expect(lines.join('\n')).toContain('WARNING: this restart narrows access');
  });

  it('warns when an explicit scope drops the tailnet', async () => {
    daemon({ ...exposedWithTranscript, host: '127.0.0.1', tailscale: true });
    await handleWeb(['--expose'], false);
    expect(startParams()).toMatchObject({ host: '0.0.0.0', tailscale: false });
    expect(lines.join('\n')).toContain('tailnet (tailscale serve) address stops working');
  });

  it('with nothing running it starts from the persisted record the daemon could not restore', async () => {
    daemon({ running: false });
    loadWebStateMock.mockReturnValue({
      enabled: true,
      port: 7690,
      host: '0.0.0.0',
      tailscale: false,
      allowedHosts: [],
      allowInput: true,
      allowUpload: false,
      allowTranscript: true,
      token: 'x',
    });
    await handleWeb([], false);
    expect(startParams()).toMatchObject({ port: 7690, host: '0.0.0.0', allowInput: true, allowTranscript: true });
  });

  it('a fresh start keeps the fail-closed defaults exactly', async () => {
    daemon({ running: false });
    await handleWeb([], false);
    expect(startParams()).toMatchObject({
      port: 7681,
      host: '127.0.0.1',
      allowInput: false,
      allowUpload: false,
      allowTranscript: false,
      allowedHosts: [],
      tls: false,
      tailscale: false,
    });
    expect(startParams()).not.toHaveProperty('allowDangerousLaunch');
    expect(lines.join('\n')).not.toContain('Keeping previous settings');
  });
});

describe('planWebStart (tailnet paths, no tailscale shell-out)', () => {
  const tailnet: PreviousWebShape = {
    port: 7681,
    host: '127.0.0.1',
    tailscale: true,
    allowedHosts: ['box.tail1234.ts.net'],
    tls: false,
    allowInput: false,
    allowUpload: false,
    allowTranscript: true,
    allowDangerousLaunch: false,
  };

  it('an option-only re-run stays on the tailnet with its allow-list and transcript', () => {
    const plan = planWebStart(['--allow-input'], undefined, tailnet, 7681);
    expect(plan).toMatchObject({
      tailscale: true,
      explicitHost: '127.0.0.1',
      allowedHosts: ['box.tail1234.ts.net'],
      grants: { allowInput: true, allowTranscript: true, allowUpload: false, allowDangerousLaunch: false },
      narrowed: [],
    });
    expect(plan.kept).toContain('--tailscale');
  });

  it('--loopback drops the tailnet and warns', () => {
    const plan = planWebStart(['--loopback'], undefined, tailnet, 7681);
    expect(plan).toMatchObject({ tailscale: false, allowedHosts: [] });
    expect(plan.narrowed.join(' ')).toContain('tailnet');
  });

  it('warns when a re-run drops an allowed host a front depends on', () => {
    const proxied: PreviousWebShape = { ...tailnet, tailscale: false, allowedHosts: ['box.example.test'] };
    expect(planWebStart(['--loopback'], undefined, proxied, 7681).narrowed.join(' ')).toContain('box.example.test');
    expect(planWebStart(['--allow-input'], undefined, proxied, 7681).narrowed).toEqual([]);
  });

  it('refuses contradictory flags', () => {
    expect(() => planWebStart(['--allow-input', '--no-allow-input'], undefined, tailnet, 7681)).toThrow();
    expect(() => planWebStart(['--loopback', '--expose'], undefined, tailnet, 7681)).toThrow();
  });

  it('keeps native TLS unless --no-tls says otherwise, and warns on the drop', () => {
    const https: PreviousWebShape = { ...tailnet, tailscale: false, allowedHosts: [], tls: true };
    expect(planWebStart([], undefined, https, 7681).tls).toBeUndefined();
    const dropped = planWebStart(['--no-tls'], undefined, https, 7681);
    expect(dropped.tls).toBe(false);
    expect(dropped.narrowed.join(' ')).toContain('native HTTPS');
  });
});
