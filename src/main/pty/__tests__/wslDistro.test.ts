import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createWslRunner,
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
    await expect(resolveWslDistro('C:\\Windows\\System32\\wsl.exe', run))
      .resolves.toBe('Ubuntu');
  });

  it('falls back to the only registered distro when no default is marked', async () => {
    const { run } = fakeRunner({ [QUIET]: 'Ubuntu\n', [VERBOSE]: '', [RUNNING]: '' });
    await expect(resolveWslDistro('wsl.exe', run)).resolves.toBe('Ubuntu');
  });

  it('stays unresolved rather than guessing between distros', async () => {
    const { run } = fakeRunner({
      [QUIET]: 'Ubuntu\nDebian\n',
      [VERBOSE]: '  NAME STATE VERSION\n  Ubuntu Stopped 2\n  Debian Stopped 2\n',
      [RUNNING]: '',
    });
    await expect(resolveWslDistro('wsl.exe', run)).resolves.toBeUndefined();
  });

  it('never enumerates for a non-WSL pane', async () => {
    const { run, calls } = fakeRunner({ [QUIET]: 'Ubuntu\n' });
    await expect(resolveWslDistro('pwsh.exe', run)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('only ever enumerates — it never runs a command inside a distro', async () => {
    const { run, calls } = fakeRunner({ [QUIET]: 'Ubuntu\n', [VERBOSE]: '* Ubuntu Running 2\n' });
    await resolveWslDistro('wsl.exe', run);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).toBe('-l');
      expect(call).not.toContain('--exec');
      expect(call).not.toContain('-e');
      expect(call).not.toContain('--cd');
    }
  });
});

describe('createWslRunner', () => {
  it('decodes UTF-16LE bytes and bounds the hidden non-interactive process', async () => {
    type Exec = NonNullable<Parameters<typeof createWslRunner>[0]>;
    const exec = vi.fn<Exec>((_file, _args, _options, callback) => {
      callback(null, Buffer.from('\uFEFFUbuntu-24.04\r\n', 'utf16le'));
    });
    const run = createWslRunner(exec, 'win32', { PATH: 'test-bin' });

    await expect(run(['-l', '-q'])).resolves.toBe('Ubuntu-24.04\r\n');
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      ['-l', '-q'],
      {
        encoding: 'buffer',
        timeout: 3_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        env: { PATH: 'test-bin', WSL_UTF8: '1' },
      },
      expect.any(Function),
    );
  });

  it('decodes UTF-8 bytes when WSL honours WSL_UTF8', async () => {
    type Exec = NonNullable<Parameters<typeof createWslRunner>[0]>;
    const exec = vi.fn<Exec>((_file, _args, _options, callback) => {
      callback(null, Buffer.from('Ubuntu\n', 'utf8'));
    });

    await expect(createWslRunner(exec, 'win32')(['-l', '-q'])).resolves.toBe('Ubuntu\n');
  });

  it('degrades callback errors and synchronous spawn failures to an empty result', async () => {
    type Exec = NonNullable<Parameters<typeof createWslRunner>[0]>;
    const callbackError = vi.fn<Exec>((_file, _args, _options, callback) => {
      callback(new Error('failed'), Buffer.alloc(0));
    });
    const synchronousError = vi.fn<Exec>(() => {
      throw new Error('failed');
    });

    await expect(createWslRunner(callbackError, 'win32')(['-l'])).resolves.toBe('');
    await expect(createWslRunner(synchronousError, 'win32')(['-l'])).resolves.toBe('');
  });

  it('does not spawn outside Windows', async () => {
    type Exec = NonNullable<Parameters<typeof createWslRunner>[0]>;
    const exec = vi.fn<Exec>();

    await expect(createWslRunner(exec, 'linux')(['-l'])).resolves.toBe('');
    expect(exec).not.toHaveBeenCalled();
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
