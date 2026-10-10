import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getLocale: vi.fn(() => 'en-US'), quit: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showMessageBox: vi.fn() },
}));

import { LOCALE_OPTIONS } from '../../../renderer/i18n';
import type { DaemonClient } from '../../DaemonClient';
import { buildQuitAndStopCopy, readUiLocale, type QuitAndStopCopy } from '../quitAndStopCopy';
import { countLiveSessions, runQuitAndStopSessions, type QuitAndStopDeps } from '../quitAndStopSessions';

const COPY: QuitAndStopCopy = { message: 'm', detail: 'd', confirm: 'c', cancel: 'x' };

function deps(over: Partial<QuitAndStopDeps> = {}): QuitAndStopDeps & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    countSessions: vi.fn(async () => ({ sessions: 3, agents: 2 })),
    buildCopy: vi.fn(async () => COPY),
    confirm: vi.fn(async () => true),
    onShutdownAll: vi.fn(() => { order.push('shutdownAll'); }),
    quit: vi.fn(() => { order.push('quit'); }),
    ...over,
  };
}

describe('runQuitAndStopSessions', () => {
  it('on confirm, requests the full teardown BEFORE quitting — before-quit reads the flag on its first pass', async () => {
    const d = deps();
    await expect(runQuitAndStopSessions(d)).resolves.toBe(true);
    expect(d.buildCopy).toHaveBeenCalledWith({ sessions: 3, agents: 2 });
    expect(d.order).toEqual(['shutdownAll', 'quit']);
  });

  it('on cancel, neither flips the flag nor quits', async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    await expect(runQuitAndStopSessions(d)).resolves.toBe(false);
    expect(d.onShutdownAll).not.toHaveBeenCalled();
    expect(d.quit).not.toHaveBeenCalled();
  });

  it('still asks when the count is unavailable, and passes null rather than 0', async () => {
    const d = deps({ countSessions: vi.fn(async () => null) });
    await runQuitAndStopSessions(d);
    expect(d.buildCopy).toHaveBeenCalledWith(null);
    expect(d.confirm).toHaveBeenCalled();
  });
});

describe('countLiveSessions', () => {
  const client = (rows: unknown, connected = true): DaemonClient =>
    ({ isConnected: connected, rpc: vi.fn(async () => rows) }) as unknown as DaemonClient;

  it('counts attached/detached sessions and the ones with a live agent', async () => {
    const rows = [
      { state: 'attached', liveAgent: 'claude' },
      { state: 'detached', liveAgent: 'codex' },
      { state: 'attached' },
      { state: 'dead', liveAgent: 'claude' },
      { state: 'suspended' },
    ];
    await expect(countLiveSessions(client(rows))).resolves.toEqual({ sessions: 3, agents: 2 });
  });

  it('is null without a connected client or when the RPC fails', async () => {
    await expect(countLiveSessions(null)).resolves.toBeNull();
    await expect(countLiveSessions(client([], false))).resolves.toBeNull();
    const failing = { isConnected: true, rpc: vi.fn(async () => { throw new Error('timeout'); }) } as unknown as DaemonClient;
    await expect(countLiveSessions(failing)).resolves.toBeNull();
  });
});

describe('buildQuitAndStopCopy', () => {
  it('names both counts in English', async () => {
    const copy = await buildQuitAndStopCopy('en', { sessions: 5, agents: 2 });
    expect(copy.detail).toContain('2 agent sessions');
    expect(copy.detail).toContain('5 terminals');
    expect(copy.confirm).toBe('Quit and Stop Sessions');
    expect(copy.cancel).toBe('Cancel');
  });

  it('never states a number when the count is unknown', async () => {
    const copy = await buildQuitAndStopCopy('en', null);
    expect(copy.detail).not.toMatch(/\d/);
  });

  it.each(LOCALE_OPTIONS.map((o) => o.value))('%s: loads its own table and fills both counts', async (locale) => {
    const en = await buildQuitAndStopCopy('en', { sessions: 7, agents: 4 });
    const copy = await buildQuitAndStopCopy(locale, { sessions: 7, agents: 4 });
    expect(copy.detail).toContain('7');
    expect(copy.detail).toContain('4');
    expect(copy.detail).not.toMatch(/\{\w+\}/);
    if (locale !== 'en') expect(copy.message).not.toBe(en.message);
  });
});

describe('readUiLocale', () => {
  const dirWith = (body: string | null): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quit-locale-'));
    if (body !== null) fs.writeFileSync(path.join(dir, 'session.json'), body);
    return dir;
  };

  it('prefers the locale the renderer persisted', () => {
    expect(readUiLocale(dirWith(JSON.stringify({ locale: 'pt-BR' })), 'en-US')).toBe('pt-BR');
  });

  it('falls back to the OS locale, then its base language, then English', () => {
    expect(readUiLocale(dirWith(null), 'zh-TW')).toBe('zh-TW');
    expect(readUiLocale(dirWith('{not json'), 'de-AT')).toBe('de');
    expect(readUiLocale(dirWith(JSON.stringify({ locale: 'xx' })), 'xx-YY')).toBe('en');
  });
});
