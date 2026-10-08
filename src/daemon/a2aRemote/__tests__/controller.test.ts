import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_DEFAULT_PORT } from '../../../shared/a2aRemote';
import type { DaemonConfig } from '../../types';
import {
  A2A_REMOTE_CONFIG_CHANGED,
  A2aRemoteController,
  coerceA2aRemoteConfig,
  coerceA2aRemotePatch,
} from '../controller';
import { connectRefused, disposeAll, freePort, makePc } from './a2aServerRig';

afterEach(async () => {
  await disposeAll();
});

describe('a2aRemote config slice', () => {
  it('backfills a missing or garbage slice to OFF, per field', () => {
    expect(coerceA2aRemoteConfig(undefined)).toEqual({ enabled: false });
    expect(coerceA2aRemoteConfig([])).toEqual({ enabled: false });
    expect(coerceA2aRemoteConfig({ enabled: 'yes', port: 80 })).toEqual({ enabled: false });
    expect(coerceA2aRemoteConfig({ enabled: true, port: 50000 })).toEqual({ enabled: true, port: 50000 });
  });

  it('rejects a malformed configure patch instead of persisting it', () => {
    expect(() => coerceA2aRemotePatch(null)).toThrow();
    expect(() => coerceA2aRemotePatch({ enabled: 1 })).toThrow(/enabled/);
    expect(() => coerceA2aRemotePatch({ port: 80 })).toThrow(/port/);
    expect(coerceA2aRemotePatch({ port: 50000, other: 1 })).toEqual({ port: 50000 });
  });

  it('persists and fires `changed` only on a real change', () => {
    const config = {} as DaemonConfig;
    const persist = vi.fn();
    const c = new A2aRemoteController({ config, persist });
    expect(config.a2aRemote).toEqual({ enabled: false });
    expect(c.effectivePort()).toBe(A2A_REMOTE_DEFAULT_PORT);
    const changed = vi.fn();
    c.on(A2A_REMOTE_CONFIG_CHANGED, changed);
    c.configure({ enabled: false });
    expect(persist).not.toHaveBeenCalled();
    c.configure({ enabled: true });
    c.configure({ port: 50001 });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith({ enabled: true, port: 50001 }, { enabled: true });
    expect(config.a2aRemote).toEqual({ enabled: true, port: 50001 });
  });

  it('a failed write applies nothing, and the same value can be retried', () => {
    const config = {} as DaemonConfig;
    let fail = true;
    const persist = vi.fn(() => {
      if (fail) throw new Error('disk full');
    });
    const c = new A2aRemoteController({ config, persist });
    const changed = vi.fn();
    c.on(A2A_REMOTE_CONFIG_CHANGED, changed);
    expect(() => c.configure({ enabled: true })).toThrow(/disk full/);
    expect(config.a2aRemote).toEqual({ enabled: false });
    expect(changed).not.toHaveBeenCalled();
    fail = false;
    c.configure({ enabled: true });
    expect(config.a2aRemote).toEqual({ enabled: true });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('the default port is clear of the web (7681) and LanLink (45651) defaults', () => {
    expect([7681, 45651]).not.toContain(A2A_REMOTE_DEFAULT_PORT);
  });
});

describe('A2aServer lifecycle driven by the controller', () => {
  it('starts at boot when the slice is enabled', async () => {
    const pc = await makePc('PC A', { enabled: true });
    expect(pc.server.status()).toMatchObject({ enabled: true, listening: true, lastError: null });
    expect(pc.server.status().hostId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pc.server.status().fingerprint256).toMatch(/^[0-9A-F:]{95}$/);
  });

  it('stays down at boot when disabled', async () => {
    const pc = await makePc('PC A', { enabled: false });
    expect(pc.server.status()).toMatchObject({ enabled: false, listening: false });
    expect(await connectRefused(pc.controller.effectivePort())).toBe(true);
  });

  it('toggling stops and starts the listener', async () => {
    const pc = await makePc('PC A', { enabled: true });
    const port = pc.server.boundPort()!;
    pc.server.beginPairing();

    pc.controller.configure({ enabled: false });
    await pc.server.whenIdle();
    expect(pc.server.status().listening).toBe(false);
    expect(await connectRefused(port)).toBe(true);
    // A stop kills the open invite.
    expect(pc.server.pairingStatus().active).toBe(false);

    pc.controller.configure({ enabled: true });
    await pc.server.whenIdle();
    expect(pc.server.boundPort()).toBe(port);
    expect(await connectRefused(port)).toBe(false);
  });

  it('a port change rebinds and keeps the identity', async () => {
    const pc = await makePc('PC A', { enabled: true });
    const oldPort = pc.server.boundPort()!;
    const fp = pc.server.status().fingerprint256;
    const newPort = await freePort();
    pc.controller.configure({ port: newPort });
    await pc.server.whenIdle();
    expect(pc.server.boundPort()).toBe(newPort);
    expect(await connectRefused(oldPort)).toBe(true);
    expect(await connectRefused(newPort)).toBe(false);
    expect(pc.server.status().fingerprint256).toBe(fp);
  });

  it('a port it cannot bind keeps the old listener and puts the old port back', async () => {
    const pc = await makePc('PC A', { enabled: true });
    const oldPort = pc.server.boundPort()!;
    const blocker = net.createServer();
    const busy = await freePort();
    await new Promise<void>((resolve) => blocker.listen(busy, '127.0.0.1', resolve));
    try {
      pc.controller.configure({ port: busy });
      await pc.server.whenIdle();
      expect(pc.server.boundPort()).toBe(oldPort);
      expect(await connectRefused(oldPort)).toBe(false);
      expect(pc.server.status()).toMatchObject({ listening: true, port: oldPort, lastError: 'EADDRINUSE' });
      expect(pc.config.a2aRemote).toEqual({ enabled: true, port: oldPort });
      // The chain is still alive: a good port afterwards rebinds normally.
      const good = await freePort();
      pc.controller.configure({ port: good });
      await pc.server.whenIdle();
      expect(pc.server.status()).toMatchObject({ listening: true, port: good, lastError: null });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('after dispose a config change starts nothing', async () => {
    const pc = await makePc('PC A', { enabled: false });
    pc.server.dispose();
    await pc.server.whenIdle();
    expect(pc.controller.listenerCount(A2A_REMOTE_CONFIG_CHANGED)).toBe(0);
    pc.controller.configure({ enabled: true });
    await pc.server.whenIdle();
    expect(pc.server.status().listening).toBe(false);
    expect(await connectRefused(pc.controller.effectivePort())).toBe(true);
  });

  it('a busy port leaves it stopped with lastError, no retry loop', async () => {
    const blocker = net.createServer();
    const port = await freePort();
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    try {
      const pc = await makePc('PC A', { enabled: true, port });
      expect(pc.server.status()).toMatchObject({ enabled: true, listening: false, lastError: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('an identity that cannot load leaves it stopped with lastError', async () => {
    const pc = await makePc('PC A', {
      enabled: true,
      deps: {
        loadIdentity: () => {
          throw new Error('host.json is corrupt');
        },
      },
    });
    expect(pc.server.status()).toMatchObject({ listening: false, lastError: 'identity: host.json is corrupt' });
  });
});
