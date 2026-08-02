/**
 * web.handler — wmux web titlebar toggle ↔ daemon control-plane IPC.
 *
 * The handler forwards status/start/stop to the daemon.web.* string RPCs and
 * MUST degrade gracefully: with no DaemonClient (local mode / pipe down) every
 * method resolves `{ running:false, error }` instead of rejecting, so the
 * titlebar popover can render a quiet failure. It also enforces the safe
 * defaults main-side (read-only + loopback unless the renderer opts in).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { registerWebHandlers } from '../web.handler';
import { IPC } from '../../../../shared/constants';
import type { DaemonClient } from '../../../DaemonClient';
import {
  WEB_DEFAULT_PORT,
  WEB_EXPOSE_HOST,
  WEB_LOOPBACK_HOST,
  type WebTerminalInfo,
} from '../../../../shared/web';
import type { TailscaleExec } from '../../../../cli/tailscale';

const handlers = (electron as unknown as {
  __handlers: Map<string, (...a: unknown[]) => unknown>;
}).__handlers;

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn;
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent;

let rpc: ReturnType<typeof vi.fn>;

/**
 * A tailscale that is not installed.
 *
 * Every install below injects one. Without it the tailnet path shells out for
 * real, and a test run on a machine with tailscale logged in registers an
 * actual `tailscale serve` — which then points at a port no test ever listens
 * on. That is a 502 on the developer's own tailnet, left behind by a unit test.
 */
const execAbsent: TailscaleExec = async () => {
  const err = new Error('spawn tailscale ENOENT') as Error & { code?: string };
  err.code = 'ENOENT';
  throw err;
};

/** Install with a connected fake daemon whose `rpc` echoes the WebInfo. */
function installConnected(result: Record<string, unknown>, exec: TailscaleExec = execAbsent): void {
  rpc = vi.fn(async () => result);
  const dc = { rpc, isConnected: true } as unknown as DaemonClient;
  registerWebHandlers(() => dc, exec);
}

beforeEach(() => {
  handlers.clear();
});

