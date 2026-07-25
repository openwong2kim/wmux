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
import { WEB_DEFAULT_PORT, WEB_EXPOSE_HOST, WEB_LOOPBACK_HOST } from '../../../../shared/web';
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
    expect(res.transportError!.lines.length).toBeGreaterThan(0);
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
