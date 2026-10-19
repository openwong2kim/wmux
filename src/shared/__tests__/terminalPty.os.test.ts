import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { spawnTerminalPty, ptyBackend, bundledConptyPath, type TerminalPty } from '../terminalPty';
import path from 'node:path';
import { loadNativeTerminalCore, type NativeTerminalCore } from '../nativeTerminalCore';

vi.mock('../nativeTerminalCore', () => ({ loadNativeTerminalCore: vi.fn(), reportNativeFallback: vi.fn() }));
let wake: () => void;
const transport = { pid: 101, pendingInputBytes: 0, read: vi.fn(), write: vi.fn(), resize: vi.fn(), clear: vi.fn(), kill: vi.fn(), close: vi.fn() };
const nodeSpawn = vi.fn(() => ({ pid: 202 }) as IPty);
const idle = { data: Buffer.alloc(0), eof: false, childExited: false, pendingInputBytes: 0 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('WMUX_TERMINAL_CORE', 'rust');
  transport.read.mockReturnValue(idle);
  vi.mocked(loadNativeTerminalCore).mockReturnValue({ NativeTransport: class {
    constructor(_command: string, _args: string[], _cwd: string, _env: object, _cols: number, _rows: number, callback: () => void) { wake = callback; return transport; }
  } } as unknown as NativeTerminalCore);
});
afterEach(() => vi.unstubAllEnvs());
describe('terminal backend selection and transport contract', () => {
  it('resolves bundled ConPTY outside Electron ASAR', () => {
    expect(bundledConptyPath(path.join('/resources', 'app.asar', 'node_modules', 'node-pty', 'package.json'), 'x64'))
      .toBe(path.join('/resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty', 'conpty.dll'));
  });
  it('keeps node-pty authoritative without an explicit opt-in', () => {
    vi.stubEnv('WMUX_TERMINAL_CORE', '');
    expect(ptyBackend(spawnTerminalPty('sh', [], {}, nodeSpawn))).toBe('node');
    expect(loadNativeTerminalCore).not.toHaveBeenCalled();
  });
  it('falls back on a loader error before spawning', () => {
    vi.mocked(loadNativeTerminalCore).mockImplementation(() => { throw new Error('ABI mismatch'); });
    spawnTerminalPty('sh', [], {}, nodeSpawn);
    expect(nodeSpawn).toHaveBeenCalledOnce();
  });
  it('never executes a second command when the native spawn fails', () => {
    vi.mocked(loadNativeTerminalCore).mockReturnValue({ NativeTransport: class { constructor() { throw new Error('spawn failed'); } } } as unknown as NativeTerminalCore);
    expect(() => spawnTerminalPty('sh', [], {}, nodeSpawn)).toThrow('spawn failed');
    expect(nodeSpawn).not.toHaveBeenCalled();
  });
  it('contains a catchable native read fault within the affected session', async () => {
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn); const exit = vi.fn(); pty.onExit(exit);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    transport.read.mockImplementation(() => { throw new Error('native read failed'); });
    try {
      wake(); await tick(); wake(); await tick();
      expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 1 }); expect(transport.close).toHaveBeenCalledOnce();
      expect(nodeSpawn).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it('decodes split UTF-8 and delivers all tail output before exactly one exit', async () => {
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn);
    const bytes = Buffer.from('한글🙂'); const events: string[] = [];
    transport.read.mockReturnValueOnce({ ...idle, data: bytes.subarray(0, 2) })
      .mockReturnValueOnce({ ...idle, data: bytes.subarray(2), childExited: true, eof: true, exitCode: 7 });
    pty.onData(text => events.push(text)); pty.onExit(event => events.push(`exit:${event.exitCode}`));
    await tick(); await tick(); wake(); await tick();
    expect(events).toEqual(['한글🙂', 'exit:7']); expect(transport.close).toHaveBeenCalledOnce();
  });
  it('observes exit without requiring a data subscriber', async () => {
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn); const exit = vi.fn(); pty.onExit(exit);
    transport.read.mockReturnValue({ ...idle, eof: true, childExited: true, exitCode: 0 });
    wake(); await tick(); expect(exit).toHaveBeenCalledOnce();
  });
  it('resumes a paused stream to drain final output after child exit', async () => {
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn); pty.pause();
    transport.read.mockReturnValueOnce({ ...idle, childExited: true });
    wake(); await tick(); await tick();
    expect(transport.read).toHaveBeenNthCalledWith(1, true);
    expect(transport.read).toHaveBeenNthCalledWith(2, false);
  });
  it('does not swallow input backpressure or change dimensions on failed resize', () => {
    const pty = spawnTerminalPty('sh', [], { cols: 80, rows: 24 }, nodeSpawn);
    transport.write.mockImplementation(() => { throw new Error('PTY_BACKPRESSURE'); });
    expect(() => pty.write('input')).toThrow('PTY_BACKPRESSURE');
    transport.resize.mockImplementation(() => { throw new Error('resize failed'); });
    expect(() => pty.resize(100, 40)).toThrow(); expect(pty.cols).toBe(80);
  });
});


describe('native output chunks', () => {
  it('delivers a native chunk and disposes it before the exit callback', async () => {
    const order: string[] = [];
    const chunk = { text: '한글', byteLength: 6, readBytes: vi.fn(() => Buffer.from('한글')), dispose: vi.fn(() => order.push('dispose')) };
    const readChunk = vi.fn().mockReturnValueOnce({ ...idle, chunk, bytesRead: 6, childExited: true, exitCode: 0 });
    vi.mocked(loadNativeTerminalCore).mockReturnValue({ NativeTransport: class {
      constructor(_c: string, _a: string[], _cwd: string, _env: object, _cols: number, _rows: number, callback: () => void) {
        wake = callback; return { ...transport, readChunk };
      }
    } } as unknown as NativeTerminalCore);
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn) as TerminalPty;
    pty.onNativeData?.(value => { expect(value).toBe(chunk); order.push('data'); });
    pty.onExit(() => order.push('exit'));
    await tick(); await tick();
    expect(order).toEqual(['data', 'dispose', 'exit']);
    expect(chunk.readBytes).not.toHaveBeenCalled(); expect(transport.read).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledOnce();
  });
});
