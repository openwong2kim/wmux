import os from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import { LanLinkController, LANLINK_CONFIG_CHANGED } from '../controller';
import { createDefaultConfig } from '../../config';
import type { DaemonConfig } from '../../types';

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function ifacesFixture(): Ifaces {
  return {
    Ethernet: [
      { address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '192.168.1.5/24' },
    ],
    lo: [
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
    ],
  } as Ifaces;
}

function makeController(overrides?: Partial<DaemonConfig>) {
  const config = { ...createDefaultConfig(), ...overrides };
  const persist = vi.fn<(c: DaemonConfig) => void>();
  const controller = new LanLinkController({ config, persist, ifaces: ifacesFixture });
  return { config, persist, controller };
}

describe('LanLinkController', () => {
  it('defaults to OFF with no NIC and exposes live NICs in status', () => {
    const { controller } = makeController();
    const status = controller.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.nic).toBeNull();
    expect(status.port).toBeNull();
    expect(status.nics.map((n) => n.name)).toEqual(['Ethernet']); // loopback excluded
  });

  it('backfills config.lanlink when the boot config lacks it', () => {
    const config = createDefaultConfig();
    delete config.lanlink; // simulate an old config that never got backfilled
    const controller = new LanLinkController({ config, persist: vi.fn(), ifaces: ifacesFixture });
    expect(config.lanlink).toEqual({ enabled: false, nic: null });
    expect(controller.getStatus().enabled).toBe(false);
  });

  it('configure(enabled) persists, mutates config in place, and emits changed', () => {
    const { config, persist, controller } = makeController();
    const onChanged = vi.fn();
    controller.on(LANLINK_CONFIG_CHANGED, onChanged);

    const status = controller.configure({ enabled: true });

    expect(status.enabled).toBe(true);
    expect(config.lanlink).toEqual({ enabled: true, nic: null }); // in-place mutation
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(config);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith({ enabled: true, nic: null });
  });

  it('is idempotent — a no-op patch neither persists nor emits', () => {
    const { persist, controller } = makeController();
    controller.configure({ enabled: true }); // 1 persist, 1 emit
    const onChanged = vi.fn();
    controller.on(LANLINK_CONFIG_CHANGED, onChanged);

    const status = controller.configure({ enabled: true }); // same value → no-op

    expect(status.enabled).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1); // unchanged from the first call
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('sets and clears the NIC identity (name+MAC)', () => {
    const { config, controller } = makeController();
    controller.configure({ nic: { name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff' } });
    expect(config.lanlink?.nic).toEqual({ name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff' });

    controller.configure({ nic: null }); // explicit clear
    expect(config.lanlink?.nic).toBeNull();
  });

  it('applies a combined enable+nic patch and round-trips status', () => {
    const { controller } = makeController();
    const status = controller.configure({ enabled: true, nic: { name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff' } });
    expect(status.enabled).toBe(true);
    expect(status.nic).toEqual({ name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff' });
  });

  it('persists a port and reflects it in status', () => {
    const { config, controller } = makeController();
    const status = controller.configure({ port: 41234 });
    expect(status.port).toBe(41234);
    expect(config.lanlink?.port).toBe(41234);
  });
});
