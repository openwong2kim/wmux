/**
 * Windows "start on login" registry control (issue #460).
 *
 * The per-user Run key is the source of truth. These tests pin the two
 * invariants that matter:
 *
 *   1. On win32, each operation shells out to reg.exe with the exact
 *      add/delete/query argv, and `refreshAutostartEntry` re-writes the path
 *      ONLY when the key already exists (so a Squirrel update can't silently
 *      re-enable autostart for a user who turned it off).
 *   2. Off win32 every function is inert — reg.exe is never spawned and
 *      `isAutostartEnabled` reports false.
 *
 * child_process.execFileSync is mocked so no real registry write happens.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const realPlatform = process.platform;

// Mutable mock for execFileSync — each test sets its behavior.
const execFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

// darwin 분기용 electron app mock — 로그인 항목 상태를 in-memory로 흉내낸다.
// win/linux 테스트에서는 호출되지 않는다(호출 시 테스트에서 검증).
const loginItemState = { openAtLogin: false };
const setLoginItemSettings = vi.fn((s: { openAtLogin: boolean }) => {
  loginItemState.openAtLogin = s.openAtLogin;
});
const getLoginItemSettings = vi.fn(() => ({ openAtLogin: loginItemState.openAtLogin }));
let electronAppAvailable = true;
vi.mock('electron', () => ({
  get app() {
    return electronAppAvailable ? { setLoginItemSettings, getLoginItemSettings } : undefined;
  },
}));

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function load() {
  vi.resetModules();
  return import('../autostart');
}

beforeEach(() => {
  execFileSync.mockReset();
});

afterEach(() => {
  setPlatform(realPlatform);
});

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

describe('autostart (win32)', () => {
  beforeEach(() => setPlatform('win32'));

  it('isAutostartEnabled returns true when reg query succeeds', async () => {
    execFileSync.mockReturnValue(Buffer.from('')); // query exits 0
    const { isAutostartEnabled } = await load();
    expect(isAutostartEnabled()).toBe(true);
    const [, argv] = execFileSync.mock.calls[0];
    expect(argv).toEqual(['query', RUN_KEY, '/v', 'wmux']);
  });

  it('isAutostartEnabled returns false when reg query throws (value absent)', async () => {
    execFileSync.mockImplementation(() => { throw new Error('not found'); });
    const { isAutostartEnabled } = await load();
    expect(isAutostartEnabled()).toBe(false);
  });

  it('enableAutostart writes the Run value with the given exe path', async () => {
    execFileSync.mockReturnValue(Buffer.from(''));
    const { enableAutostart } = await load();
    enableAutostart('C:\\apps\\wmux\\wmux.exe');
    const [, argv] = execFileSync.mock.calls[0];
    expect(argv).toEqual([
      'add', RUN_KEY, '/v', 'wmux', '/t', 'REG_SZ', '/d', '"C:\\apps\\wmux\\wmux.exe"', '/f',
    ]);
  });

  it('disableAutostart deletes the Run value', async () => {
    execFileSync.mockReturnValue(Buffer.from(''));
    const { disableAutostart } = await load();
    disableAutostart();
    const [, argv] = execFileSync.mock.calls[0];
    expect(argv).toEqual(['delete', RUN_KEY, '/v', 'wmux', '/f']);
  });

  it('setAutostartEnabled(true) adds then re-queries the resulting state', async () => {
    execFileSync.mockReturnValue(Buffer.from('')); // both add and query succeed
    const { setAutostartEnabled } = await load();
    expect(setAutostartEnabled(true)).toBe(true);
    const verbs = execFileSync.mock.calls.map((c) => (c[1] as string[])[0]);
    expect(verbs).toEqual(['add', 'query']);
  });

  it('refreshAutostartEntry re-adds only when the key already exists', async () => {
    // query succeeds → key present → expect a follow-up add
    execFileSync.mockReturnValue(Buffer.from(''));
    const { refreshAutostartEntry } = await load();
    refreshAutostartEntry('C:\\apps\\wmux\\app-2\\wmux.exe');
    const verbs = execFileSync.mock.calls.map((c) => (c[1] as string[])[0]);
    expect(verbs).toEqual(['query', 'add']);
  });

  it('refreshAutostartEntry is a no-op when the key is absent', async () => {
    // query throws → key absent → no add
    execFileSync.mockImplementation(() => { throw new Error('not found'); });
    const { refreshAutostartEntry } = await load();
    refreshAutostartEntry();
    const verbs = execFileSync.mock.calls.map((c) => (c[1] as string[])[0]);
    expect(verbs).toEqual(['query']); // query only, no add
  });
});

describe('autostart (darwin)', () => {
  beforeEach(() => setPlatform('darwin'));

  it('setAutostartEnabled는 setLoginItemSettings로 등록/해제하고 openAtLogin을 되읽는다', async () => {
    electronAppAvailable = true;
    loginItemState.openAtLogin = false;
    const mod = await load();
    expect(mod.setAutostartEnabled(true)).toBe(true);
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(mod.setAutostartEnabled(false)).toBe(false);
    expect(setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
    // darwin 경로는 reg.exe를 절대 스폰하지 않는다
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('electron app 미가용 시 best-effort로 false를 반환한다', async () => {
    electronAppAvailable = false;
    const mod = await load();
    expect(mod.isAutostartEnabled()).toBe(false);
    expect(mod.setAutostartEnabled(true)).toBe(false);
    electronAppAvailable = true;
  });
});

describe('autostart (linux 등 기타 플랫폼)', () => {
  beforeEach(() => setPlatform('linux'));

  it('every function is inert and reg.exe is never spawned', async () => {
    const mod = await load();
    expect(mod.isAutostartEnabled()).toBe(false);
    mod.enableAutostart('/opt/wmux/wmux');
    mod.disableAutostart();
    expect(mod.setAutostartEnabled(true)).toBe(false);
    mod.refreshAutostartEntry();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
