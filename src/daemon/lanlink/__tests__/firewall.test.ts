import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.fn(
  (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null) => void,
  ) => {
    cb(null);
  },
);

vi.mock('node:child_process', () => ({ execFile }));

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function load() {
  vi.resetModules();
  return import('../firewall');
}

beforeEach(() => {
  execFile.mockClear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('lanlink firewall coexistence', () => {
  it('applyLanLinkFirewall only deletes/adds fmux-named rules', async () => {
    setPlatform('win32');
    const { applyLanLinkFirewall } = await load();
    await applyLanLinkFirewall(12345, 'C:\\apps\\fmux\\fmux.exe');
    const names = execFile.mock.calls.flatMap((c) => c[1] as string[]).filter((a) => a.startsWith('name='));
    expect(names).toEqual([
      'name=fmux LanLink (Private)',
      'name=fmux LanLink (Public deny)',
      'name=fmux LanLink (Private)',
      'name=fmux LanLink (Public deny)',
    ]);
    expect(names.some((n) => n.includes('wmux'))).toBe(false);
  });

  it('removeLanLinkFirewall never deletes wmux-named rules', async () => {
    setPlatform('win32');
    const { removeLanLinkFirewall } = await load();
    await removeLanLinkFirewall();
    const names = execFile.mock.calls.flatMap((c) => c[1] as string[]).filter((a) => a.startsWith('name='));
    expect(names).toEqual([
      'name=fmux LanLink (Private)',
      'name=fmux LanLink (Public deny)',
    ]);
    expect(names.some((n) => n.includes('wmux'))).toBe(false);
  });
});
