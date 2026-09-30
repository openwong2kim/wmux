/**
 * WEB_DIAGNOSE — the phone wizard's readiness check.
 *
 * The contract under test is "read-only": whatever tailscale and the daemon
 * answer, the handler only ever asks `tailscale status --json`,
 * `tailscale serve status --json` and `daemon.web.status`. Anything else —
 * `serve --bg`, `serve … off`, `daemon.web.start` — would make a check that
 * the operator runs just to LOOK change their tailnet or their server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  return { ipcMain, __handlers: handlers };
});

import * as electron from 'electron';
import { registerWebHandlers, WEB_DIAGNOSE_TIMEOUT_MS } from '../web.handler';
import { IPC } from '../../../../shared/constants';
import type { DaemonClient } from '../../../DaemonClient';
import type { WebDiagnosis } from '../../../../shared/web';
import { describeTailscaleProblem, type TailscaleExec, type TailscaleProblem } from '../../../../cli/tailscale';

const handlers = (electron as unknown as {
  __handlers: Map<string, (...a: unknown[]) => unknown>;
}).__handlers;

const LOGGED_IN = JSON.stringify({
  BackendState: 'Running',
  CurrentTailnet: { MagicDNSEnabled: true },
  Self: { DNSName: 'box.example-tailnet.ts.net.' },
});
const OURS = JSON.stringify({
  Web: { 'box.example-tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7681' } } } },
});
const FOREIGN = JSON.stringify({
  Web: { 'box.example-tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
});

/** Every tailscale invocation the handler made. */
let calls: string[][];
let rpc: ReturnType<typeof vi.fn>;

function fail(props: { code?: string; stderr?: string; message?: string }): Error {
  return Object.assign(new Error(props.message ?? 'Command failed: tailscale'), props);
}

/** A tailscale whose two read commands answer as given. */
function execWith(status: () => string, serve: () => string = () => '{}'): TailscaleExec {
  return async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'status') return { stdout: status(), stderr: '' };
    if (args[0] === 'serve' && args[1] === 'status') return { stdout: serve(), stderr: '' };
    return { stdout: '', stderr: '' };
  };
}

async function diagnose(exec: TailscaleExec, web: Record<string, unknown> = { running: false }): Promise<WebDiagnosis> {
  rpc = vi.fn(async () => web);
  const dc = { rpc, isConnected: true } as unknown as DaemonClient;
  registerWebHandlers(() => dc, exec);
  const fn = handlers.get(IPC.WEB_DIAGNOSE);
  if (!fn) throw new Error('WEB_DIAGNOSE not registered');
  return (await fn({})) as WebDiagnosis;
}

/** The read-only allowlist, asserted after every case below. */
function expectReadOnly(): void {
  for (const args of calls) {
    expect([
      ['status', '--json'],
      ['serve', 'status', '--json'],
    ]).toContainEqual(args);
  }
  for (const [method] of rpc.mock.calls) expect(method).toBe('daemon.web.status');
}

beforeEach(() => {
  handlers.clear();
  calls = [];
});

afterEach(() => {
  expectReadOnly();
  vi.useRealTimers();
});

describe('WEB_DIAGNOSE — ready', () => {
  it('free slot → ok, with the server status alongside', async () => {
    const res = await diagnose(execWith(() => LOGGED_IN), { running: false });
    expect(res.tailscale).toEqual({ ok: true, serve: 'free' });
    expect(res.web).toEqual({ running: false });
    expect(calls).toEqual([
      ['status', '--json'],
      ['serve', 'status', '--json'],
    ]);
  });

  it('a slot already fronting our own port → ok (ours), probed on the running port', async () => {
    const res = await diagnose(execWith(() => LOGGED_IN, () => OURS), { running: true, port: 7681 });
    expect(res.tailscale).toEqual({ ok: true, serve: 'ours' });
  });

  it('never leaks the MagicDNS name to the renderer', async () => {
    const res = await diagnose(execWith(() => LOGGED_IN));
    expect(JSON.stringify(res)).not.toContain('example-tailnet');
  });
});

