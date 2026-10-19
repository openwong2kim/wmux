// onFactorySettingsChanged: what re-syncs the things gated on the factory
// switch (the track record feed) when the switch moves.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactorySettingsStore, factorySettingsPath, getFactorySettings, onFactorySettingsChanged, setFactorySettingsStore } from '../factorySettings';

const dirs: string[] = [];
afterEach(() => {
  setFactorySettingsStore(null);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function store(): FactorySettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp10-factory-settings-'));
  dirs.push(dir);
  const s = new FactorySettingsStore(factorySettingsPath(dir));
  s.load();
  return s;
}

describe('onFactorySettingsChanged', () => {
  it('is told when the live store is set or cleared and after every write, until unsubscribed', async () => {
    const seen: boolean[] = [];
    const off = onFactorySettingsChanged(() => seen.push(getFactorySettings().enabled));
    const s = store();
    setFactorySettingsStore(s);
    await s.update({ enabled: true, planConsent: { version: 1, at: '2026-10-15T00:00:00.000Z' } });
    setFactorySettingsStore(null);
    expect(seen).toEqual([false, true, false]);
    off();
    setFactorySettingsStore(s);
    expect(seen).toHaveLength(3);
  });

  it('a listener that throws does not stop the others or the write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const offBad = onFactorySettingsChanged(() => { throw new Error('boom'); });
    const good = vi.fn();
    const offGood = onFactorySettingsChanged(good);
    const s = store();
    setFactorySettingsStore(s);
    await expect(s.update({ enabled: true, planConsent: { version: 1, at: '2026-10-15T00:00:00.000Z' } })).resolves.toMatchObject({ enabled: true });
    expect(good).toHaveBeenCalledTimes(2);
    offBad();
    offGood();
  });

  it('a write that fails still tells the listeners: the switch is live in memory (switching off stops the bots)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp14-factory-settings-'));
    dirs.push(dir);
    const s = new FactorySettingsStore(factorySettingsPath(dir));
    s.load();
    setFactorySettingsStore(s);
    // A file where the settings folder belongs: the write fails on every platform.
    fs.rmSync(path.dirname(factorySettingsPath(dir)), { recursive: true, force: true });
    fs.writeFileSync(path.dirname(factorySettingsPath(dir)), '');
    const seen: boolean[] = [];
    const off = onFactorySettingsChanged(() => seen.push(getFactorySettings().enabled));
    try {
      await expect(s.update({ enabled: true, planConsent: { version: 1, at: '2026-10-15T00:00:00.000Z' } })).rejects.toThrow();
      expect(seen).toEqual([true]);
    } finally {
      off();
    }
  });

  it('listeners hear the switch before the write lands (a slow write never delays stopping the bots)', async () => {
    const s = store();
    setFactorySettingsStore(s);
    const seen: boolean[] = [];
    const off = onFactorySettingsChanged(() => seen.push(getFactorySettings().enabled));
    const writing = s.update({ enabled: true, planConsent: { version: 1, at: '2026-10-15T00:00:00.000Z' } });
    expect(seen).toEqual([true]);
    await writing;
    off();
  });
});
