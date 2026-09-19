import { describe, it, expect, vi, beforeEach } from 'vitest';
const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: exec }));
import { resolveWslCwd, WSL_CWD_MISSING_MARKER, WSL_CWD_PROBE, WSL_PROBE_TIMEOUT_MS, isWslCwdMissingError } from '../wsl';

type Callback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;
/**
 * Answer a pending probe the way node's execFile does: raw Buffers when the
 * caller asked for `encoding: 'buffer'`, decoded strings for any other
 * encoding. Honouring the requested encoding is what lets the #1390 tests
 * below exercise the real decoding path instead of the mock's preference.
 */
const respond = (call: number, stdout: Buffer, stderr: Buffer, error: Error | null = null) => {
  const { encoding } = exec.mock.calls[call][2] as { encoding: BufferEncoding | 'buffer' };
  const shape = (bytes: Buffer) => (encoding === 'buffer' ? bytes : bytes.toString(encoding));
  (exec.mock.calls[call][3] as Callback)(error, shape(stdout), shape(stderr));
};
const finish = (call: number, cwd = '/project') =>
  respond(call, Buffer.from(`Ubuntu\0user\0${cwd}\0`, 'utf8'), Buffer.alloc(0));
beforeEach(() => exec.mockReset());

describe('asynchronous WSL probes', () => {
  it('coalesces simultaneous requests without blocking the event loop or caching stale cwd validity', async () => {
    const first = resolveWslCwd('wsl.exe', '/project');
    const second = resolveWslCwd('wsl.exe', '/project');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][2].timeout).toBe(WSL_PROBE_TIMEOUT_MS);
    let ticked = false;
    await new Promise<void>((resolve) => setTimeout(() => { ticked = true; resolve(); }, 1));
    expect(ticked).toBe(true);
    finish(0);
    expect(await first).toEqual(await second);
    const retry = resolveWslCwd('wsl.exe', '/project');
    expect(exec).toHaveBeenCalledTimes(2);
    finish(1); await retry;
  });

  it('starts distinct targets concurrently and evicts failed probes for retry', async () => {
    const failed = resolveWslCwd('wsl.exe', '/missing');
    const other = resolveWslCwd('wsl.exe', '/other', { distribution: 'Other', user: 'user' });
    expect(exec).toHaveBeenCalledTimes(2);
    const rejection = expect(failed).rejects.toThrow('directory missing');
    respond(0, Buffer.alloc(0), Buffer.from('directory missing', 'utf8'), new Error('failed'));
    finish(1, '/other'); await other; await rejection;
    const retry = resolveWslCwd('wsl.exe', '/missing');
    expect(exec).toHaveBeenCalledTimes(3);
    finish(2, '/missing'); await retry;
  });
});

// #1305 — a directory that is gone is not "check the distro and retry": every
// retry fails identically until it comes back, so the caller is told which
// failure this is and can offer starting fresh in the home directory instead.
describe('a missing working directory', () => {
  it('is what the probe itself reports, not something read out of cd\'s wording', () => {
    // The marker is printed by the probe before `cd` ever runs, so the
    // classification does not depend on the shell's (localized) message.
    expect(WSL_CWD_PROBE).toContain(`printf '${WSL_CWD_MISSING_MARKER}: %s`);
    expect(WSL_CWD_PROBE.indexOf(WSL_CWD_MISSING_MARKER)).toBeLessThan(WSL_CWD_PROBE.indexOf('cd -- '));
  });

  it('is flagged and named, with no "check the distro" advice that cannot help', async () => {
    const failed = resolveWslCwd('wsl.exe', '/home/dev/gone', { distribution: 'Ubuntu', user: 'dev' });
    const caught = failed.catch((error: unknown) => error);
    respond(0, Buffer.alloc(0), Buffer.from(`${WSL_CWD_MISSING_MARKER}: /home/dev/gone\n`, 'utf8'), new Error('Command failed'));

    const error = await caught;
    expect(isWslCwdMissingError(error)).toBe(true);
    expect((error as Error).message).toContain('/home/dev/gone');
    expect((error as Error).message).toContain('no longer exists in Ubuntu');
    expect((error as Error).message).toContain('start fresh in your home directory');
    expect((error as Error).message).not.toContain('Check the distro');
    // The marker is plumbing; it must not be shown to anyone.
    expect((error as Error).message).not.toContain(WSL_CWD_MISSING_MARKER);
  });

  // #1305 — the start-fresh promote asks for '~' and lets the distribution
  // resolve it, because only it knows where home is. Pinned here so a later
  // tightening of the path predicate cannot quietly remove the one action a
  // pane with a missing directory has.
  it("accepts '~' as the directory, which is what starting fresh asks for", async () => {
    const resolved = resolveWslCwd('wsl.exe', '~', { distribution: 'Ubuntu', user: 'dev' });
    finish(0, '/home/dev');
    // The target is the distribution's OWN answer, not the one asked for.
    expect(await resolved).toEqual({ cwd: '/home/dev', target: { distribution: 'Ubuntu', user: 'user' } });
    // The probe is handed '~' verbatim: expanding it on the Windows side would
    // name the Windows home.
    expect(exec.mock.calls[0][1]).toContain('~');
  });

  it('leaves every other failure as the retryable kind it was', async () => {
    const failed = resolveWslCwd('wsl.exe', '/home/dev/project', { distribution: 'Ubuntu', user: 'dev' });
    const caught = failed.catch((error: unknown) => error);
    respond(0, Buffer.alloc(0), Buffer.from('The Windows Subsystem for Linux is not running', 'utf8'), new Error('Command failed'));

    const error = await caught;
    expect(isWslCwdMissingError(error)).toBe(false);
    expect((error as Error).message).toContain('Check the distro and directory, then retry');
  });
});

