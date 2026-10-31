/**
 * Windows: put the CLI's stdout and stderr on the console they were meant for (#2672).
 *
 * wmux.exe is Electron run as Node, a GUI-subsystem program, and that breaks
 * its console output two ways:
 *   - With nothing redirected, Electron attaches to the parent console and
 *     points both streams at CONOUT$. Before Electron 45 that CONOUT$ was
 *     write-only: Node cannot read such a handle's console mode, takes it for a
 *     file and writes UTF-8 bytes, which the console decodes in its code page
 *     (949 garbles Korean). Electron 45 (Chromium 156) opens it for reading
 *     too, so Node sees a TTY and nothing here moves.
 *   - With a stream redirected (`> file`, `| more`, `2> file`), Electron does
 *     not attach, and the stream left on the console arrives as a NULL std
 *     handle: everything written to it is lost.
 *
 * A stream that is not already a TTY, a file or a pipe, and whose std handle
 * is the console or none at all, becomes a tty.WriteStream on CONOUT$ opened
 * for reading and writing: libuv writes that with WriteConsoleW, intact in any
 * code page. When CONOUT$ cannot be opened the process is attached to the
 * parent's console first, unless ELECTRON_NO_ATTACH_CONSOLE says not to. A
 * stream redirected to a file, a pipe or NUL is left alone, and any failure
 * leaves today's streams.
 *
 * Only Node's streams move: fds 1 and 2 cannot. libuv will not close fds 0-2
 * on Windows, and Electron's C runtime is linked in, out of reach of a dup2.
 * A child that should write where this process does takes `childStdio()`
 * rather than 'inherit'.
 *
 * This runs before anything else in the CLI (consoleStdioPrelude.ts), so no
 * module holds the stream it replaces.
 */
import fs from 'node:fs';
import tty from 'node:tty';
import type { StdioOptions } from 'node:child_process';

const CONOUT = '\\\\.\\CONOUT$';
/** GetStdHandle's STD_OUTPUT_HANDLE and STD_ERROR_HANDLE, as DWORDs. */
const STD_HANDLE = { 1: 0xfffffff5, 2: 0xfffffff4 } as const;
const ATTACH_PARENT_PROCESS = 0xffffffff;
/** GetStdHandle's failure value, as an address. */
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
/** NtQueryVolumeInformationFile's FileFsDeviceInformation, and its DeviceType for a console. */
const FILE_FS_DEVICE_INFORMATION = 4;
const FILE_DEVICE_CONSOLE = 0x50;

type StdFd = keyof typeof STD_HANDLE;
export type StdHandleKind = 'none' | 'console' | 'other';

/**
 * What a std handle is: none (NULL, zero or INVALID_HANDLE_VALUE: nothing was
 * handed over), the console, or anything else (a file, a pipe, NUL). `device`
 * reads the handle's DeviceType, or null when it cannot.
 */
export function classifyStdHandle(address: bigint | null, device: () => number | null): StdHandleKind {
  if (address === null || address === 0n || address === INVALID_HANDLE_VALUE) return 'none';
  return device() === FILE_DEVICE_CONSOLE ? 'console' : 'other';
}

interface Kernel {
  stdHandle(fd: StdFd): StdHandleKind;
  attachToParentConsole(): void;
}

type Koffi = {
  load(lib: string): { func(signature: string): (...args: unknown[]) => unknown };
  address(pointer: unknown): bigint;
};

/** koffi is native and ships beside this bundle; without it the CLI keeps today's streams. */
function loadKernel(): Kernel | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as Koffi;
    const kernel32 = koffi.load('kernel32.dll');
    const ntdll = koffi.load('ntdll.dll');
    const getStdHandle = kernel32.func('void * __stdcall GetStdHandle(uint32_t which)');
    const attachConsole = kernel32.func('int __stdcall AttachConsole(uint32_t pid)');
    const queryVolume = ntdll.func('int32_t __stdcall NtQueryVolumeInformationFile(void *handle, _Out_ uint8_t *status, _Out_ uint8_t *info, uint32_t length, int32_t infoClass)');
    return {
      stdHandle(fd) {
        try {
          const handle = getStdHandle(STD_HANDLE[fd]);
          return classifyStdHandle(handle === null ? null : koffi.address(handle), () => {
            const info = Buffer.alloc(8);
            return queryVolume(handle, Buffer.alloc(16), info, info.length, FILE_FS_DEVICE_INFORMATION) === 0 ? info.readUInt32LE(0) : null;
          });
        } catch {
          return 'other';
        }
      },
      attachToParentConsole() {
        try { attachConsole(ATTACH_PARENT_PROCESS); } catch { /* the open that follows tells */ }
      },
    };
  } catch (error) {
    if (process.env.WMUX_DEBUG) {
      fs.writeSync(2, `wmux: console output is not rerouted, koffi did not load: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return null;
  }
}

function openConsole(): number | undefined {
  try { return fs.openSync(CONOUT, 'r+'); } catch { return undefined; }
}

/** A TTY, a file or a pipe is where the stream belongs already. */
function settled(fd: StdFd): boolean {
  if (tty.isatty(fd)) return true;
  try {
    const stat = fs.fstatSync(fd);
    return stat.isFile() || stat.isFIFO();
  } catch {
    return false;
  }
}

/**
 * Node's own stdio setup (lib/internal/bootstrap/switches/is_main_thread.js):
 * `.end()`, `.destroy()` and a `pipe()` into it never close the fd.
 */
function keepOpen(this: tty.WriteStream, error: Error | null, callback: (error: Error | null) => void): void {
  callback(error);
  const stream = this as unknown as { _undestroy(): void; _writableState: { emitClose: boolean } };
  stream._undestroy();
  if (!stream._writableState.emitClose) process.nextTick(() => this.emit('close'));
}

function stdioStream(fd: number): tty.WriteStream {
  const stream = new tty.WriteStream(fd);
  Object.assign(stream, { fd, _isStdio: true, destroySoon: stream.destroy, _destroy: keepOpen });
  // A console that stops taking writes must not end the CLI with an unhandled 'error'.
  stream.on('error', () => { /* nothing to report it on */ });
  return stream;
}

const routed: Record<StdFd, number> = { 1: 1, 2: 2 };

/** stdio for a child that writes where this process does: 'inherit' would hand it fds 1 and 2 as they came. */
export function childStdio(): StdioOptions {
  return ['inherit', routed[1], routed[2]];
}

export function routeConsoleStdio(): void {
  if (process.platform !== 'win32') return;
  const candidates = ([1, 2] as const).filter((fd) => !settled(fd));
  if (candidates.length === 0) return;
  const kernel = loadKernel();
  if (!kernel) return;
  const targets = candidates.filter((fd) => kernel.stdHandle(fd) !== 'other');
  if (targets.length === 0) return;
  let fd = openConsole();
  if (fd === undefined && !process.env.ELECTRON_NO_ATTACH_CONSOLE) {
    kernel.attachToParentConsole();
    fd = openConsole();
  }
  for (const target of targets) {
    fd ??= openConsole();
    if (fd === undefined) return;
    let stream: tty.WriteStream;
    try {
      stream = stdioStream(fd);
    } catch {
      fs.closeSync(fd);
      return;
    }
    routed[target] = fd;
    fd = undefined;
    Object.defineProperty(process, target === 1 ? 'stdout' : 'stderr', { configurable: true, enumerable: true, get: () => stream });
  }
}
