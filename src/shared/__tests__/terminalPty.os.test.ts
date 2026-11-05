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
  it('does not change dimensions on failed resize', () => {
    const pty = spawnTerminalPty('sh', [], { cols: 80, rows: 24 }, nodeSpawn);
    transport.resize.mockImplementation(() => { throw new Error('resize failed'); });
    expect(() => pty.resize(100, 40)).toThrow(); expect(pty.cols).toBe(80);
  });
});

// node-pty's write never throws: it queues behind the PTY and reports trouble
// asynchronously. Every daemon writer was written against that contract.
describe('RustPty input keeps the node-pty write contract', () => {
  const MiB = 1024 * 1024;
  /** The native input queue (native_transport.rs write): all-or-nothing against its limit. */
  function nativeInput(limit = 8 * MiB) {
    const state = { pending: 0, closed: false, received: [] as Buffer[] };
    transport.write.mockImplementation((data: Uint8Array) => {
      if (state.closed) throw new Error('PTY_CLOSED');
      if (state.pending + data.length > limit) throw new Error('PTY_BACKPRESSURE: input queue is full');
      state.pending += data.length; state.received.push(Buffer.from(data));
    });
    Object.defineProperty(transport, 'pendingInputBytes', { configurable: true, get: () => state.pending });
    transport.read.mockImplementation(() => ({ ...idle, pendingInputBytes: state.pending }));
    return { state, bytes: () => Buffer.concat(state.received), text: () => Buffer.concat(state.received).toString() };
  }
  afterEach(() => { Object.defineProperty(transport, 'pendingInputBytes', { configurable: true, enumerable: true, writable: true, value: 0 }); });

  it('drops a write after exit instead of throwing', async () => {
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn);
    transport.read.mockReturnValue({ ...idle, eof: true, childExited: true, exitCode: 0 });
    wake(); await tick();
    expect(() => pty.write('late\r')).not.toThrow();
    expect(transport.write).not.toHaveBeenCalled();
  });

  it('drops input once the native writer has closed, before the exit is observed', () => {
    const input = nativeInput(); input.state.closed = true;
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn);
    expect(() => pty.write('a')).not.toThrow();
    expect(() => pty.write('b')).not.toThrow();
    // The closed side is final: nothing is retried or held.
    expect(transport.write).toHaveBeenCalledOnce();
    expect((pty as TerminalPty).pendingInputBytes).toBe(0);
  });

  it('queues input under backpressure and delivers it in order once the native queue drains', async () => {
    const input = nativeInput(4);
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn) as TerminalPty;
    pty.write('abc');
    expect(() => pty.write('def')).not.toThrow();
    // The native queue has room for this byte, but it must not overtake 'def'.
    pty.write(Buffer.from('g'));
    expect(input.text()).toBe('abc');
    expect(pty.pendingInputBytes).toBe(3 + 4);
    input.state.pending = 0; wake(); await tick();
    expect(input.text()).toBe('abcdefg');
    expect(pty.pendingInputBytes).toBe(4);
  });

  it('splits a write larger than the native queue and keeps SessionPipe paused until the bytes drain', async () => {
    const input = nativeInput();
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn) as TerminalPty;
    const drained = vi.fn(); pty.onInputDrain?.(drained);
    const payload = Buffer.alloc(12 * MiB, 'p');
    expect(() => pty.write(payload)).not.toThrow();
    expect(input.state.pending).toBe(8 * MiB);
    // The SessionPipe resume threshold counts what the adapter still holds.
    expect(pty.pendingInputBytes).toBe(12 * MiB);
    wake(); await tick();
    expect(drained).not.toHaveBeenCalled();
    input.state.pending = 0; wake(); await tick();
    expect(input.bytes().equals(payload)).toBe(true);
    // The held 4 MiB just moved to the native queue and is still unread.
    expect(drained).not.toHaveBeenCalled();
    input.state.pending = 0; wake(); await tick();
    expect(drained).toHaveBeenCalled();
  });

  it('holds at most one queue bound of input and drops whole writes past it, logged once per stall', async () => {
    const input = nativeInput();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const pty = spawnTerminalPty('sh', [], {}, nodeSpawn) as TerminalPty;
      pty.write(Buffer.alloc(8 * MiB, 'a'));
      pty.write(Buffer.alloc(8 * MiB, 'b'));
      expect(pty.pendingInputBytes).toBe(16 * MiB);
      expect(() => pty.write('x')).not.toThrow();
      expect(() => pty.write('y')).not.toThrow();
      expect(pty.pendingInputBytes).toBe(16 * MiB);
      expect(log).toHaveBeenCalledOnce();
      input.state.pending = 0; wake(); await tick();
      // Drained: a later stall queues again instead of dropping.
      pty.write('z');
      input.state.pending = 0; wake(); await tick();
      const delivered = input.bytes();
      expect(delivered.length).toBe(16 * MiB + 1);
      expect(delivered.includes('x')).toBe(false); expect(delivered.includes('y')).toBe(false);
      expect(delivered.subarray(-1).toString()).toBe('z');
    } finally { log.mockRestore(); }
  });

  it('keeps dropping after a dropped write until the held queue empties, so no later write lands without it', async () => {
    const input = nativeInput();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const pty = spawnTerminalPty('sh', [], {}, nodeSpawn) as TerminalPty;
      pty.write(Buffer.alloc(8 * MiB, 'a'));
      pty.write(Buffer.alloc(8 * MiB, 'b'));
      pty.write('X');
      // The program reads one piece, and one held piece moves to the native queue.
      input.state.pending -= 256 * 1024; wake(); await tick();
      expect(pty.pendingInputBytes).toBe(16 * MiB - 256 * 1024);
      pty.write('\r');
      expect(pty.pendingInputBytes).toBe(16 * MiB - 256 * 1024);
      input.state.pending = 0; wake(); await tick();
      pty.write('Z');
      const delivered = input.bytes();
      expect(delivered.includes('X')).toBe(false); expect(delivered.includes('\r')).toBe(false);
      expect(delivered.subarray(-1).toString()).toBe('Z');
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  /** 'abc' reaches the native queue (limit 4), 'def' is held. */
  async function holdInput() {
    const input = nativeInput(4);
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn) as TerminalPty;
    pty.write('abc'); pty.write('def');
    expect(pty.pendingInputBytes).toBe(6);
    return { input, pty };
  }
  /** Nothing is held and nothing more reaches the transport. */
  async function expectReleased({ input, pty }: Awaited<ReturnType<typeof holdInput>>) {
    input.state.pending = 0;
    expect(pty.pendingInputBytes).toBe(0);
    const calls = transport.write.mock.calls.length;
    wake(); await tick(); pty.write('late');
    expect(transport.write).toHaveBeenCalledTimes(calls);
    expect(input.text()).toBe('abc');
  }

  it('releases held input on dispose', async () => {
    const held = await holdInput();
    held.pty.dispose?.();
    await expectReleased(held);
  });

  it('releases held input on exit', async () => {
    const held = await holdInput();
    transport.read.mockReturnValueOnce({ ...idle, pendingInputBytes: 3, eof: true, childExited: true, exitCode: 0 });
    wake(); await tick();
    await expectReleased(held);
  });

  it('releases held input when the transport fails', async () => {
    const held = await holdInput();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      transport.read.mockImplementationOnce(() => { throw new Error('native read failed'); });
      wake(); await tick();
      await expectReleased(held);
    } finally { log.mockRestore(); }
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

describe('RustPty console window owner (Windows sign-in pickers)', () => {
  const hwnd = Buffer.from([0x2a, 0x10, 0, 0, 0, 0, 0, 0]);
  afterEach(() => { delete (transport as { setParentWindow?: unknown }).setParentWindow; });

  it('forwards the window handle to the native transport and returns what it reports', () => {
    const setParentWindow = vi.fn(() => true);
    Object.assign(transport, { setParentWindow });
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn) as TerminalPty;
    expect(pty.setParentWindow?.(hwnd)).toBe(true);
    expect(setParentWindow).toHaveBeenCalledWith(hwnd);
  });

  it('hands the spawn-time handle to the native constructor, before the shell starts', () => {
    const received: unknown[] = [];
    vi.mocked(loadNativeTerminalCore).mockReturnValue({ NativeTransport: class {
      constructor(...args: unknown[]) { received.push(args[8]); return transport; }
    } } as unknown as NativeTerminalCore);
    spawnTerminalPty('sh', [], { parentWindow: hwnd }, nodeSpawn);
    spawnTerminalPty('sh', [], {}, nodeSpawn);
    expect(received).toEqual([hwnd, undefined]);
  });

  it('reports false on a native module built before the call', () => {
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn) as TerminalPty;
    expect(pty.setParentWindow?.(hwnd)).toBe(false);
  });

  it('reports false once the pty has ended, without touching the transport', async () => {
    const setParentWindow = vi.fn(() => true);
    Object.assign(transport, { setParentWindow });
    const pty = spawnTerminalPty('sh', [], {}, nodeSpawn) as TerminalPty;
    transport.read.mockReturnValue({ ...idle, eof: true, childExited: true, exitCode: 0 });
    wake(); await tick();
    expect(pty.setParentWindow?.(hwnd)).toBe(false);
    expect(setParentWindow).not.toHaveBeenCalled();
  });
});