// #1390 — the probe reads BYTES. wsl.exe's own failure text is UTF-16LE and
// has to be decoded before it becomes the Error message the daemon stores in
// recoveryError and returns as SPAWN_FAILED; the Linux child's stdout is UTF-8
// with deliberate NUL separators and must never be sniffed as UTF-16.
describe('wsl.exe output decoding', () => {
  const NUL = String.fromCharCode(0);

  it('decodes a UTF-16LE spawn failure instead of storing interleaved NULs', async () => {
    const wslMessage = '지정된 이름의 배포가 없습니다.';
    const failed = resolveWslCwd('wsl.exe', '/project-utf16').catch((error: Error) => error.message);
    expect(exec.mock.calls[0][2].encoding).toBe('buffer');
    respond(0, Buffer.alloc(0), Buffer.from(`${wslMessage}\r\n`, 'utf16le'), new Error('Command failed'));
    const message = await failed;
    expect(message).toContain(wslMessage);
    expect(message).not.toContain(NUL);
  });

  it('decodes a UTF-16LE failure carrying a BOM', async () => {
    const wslMessage = 'There is no distribution with the supplied name.';
    const failed = resolveWslCwd('wsl.exe', '/project-bom').catch((error: Error) => error.message);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(wslMessage, 'utf16le')]);
    respond(0, Buffer.alloc(0), bytes, new Error('Command failed'));
    const message = await failed;
    expect(message).toContain(wslMessage);
    expect(message).not.toContain(NUL);
  });

  it('passes genuine UTF-8 failure text through unchanged', async () => {
    const wslMessage = 'wsl: 배포를 시작할 수 없습니다';
    const failed = resolveWslCwd('wsl.exe', '/project-utf8').catch((error: Error) => error.message);
    respond(0, Buffer.alloc(0), Buffer.from(wslMessage, 'utf8'), new Error('Command failed'));
    expect(await failed).toContain(wslMessage);
  });

  it('falls back to the exec error when wsl.exe printed nothing', async () => {
    const failed = resolveWslCwd('wsl.exe', '/project-silent').catch((error: Error) => error.message);
    respond(0, Buffer.alloc(0), Buffer.alloc(0), new Error('spawn wsl.exe ENOENT'));
    expect(await failed).toContain('spawn wsl.exe ENOENT');
  });

  it('keeps reading the NUL-separated probe stdout as UTF-8', async () => {
    const cwd = '/home/개발자/프로젝트';
    const probe = resolveWslCwd('wsl.exe', cwd);
    respond(0, Buffer.from(`Ubuntu${NUL}개발자${NUL}${cwd}${NUL}`, 'utf8'), Buffer.alloc(0));
    expect(await probe).toEqual({ cwd, target: { distribution: 'Ubuntu', user: '개발자' } });
  });
});