describe('web.handler — forwarding', () => {
  it('status forwards daemon.web.status and returns the WebInfo', async () => {
    installConnected({ running: true, port: 7681, host: WEB_LOOPBACK_HOST });
    const res = (await getHandler(IPC.WEB_STATUS)(fakeEvent)) as { running: boolean; port: number };
    expect(rpc).toHaveBeenCalledWith('daemon.web.status', {});
    expect(res).toEqual({ running: true, port: 7681, host: WEB_LOOPBACK_HOST });
  });

  it('start defaults to read-only + loopback', async () => {
    installConnected({ running: true });
    await getHandler(IPC.WEB_START)(fakeEvent, {});
    expect(rpc).toHaveBeenCalledWith('daemon.web.start', {
      port: WEB_DEFAULT_PORT,
      host: WEB_LOOPBACK_HOST,
      allowInput: false,
      allowedHosts: [],
      tailscale: false,
    });
  });

  it('start maps expose → 0.0.0.0 and allowInput through', async () => {
    installConnected({ running: true });
    await getHandler(IPC.WEB_START)(fakeEvent, { allowInput: true, expose: true });
    expect(rpc).toHaveBeenCalledWith('daemon.web.start', {
      port: WEB_DEFAULT_PORT,
      host: WEB_EXPOSE_HOST,
      allowInput: true,
      allowedHosts: [],
      tailscale: false,
    });
  });

  it('start tolerates a null payload (safe defaults, never rejects)', async () => {
    installConnected({ running: true });
    await getHandler(IPC.WEB_START)(fakeEvent, null);
    expect(rpc).toHaveBeenCalledWith('daemon.web.start', {
      port: WEB_DEFAULT_PORT,
      host: WEB_LOOPBACK_HOST,
      allowInput: false,
      allowedHosts: [],
      tailscale: false,
    });
  });

  describe('front verification', () => {
    /** A tailscale whose serve slot is empty, counting how often it is asked. */
    function absentFront() {
      let probes = 0;
      const exec: TailscaleExec = async (_cmd, args) => {
        if (args[0] === 'serve' && args[1] === 'status') {
          probes += 1;
          return { stdout: '{}', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };
      return { exec, probes: () => probes };
    }

    const runningOnTailnet = {
      running: true,
      port: 7681,
      tailscale: true,
      urls: ['https://box.tail1234.ts.net/?token=t', 'http://127.0.0.1:7681/?token=t'],
      allowedHosts: ['box.tail1234.ts.net'],
      pairCode: 'ABCD2345',
    };

    it('★ a vanished front stops the https address being advertised', async () => {
      const { exec } = absentFront();
      installConnected(runningOnTailnet, exec);

      const res = (await getHandler(IPC.WEB_STATUS)(fakeEvent, {
        verifyFront: true,
      })) as WebTerminalInfo;

      // The daemon replays a persisted allowedHosts across a restart and cannot
      // tell the serve behind it is gone. Left alone the popover would render a
      // QR for an address that answers nothing, and the phone would take the
      // blame for a desktop-side problem.
      expect(res.urls).toEqual(['http://127.0.0.1:7681/?token=t']);
      expect(res.allowedHosts).toEqual([]);
      expect(res.pairRefusal?.reason).toBe('no-front');
    });

    it('★ the 10s poll never spawns tailscale, but still shows what was found', async () => {
      const { exec, probes } = absentFront();
      installConnected(runningOnTailnet, exec);

      await getHandler(IPC.WEB_STATUS)(fakeEvent, { verifyFront: true });
      expect(probes()).toBe(1);

      // Three polls, as the open popover would issue them.
      const poll1 = (await getHandler(IPC.WEB_STATUS)(fakeEvent, {})) as WebTerminalInfo;
      await getHandler(IPC.WEB_STATUS)(fakeEvent, {});
      const poll3 = (await getHandler(IPC.WEB_STATUS)(fakeEvent, {})) as WebTerminalInfo;

      // Still one probe: checking per poll would spawn tailscale six times a
      // minute for a fact that only changes when a human does something.
      expect(probes()).toBe(1);
      // …and the answer persists, so the operator is not shown a dead address
      // again just because the cheap path ran.
      expect(poll1.pairRefusal?.reason).toBe('no-front');
      expect(poll3.urls).toEqual(['http://127.0.0.1:7681/?token=t']);
    });

    it('leaves a live front completely alone', async () => {
      const exec: TailscaleExec = async (_cmd, args) => {
        if (args[0] === 'serve' && args[1] === 'status') {
          return {
            stdout: JSON.stringify({
              TCP: { '443': { HTTPS: true } },
              Web: {
                'box.tail1234.ts.net:443': {
                  Handlers: { '/': { Proxy: 'http://127.0.0.1:7681' } },
                },
              },
            }),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      };
      installConnected(runningOnTailnet, exec);

      const res = (await getHandler(IPC.WEB_STATUS)(fakeEvent, {
        verifyFront: true,
      })) as WebTerminalInfo;
      expect(res.urls).toEqual(runningOnTailnet.urls);
      expect(res.pairRefusal).toBeUndefined();
    });

    it('★ "cannot ask tailscale" is not reported as "the front is broken"', async () => {
      const exec: TailscaleExec = async () => {
        throw new Error('tailscaled is busy');
      };
      installConnected(runningOnTailnet, exec);

      const res = (await getHandler(IPC.WEB_STATUS)(fakeEvent, {
        verifyFront: true,
      })) as WebTerminalInfo;

      // A briefly unavailable tailscaled must not tell the operator their setup
      // fell apart. Unknown leaves the advertised address exactly as it was.
      expect(res.urls).toEqual(runningOnTailnet.urls);
      expect(res.pairRefusal).toBeUndefined();
    });

    it('does not probe a server that advertises no front at all', async () => {
      const { exec, probes } = absentFront();
      installConnected({ running: true, port: 7681, allowedHosts: [], tailscale: false }, exec);
      await getHandler(IPC.WEB_STATUS)(fakeEvent, { verifyFront: true });
      expect(probes()).toBe(0);
    });

    it('does not mistake a native TLS certificate name for a Tailscale front', async () => {
      const { exec, probes } = absentFront();
      const nativeTls = {
        running: true,
        port: 7681,
        tls: true,
        tailscale: false,
        urls: ['https://box.example.test:7681/?token=t'],
        allowedHosts: ['box.example.test'],
        pairCode: 'ABCD2345',
      };
      installConnected(nativeTls, exec);

      const res = (await getHandler(IPC.WEB_STATUS)(fakeEvent, {
        verifyFront: true,
      })) as WebTerminalInfo;

      expect(probes()).toBe(0);
      expect(res.urls).toEqual(nativeTls.urls);
      expect(res.allowedHosts).toEqual(nativeTls.allowedHosts);
      expect(res.pairRefusal).toBeUndefined();
    });

    it('★ REGRESSION: a front from before the tailscale flag existed is still checked', async () => {
      // Found by dogfooding, not by this suite. A web-state.json written before
      // the `tailscale` field existed replays its allowedHosts and parses as
      // `tailscale: false`, and the CLI's `--allow-host` path never sets the
      // flag either. Both still put https://<name>/ first in `urls`.
      //
      // Gating the probe on the FLAG therefore left the dead address on screen
      // — confirmed against a real tailnet, where the advertised URL answered
      // nothing. The honest question is "are we advertising a front?", which is
      // what allowedHosts says.
      const { exec, probes } = absentFront();
      installConnected(
        {
          running: true,
          port: 7681,
          tailscale: false,
          urls: ['https://box.tail1234.ts.net/?token=t', 'http://127.0.0.1:7681/?token=t'],
          allowedHosts: ['box.tail1234.ts.net'],
          pairCode: 'ABCD2345',
        },
        exec,
      );

      const res = (await getHandler(IPC.WEB_STATUS)(fakeEvent, {
        verifyFront: true,
      })) as WebTerminalInfo;

      expect(probes()).toBe(1);
      expect(res.urls).toEqual(['http://127.0.0.1:7681/?token=t']);
      expect(res.pairRefusal?.reason).toBe('no-front');
    });

    it('a bind-level refusal outranks the front probe', async () => {
      const { exec } = absentFront();
      installConnected(
        {
          ...runningOnTailnet,
          pairCode: undefined,
          pairRefusal: { reason: 'insecure-transport', detail: 'plaintext bind' },
        },
        exec,
      );
      const res = (await getHandler(IPC.WEB_STATUS)(fakeEvent, {
        verifyFront: true,
      })) as WebTerminalInfo;
      // The bind is a harder fact than a tailscale probe, and it is the one
      // that actually blocks minting.
      expect(res.pairRefusal?.reason).toBe('insecure-transport');
    });
  });

  it('★ a tailnet start that cannot register a front starts NOTHING', async () => {
    installConnected({ running: true });
    const res = (await getHandler(IPC.WEB_START)(fakeEvent, { tailscale: true })) as {
      running: boolean;
      transportError?: { reason: string; lines: string[] };
    };

    // Reported, not thrown — the popover renders a reason like every other
    // failure on this surface.
    expect(res.running).toBe(false);
    expect(res.transportError?.reason).toBe('not-installed');
    expect(res.transportError?.lines.length).toBeGreaterThan(0);
    // And nothing was started: a server without its front is reachable only on
    // loopback, which is not what the operator asked for.
    expect(rpc).not.toHaveBeenCalledWith('daemon.web.start', expect.anything());
  });

  it('★ tailnet and expose are alternatives — tailnet wins, the wildcard bind is dropped', async () => {
    // A caller that sets both is confused. Picking `expose` would put a
    // terminal on every interface for someone who asked for HTTPS.
    let sawBinding = '';
    const execOk: TailscaleExec = async (_cmd, args) => {
      if (args[0] === 'status') {
        return {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { HostName: 'Box', DNSName: 'box.tail1234.ts.net.' },
            CurrentTailnet: { MagicDNSEnabled: true },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'serve' && args[1] === 'status') return { stdout: '{}', stderr: '' };
      sawBinding = args.join(' ');
      return { stdout: '', stderr: '' };
    };
    installConnected({ running: true }, execOk);

    await getHandler(IPC.WEB_START)(fakeEvent, { tailscale: true, expose: true });

    expect(rpc).toHaveBeenCalledWith('daemon.web.start', {
      port: WEB_DEFAULT_PORT,
      // Loopback, NOT 0.0.0.0 — `tailscale serve` proxies loopback, and the
      // wildcard bind would be a second, weaker way in that nobody asked for.
      host: WEB_LOOPBACK_HOST,
      allowInput: false,
      allowedHosts: ['box.tail1234.ts.net'],
      tailscale: true,
    });
    expect(sawBinding).toContain('serve');
  });

  it('stop forwards daemon.web.stop', async () => {
    installConnected({ running: false });
    const res = (await getHandler(IPC.WEB_STOP)(fakeEvent)) as { running: boolean };
    expect(rpc).toHaveBeenCalledWith('daemon.web.stop', {});
    expect(res.running).toBe(false);
  });

  it('keeps the durable-stop error visible but removes a front once status confirms live is off', async () => {
    const tailscaleCalls: string[] = [];
    const exec: TailscaleExec = async (_cmd, args) => {
      tailscaleCalls.push(args.join(' '));
      if (args[0] === 'serve' && args[1] === 'status') {
        return {
          stdout: JSON.stringify({
            TCP: { '443': { HTTPS: true } },
            Web: {
              'box.tail1234.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:7681' } },
              },
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    let statusReads = 0;
    rpc = vi.fn(async (method: string) => {
      if (method === 'daemon.web.status') {
        statusReads += 1;
        return statusReads === 1
          ? { running: true, port: 7681 }
          : { running: false };
      }
      if (method === 'daemon.web.stop') {
        throw new Error(
          'The web server is stopped now, but persisted state could not be revoked',
        );
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const dc = { rpc, isConnected: true } as unknown as DaemonClient;
    registerWebHandlers(() => dc, exec);

    const res = (await getHandler(IPC.WEB_STOP)(fakeEvent)) as WebTerminalInfo;

    expect(res.running).toBe(false);
    expect(res.error).toContain('persisted state could not be revoked');
    expect(statusReads).toBe(2);
    expect(tailscaleCalls).toContain('serve --https=443 off');
  });

  it('keeps the toggle and front on when fresh status says the live stop failed', async () => {
    const tailscaleCalls: string[] = [];
    const exec: TailscaleExec = async (_cmd, args) => {
      tailscaleCalls.push(args.join(' '));
      return { stdout: '', stderr: '' };
    };
    rpc = vi.fn(async (method: string) => {
      if (method === 'daemon.web.status') return { running: true, port: 7681 };
      if (method === 'daemon.web.stop') {
        throw new Error('The web server could not be stopped now');
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const dc = { rpc, isConnected: true } as unknown as DaemonClient;
    registerWebHandlers(() => dc, exec);

    const res = (await getHandler(IPC.WEB_STOP)(fakeEvent)) as WebTerminalInfo;

    expect(res.running).toBe(true);
    expect(res.port).toBe(7681);
    expect(res.error).toContain('could not be stopped now');
    expect(tailscaleCalls).toEqual([]);
  });
});

describe('web.handler — graceful degradation', () => {
  it('resolves running:false + error when there is no daemon client', async () => {
    registerWebHandlers(() => null);
    const res = (await getHandler(IPC.WEB_STATUS)(fakeEvent)) as { running: boolean; error?: string };
    expect(res.running).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('resolves running:false + error when the daemon pipe is disconnected', async () => {
    const dc = { rpc: vi.fn(), isConnected: false } as unknown as DaemonClient;
    registerWebHandlers(() => dc);
    const res = (await getHandler(IPC.WEB_START)(fakeEvent, {})) as { running: boolean; error?: string };
    expect(res.running).toBe(false);
    expect(res.error).toBeTruthy();
    // Never even attempts the RPC on a disconnected pipe.
    expect((dc.rpc as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('resolves running:false + error when the RPC throws', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('RPC timeout: daemon.web.status');
    });
    const dc = { rpc: throwing, isConnected: true } as unknown as DaemonClient;
    registerWebHandlers(() => dc);
    const res = (await getHandler(IPC.WEB_STATUS)(fakeEvent)) as { running: boolean; error?: string };
    expect(res.running).toBe(false);
    expect(res.error).toContain('RPC timeout');
  });
});
