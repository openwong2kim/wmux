// probedNative under filesystem faults: every fs call goes through a spy that
// runs the real call unless a test makes it fail.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROBE_LOCK, lockDir, prepareProbedNative, type ProbeVerdict } from '../probedNative';

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const spied = Object.fromEntries(
    (['openSync', 'readFileSync', 'unlinkSync', 'renameSync', 'linkSync', 'statSync', 'mkdirSync'] as const)
      .map((name) => [name, vi.fn(real[name] as (...args: unknown[]) => unknown)]),
  );
  return { ...real, ...spied, default: { ...real, ...spied } };
});

const realFs = await vi.importActual<typeof import('fs')>('fs');
let dir = '';
const lockFile = () => path.join(dir, PROBE_LOCK);

/** Fail `name` for paths `matches` picks with `code`. */
function fail(name: 'readFileSync' | 'unlinkSync', matches: (p: string) => boolean, code: string): void {
  const real = realFs[name] as (...args: unknown[]) => unknown;
  vi.mocked(fs[name]).mockImplementation(((...args: unknown[]) => {
    if (!matches(String(args[0]))) return real(...args);
    throw Object.assign(new Error(`${code}: injected`), { code });
  }) as never);
}

/** Count the attempts to create the lock; past `limit` the attempt fails
 *  with EIO, so a loop that never waits ends instead of hanging the worker. */
function countLockAttempts(limit = 2000): () => number {
  let calls = 0;
  vi.mocked(fs.openSync).mockImplementation(((...args: unknown[]) => {
    if (String(args[0]) === lockFile() && ++calls > limit) throw Object.assign(new Error('EIO: too many attempts'), { code: 'EIO' });
    return (realFs.openSync as (...a: unknown[]) => unknown)(...args);
  }) as never);
  return () => calls;
}

beforeEach(() => {
  dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'wmux-probed-faults-'));
});
afterEach(() => {
  vi.mocked(fs.openSync).mockImplementation(realFs.openSync as never);
  vi.mocked(fs.readFileSync).mockImplementation(realFs.readFileSync as never);
  vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync as never);
  vi.mocked(fs.renameSync).mockImplementation(realFs.renameSync as never);
  realFs.rmSync(dir, { recursive: true, force: true });
});

describe('prepareProbedNative — a Windows swap whose undo fails too', () => {
  it('offers nothing while the copy is missing, keeps the aside through the next sweep, and reports the first error', async () => {
    const dest = path.join(dir, 'wmux-native.exe');
    const source = path.join(dir, 'source.exe');
    const ship = (text: string) => realFs.writeFileSync(source, `${text} wmux-managed: native-hooks`);
    const probe = async (binary: string): Promise<ProbeVerdict> => (realFs.readFileSync(binary, 'utf8').includes('good') ? 'pass' : 'fail');
    const prepare = (p = probe) => prepareProbedNative({
      sourcePath: source, destinationPath: dest, recordDir: dir, line: 'line 1', probe: p,
      ownershipMarkers: ['wmux-managed: native-hooks'], platform: 'win32',
    });
    ship('good v1');
    expect(await prepare()).toEqual({ binary: dest });
    ship('good v2');
    // The staged copy cannot take the name, and the aside cannot go back.
    vi.mocked(fs.renameSync).mockImplementation(((from: string, to: string) => {
      if (to === dest && String(from).includes('.staged-')) throw Object.assign(new Error('EPERM: staged held'), { code: 'EPERM' });
      if (to === dest && String(from).includes('.previous-')) throw Object.assign(new Error('EBUSY: undo failed'), { code: 'EBUSY' });
      return realFs.renameSync(from, to);
    }) as never);
    const result = await prepare();
    expect(result.binary).toBeNull();
    expect(result.reason).toContain('EPERM: staged held');
    expect(result.reason).not.toContain('EBUSY');
    const asides = () => realFs.readdirSync(dir).filter((f) => f.includes('.previous-'));
    expect(realFs.existsSync(dest)).toBe(false);
    expect(asides()).toHaveLength(1);
    // The next run sweeps first, but never the only good copy while the name
    // is empty; v2's recorded pass then installs it without a probe.
    vi.mocked(fs.renameSync).mockImplementation(realFs.renameSync as never);
    expect(await prepare()).toEqual({ binary: dest });
    expect(realFs.readFileSync(dest, 'utf8')).toBe('good v2 wmux-managed: native-hooks');
    expect(asides()).toHaveLength(1);
    // With the name filled again, the aside is swept.
    await prepare();
    expect(asides()).toEqual([]);
  });
});

describe('lockDir — taking over a stale lock', () => {
  it('never removes the lock another waiter took over first: two waiters, one dead lock', async () => {
    // W1 already took the dead lock over and holds a fresh one; W2 still
    // reads the dead lock it judged, right up to its takeover.
    const dead = `999999999 ${Date.now()} w0`;
    const fresh = `${process.pid} ${Date.now()} w1`;
    realFs.writeFileSync(lockFile(), fresh);
    vi.mocked(fs.readFileSync).mockImplementation(((...args: unknown[]) =>
      String(args[0]) === lockFile() ? dead : (realFs.readFileSync as (...a: unknown[]) => unknown)(...args)) as never);
    expect(await lockDir(dir, { waitMs: 200, pollMs: 50 })).toBeNull();
    expect(realFs.readFileSync(lockFile(), 'utf8')).toBe(fresh);
    expect(realFs.readdirSync(dir)).toEqual([PROBE_LOCK]);
  });
});

describe('lockDir — every way round the loop waits and keeps the deadline', () => {
  it('a held lock that cannot be read (a root-owned file, a directory)', async () => {
    realFs.writeFileSync(lockFile(), 'unreadable');
    fail('readFileSync', (p) => p === lockFile(), 'EACCES');
    const calls = countLockAttempts();
    const started = Date.now();
    expect(await lockDir(dir, { waitMs: 300, pollMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(calls()).toBeLessThan(50);
  });

  it('a stale lock that cannot be removed (held by an antivirus scan)', async () => {
    realFs.writeFileSync(lockFile(), `999999999 ${Date.now() - 60_000} other`);
    fail('unlinkSync', (p) => p === lockFile(), 'EBUSY');
    vi.mocked(fs.renameSync).mockImplementation(((...args: unknown[]) => {
      if (String(args[0]) === lockFile()) throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' });
      return (realFs.renameSync as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const calls = countLockAttempts();
    const started = Date.now();
    expect(await lockDir(dir, { waitMs: 300, pollMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(calls()).toBeLessThan(50);
  });
});
