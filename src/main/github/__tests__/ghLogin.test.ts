// GhLogin: the headless `gh auth login --web` run (child process mocked,
// fake timers): the device code, Enter, status polling, timeout, failures,
// one login at a time and cancel.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { GhLogin, ghLoginEnv, CODE_WAIT_MS, EXIT_GRACE_MS, POLL_MS, type GhLoginDeps, type LoginChild } from '../ghLogin';
import { GH_DEVICE_URL, GH_LOGIN_TIMEOUT_MS, type GhLoginEvent } from '../../../shared/ghDeviceLogin';

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  written = '';
  kill = vi.fn(() => {
    if (this.exitCode === null) { this.exitCode = 143; this.emit('exit', null, 'SIGTERM'); }
    return true;
  });
  constructor() {
    super();
    this.stdin.on('data', (d) => { this.written += String(d); });
  }
  out(text: string, stream: 'stderr' | 'stdout' = 'stderr') { this[stream].write(text); }
  exit(code: number) { this.exitCode = code; this.emit('exit', code, null); }
}

function setup(opts: { spawnError?: NodeJS.ErrnoException; platform?: NodeJS.Platform } = {}) {
  const children: FakeChild[] = [];
  let statusOk = false;
  const spawn = vi.fn((_cmd: string, _args: string[], _o: unknown) => {
    const c = new FakeChild();
    children.push(c);
    queueMicrotask(() => (opts.spawnError ? c.emit('error', opts.spawnError) : c.emit('spawn')));
    return c as unknown as LoginChild;
  });
  const exec = vi.fn(async () => {
    if (!statusOk) throw new Error('not logged in');
    return { stdout: '' };
  });
  const regate = vi.fn(async () => ({ ok: true }));
  const deps: GhLoginDeps = { spawn, exec, regate, platform: opts.platform ?? 'darwin', cwd: () => '/home/u' };
  const login = new GhLogin(deps);
  const events: GhLoginEvent[] = [];
  login.onEvent((e) => events.push(e));
  return { login, events, spawn, exec, regate, children, setStatus: (v: boolean) => { statusOk = v; } };
}

