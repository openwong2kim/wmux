import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  listWslDistros,
  resetWslDistroCache,
  resolveWslDistro,
  type WslRunner,
} from '../wslDistro';

/**
 * Issue #21 AC 1 — a live WSL pane must be able to name its distribution
 * without an app restart, and naming it must never boot a distribution
 * (AC 4). The runner is injected so these assertions never spawn wsl.exe.
 */

/** UTF-16LE is what a stock `wsl.exe` writes; the parser must handle both. */
function utf16(text: string): string {
  return Buffer.from(Buffer.from(text, 'utf16le')).toString('utf16le');
}

function fakeRunner(outputs: Record<string, string>): { run: WslRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: WslRunner = async (args) => {
    calls.push([...args]);
    return outputs[args.join(' ')] ?? '';
  };
  return { run, calls };
}

const QUIET = '-l -q';
const VERBOSE = '-l -v';
const RUNNING = '-l -q --running';

beforeEach(() => {
  resetWslDistroCache();
});

describe('resolveWslDistro', () => {
  it('resolves the default distro for a bare wsl.exe pane', async () => {
    const { run } = fakeRunner({
      [QUIET]: 'Ubuntu\r\ndocker-desktop\r\n',
      [VERBOSE]: '  NAME            STATE           VERSION\r\n* Ubuntu          Running         2\r\n  docker-desktop  Stopped         2\r\n',
      [RUNNING]: 'Ubuntu\r\n',
    });
    await expect(resolveWslDistro({ shell: 'C:\\Windows\\System32\\wsl.exe' }, run))
      .resolves.toBe('Ubuntu');
  });

  it('decodes the UTF-16LE listing wsl.exe emits by default', async () => {
    const { run } = fakeRunner({
      [QUIET]: utf16('Ubuntu-24.04\n'),
      [VERBOSE]: utf16('* Ubuntu-24.04 Running 2\n'),
      [RUNNING]: utf16('Ubuntu-24.04\n'),
    });
    await expect(resolveWslDistro({ shell: 'wsl.exe' }, run)).resolves.toBe('Ubuntu-24.04');
  });

  it('prefers the pane\'s own -d argument over enumeration', async () => {
    const { run, calls } = fakeRunner({ [QUIET]: 'Ubuntu\n', [VERBOSE]: '* Ubuntu Running 2\n' });
    await expect(resolveWslDistro({ shell: 'wsl.exe', args: ['-d', 'Debian'] }, run))
      .resolves.toBe('Debian');
    // AC 4: an answer the pane already states must cost no subprocess at all.
    expect(calls).toEqual([]);
  });

  it('prefers WSL_DISTRO_NAME from the pane environment', async () => {
    const { run, calls } = fakeRunner({ [QUIET]: 'Ubuntu\n', [VERBOSE]: '* Ubuntu Running 2\n' });
    await expect(resolveWslDistro({ shell: 'wsl.exe', env: { WSL_DISTRO_NAME: 'Alpine' } }, run))
      .resolves.toBe('Alpine');
    expect(calls).toEqual([]);
  });

  it('falls back to the only registered distro when no default is marked', async () => {
    const { run } = fakeRunner({ [QUIET]: 'Ubuntu\n', [VERBOSE]: '', [RUNNING]: '' });
    await expect(resolveWslDistro({ shell: 'wsl.exe' }, run)).resolves.toBe('Ubuntu');
  });

  it('stays unresolved rather than guessing between distros', async () => {
    const { run } = fakeRunner({
      [QUIET]: 'Ubuntu\nDebian\n',
      [VERBOSE]: '  NAME STATE VERSION\n  Ubuntu Stopped 2\n  Debian Stopped 2\n',
      [RUNNING]: '',
    });
    await expect(resolveWslDistro({ shell: 'wsl.exe' }, run)).resolves.toBeUndefined();
  });

  it('never enumerates for a non-WSL pane', async () => {
    const { run, calls } = fakeRunner({ [QUIET]: 'Ubuntu\n' });
    await expect(resolveWslDistro({ shell: 'pwsh.exe' }, run)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('only ever enumerates — it never runs a command inside a distro', async () => {
    const { run, calls } = fakeRunner({ [QUIET]: 'Ubuntu\n', [VERBOSE]: '* Ubuntu Running 2\n' });
    await resolveWslDistro({ shell: 'wsl.exe' }, run);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).toBe('-l');
      expect(call).not.toContain('--exec');
      expect(call).not.toContain('-e');
      expect(call).not.toContain('--cd');
    }
  });
});

describe('listWslDistros caching', () => {
  it('matches the longest default distro name without reordering the quiet list', async () => {
    const { run } = fakeRunner({
      [QUIET]: 'Ubuntu\nUbuntu Preview\n',
      [VERBOSE]: '* Ubuntu Preview Running 2\n  Ubuntu Stopped 2\n',
      [RUNNING]: 'Ubuntu Preview\n',
    });

    await expect(listWslDistros(run)).resolves.toEqual({
      names: ['Ubuntu', 'Ubuntu Preview'],
      running: ['Ubuntu Preview'],
      defaultName: 'Ubuntu Preview',
    });
  });

  it('serves concurrent callers from one enumeration', async () => {
    const { run, calls } = fakeRunner({ [QUIET]: 'Ubuntu\n', [VERBOSE]: '* Ubuntu Running 2\n' });
    await Promise.all([listWslDistros(run), listWslDistros(run), listWslDistros(run)]);
    // 3 args-shapes × 1 enumeration, not × 3.
    expect(calls.length).toBe(3);
  });

  it('does not retain an empty result, so a transient failure is retried', async () => {
    const failing = vi.fn<WslRunner>(async () => '');
    await listWslDistros(failing);
    const failedCalls = failing.mock.calls.length;
    const { run } = fakeRunner({ [QUIET]: 'Ubuntu\n', [VERBOSE]: '* Ubuntu Running 2\n' });
    await expect(listWslDistros(run)).resolves.toMatchObject({ defaultName: 'Ubuntu' });
    expect(failedCalls).toBeGreaterThan(0);
  });
});