describe('WEB_DIAGNOSE — every read-reachable TailscaleProblem', () => {
  const cases: Array<[TailscaleProblem, TailscaleExec]> = [
    [
      'not-installed',
      async (_c, args) => {
        calls.push(args);
        throw fail({ code: 'ENOENT', message: 'spawn tailscale ENOENT' });
      },
    ],
    ['not-logged-in', execWith(() => JSON.stringify({ BackendState: 'NeedsLogin' }))],
    ['needs-machine-auth', execWith(() => JSON.stringify({ BackendState: 'NeedsMachineAuth' }))],
    ['stopped', execWith(() => JSON.stringify({ BackendState: 'Stopped' }))],
    [
      'no-magicdns',
      execWith(() => JSON.stringify({ BackendState: 'Running', CurrentTailnet: { MagicDNSEnabled: false } })),
    ],
    ['status-unreadable', execWith(() => 'not json')],
    [
      'serve-status-unreadable',
      execWith(
        () => LOGGED_IN,
        () => {
          throw fail({ stderr: 'unknown flag --json' });
        },
      ),
    ],
    ['port-taken', execWith(() => LOGGED_IN, () => FOREIGN)],
  ];

  for (const [problem, exec] of cases) {
    it(`${problem} → ok:false with describeTailscaleProblem's text`, async () => {
      const res = await diagnose(exec);
      expect(res.tailscale.ok).toBe(false);
      if (res.tailscale.ok) return;
      expect(res.tailscale.problem).toBe(problem);
      expect(res.tailscale.lines[0]).toBe(describeTailscaleProblem(problem)[0]);
    });
  }

  it('a logged-out status error is not-logged-in, not unreadable', async () => {
    const res = await diagnose(async (_c, args) => {
      calls.push(args);
      throw fail({ stderr: 'Logged out. Please run: tailscale up' });
    });
    expect(res.tailscale).toMatchObject({ ok: false, problem: 'not-logged-in' });
  });
});

describe('describeTailscaleProblem — all 11 kinds have copy', () => {
  // needs-elevation, no-https-certs and serve-failed only come out of the
  // `serve --bg` WRITE, which the readiness check never runs; they surface
  // later, from WEB_START's transportError. They still need text.
  const ALL: TailscaleProblem[] = [
    'not-installed',
    'not-logged-in',
    'needs-machine-auth',
    'stopped',
    'no-magicdns',
    'status-unreadable',
    'serve-status-unreadable',
    'port-taken',
    'needs-elevation',
    'no-https-certs',
    'serve-failed',
  ];
  for (const problem of ALL) {
    it(problem, () => {
      const lines = describeTailscaleProblem(problem);
      expect(lines[0]).toMatch(/^Error: /);
    });
  }
});

describe('WEB_DIAGNOSE — bounded and graceful', () => {
  it('a tailscale that never answers resolves status-unreadable at the ceiling', async () => {
    vi.useFakeTimers();
    const hung: TailscaleExec = (_c, args) => {
      calls.push(args);
      return new Promise(() => undefined);
    };
    const pending = diagnose(hung);
    await vi.advanceTimersByTimeAsync(WEB_DIAGNOSE_TIMEOUT_MS + 1);
    const res = await pending;
    expect(res.tailscale).toMatchObject({ ok: false, problem: 'status-unreadable' });
  });

  it('no daemon → still answers, with the server-side error and a tailscale verdict', async () => {
    handlers.clear();
    rpc = vi.fn();
    registerWebHandlers(() => null, execWith(() => LOGGED_IN));
    const fn = handlers.get(IPC.WEB_DIAGNOSE);
    if (!fn) throw new Error('WEB_DIAGNOSE not registered');
    const res = (await fn({})) as WebDiagnosis;
    expect(res.web.running).toBe(false);
    expect(res.web.error).toBeTruthy();
    expect(res.tailscale.ok).toBe(true);
  });
});