const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('GhLogin', () => {
  it('spawns gh auth login --web headless, prompts allowed, no browser', async () => {
    const s = setup();
    expect(await s.login.start()).toEqual({ ok: true });
    const [cmd, args, o] = s.spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; stdio: string[] }];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https']);
    expect(o.env.GH_PROMPT_DISABLED).toBeUndefined();
    expect(o.env.GH_BROWSER).toBe('true');
    expect(o.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('uses gh.exe on Windows and leaves the browser setting alone', async () => {
    const s = setup({ platform: 'win32' });
    await s.login.start();
    expect(s.spawn.mock.calls[0][0]).toBe('gh.exe');
    expect(ghLoginEnv('win32').GH_BROWSER).toBeUndefined();
  });

  it('emits the code once, even split across coloured chunks', async () => {
    const s = setup();
    await s.login.start();
    const c = s.children[0];
    c.out('\x1b[0;33m!\x1b[0m First copy your one-time code: \x1b[1mAB');
    await tick();
    expect(s.events).toEqual([]);
    c.out('CD-12');
    c.out('34\x1b[0m\n');
    await tick();
    c.out('Open this URL to continue in your web browser: https://github.com/login/device\n');
    c.out('! First copy your one-time code: ABCD-1234\n');
    await tick();
    expect(s.events).toEqual([{ kind: 'code', code: 'ABCD-1234', url: GH_DEVICE_URL }]);
  });

  it('reads Windows CRLF output and a localized label from stdout', async () => {
    const s = setup({ platform: 'win32' });
    await s.login.start();
    s.children[0].out('! 일회용 코드를 복사하세요: WXYZ-9876\r\nOpen this URL ...\r\n', 'stdout');
    await tick();
    expect(s.events).toEqual([{ kind: 'code', code: 'WXYZ-9876', url: GH_DEVICE_URL }]);
  });

  it('feeds Enter once when gh asks for it', async () => {
    const s = setup();
    await s.login.start();
    const c = s.children[0];
    c.out('! First copy your one-time code: ABCD-1234\n');
    c.out('Press Enter to open https://github.com/login/device in your browser... ');
    await tick();
    c.out('\n');
    await tick();
    expect(c.written).toBe('\n');
  });

  it('polls gh auth status until it passes → done, gate re-probed, gh given a grace exit', async () => {
    const s = setup();
    await s.login.start();
    const c = s.children[0];
    c.out('! First copy your one-time code: ABCD-1234\n');
    await tick();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(s.exec).toHaveBeenCalledTimes(2);
    expect(s.exec.mock.calls[0]).toEqual(['gh', ['auth', 'status', '--hostname', 'github.com'], expect.objectContaining({ windowsHide: true })]);
    s.setStatus(true);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(s.events.at(-1)).toEqual({ kind: 'done' });
    expect(s.regate).toHaveBeenCalledTimes(1);
    expect(s.login.running).toBe(false);
    expect(c.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS);
    expect(c.kill).toHaveBeenCalledTimes(1);
    // Polling stopped.
    const n = s.exec.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(s.exec.mock.calls.length).toBe(n);
  });

  it('gh exiting 0 after success is confirmed by one status check', async () => {
    const s = setup();
    await s.login.start();
    const c = s.children[0];
    c.out('! First copy your one-time code: ABCD-1234\n');
    await tick();
    s.setStatus(true);
    c.out('✓ Authentication complete.\n');
    c.exit(0);
    await tick();
    expect(s.events.filter((e) => e.kind === 'done')).toHaveLength(1);
  });

  it('times out after 10 minutes and kills gh', async () => {
    const s = setup();
    await s.login.start();
    const c = s.children[0];
    c.out('! First copy your one-time code: ABCD-1234\n');
    await tick();
    await vi.advanceTimersByTimeAsync(GH_LOGIN_TIMEOUT_MS);
    expect(s.events.at(-1)).toEqual({ kind: 'timeout' });
    expect(c.kill).toHaveBeenCalled();
    expect(s.login.running).toBe(false);
  });

  it('no code within the window → failed with fallback, gh killed', async () => {
    const s = setup();
    await s.login.start();
    s.children[0].out('some unexpected prompt\n');
    await vi.advanceTimersByTimeAsync(CODE_WAIT_MS);
    expect(s.events).toEqual([{ kind: 'failed', message: 'gh did not show a sign-in code', fallback: true }]);
    expect(s.children[0].kill).toHaveBeenCalled();
  });

  it('the code clears the no-code timer', async () => {
    const s = setup();
    await s.login.start();
    s.children[0].out('! First copy your one-time code: ABCD-1234\n');
    await vi.advanceTimersByTimeAsync(CODE_WAIT_MS + 1000);
    expect(s.events.some((e) => e.kind === 'failed')).toBe(false);
  });

  it('a non-zero exit → failed with gh\'s last words and fallback', async () => {
    const s = setup();
    await s.login.start();
    const c = s.children[0];
    c.out('! First copy your one-time code: ABCD-1234\n');
    c.out('\x1b[31mX\x1b[0m failed to authenticate: access_denied\n');
    await tick();
    c.exit(1);
    expect(s.events.at(-1)).toEqual({ kind: 'failed', message: expect.stringContaining('access_denied'), fallback: true });
    expect(s.login.running).toBe(false);
  });

  it('gh missing → ok:false without fallback', async () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const s = setup({ spawnError: err });
    expect(await s.login.start()).toEqual({ ok: false, message: expect.any(String), fallback: false });
    expect(s.events).toEqual([]);
    expect(s.login.running).toBe(false);
  });

  it('another spawn error → ok:false with fallback', async () => {
    const err = Object.assign(new Error('spawn gh EACCES'), { code: 'EACCES' });
    const s = setup({ spawnError: err });
    expect(await s.login.start()).toEqual({ ok: false, message: 'spawn gh EACCES', fallback: true });
  });

  it('a second start reuses the running login and re-sends its code', async () => {
    const s = setup();
    await s.login.start();
    s.children[0].out('! First copy your one-time code: ABCD-1234\n');
    await tick();
    expect(await s.login.start()).toEqual({ ok: true });
    await tick();
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.events.filter((e) => e.kind === 'code')).toHaveLength(2);
  });

  it('cancel kills gh, stops polling and drops a status answer in flight', async () => {
    const s = setup();
    let release: (() => void) | null = null;
    s.exec.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ stdout: '' }); }));
    await s.login.start();
    const c = s.children[0];
    c.out('! First copy your one-time code: ABCD-1234\n');
    await tick();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(s.exec).toHaveBeenCalledTimes(1);
    s.login.cancel();
    expect(c.kill).toHaveBeenCalledTimes(1);
    release!();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(s.events.filter((e) => e.kind !== 'code')).toEqual([]);
    expect(s.exec).toHaveBeenCalledTimes(1);
    expect(s.regate).not.toHaveBeenCalled();
    // A new login can start afterwards.
    await s.login.start();
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });
});
