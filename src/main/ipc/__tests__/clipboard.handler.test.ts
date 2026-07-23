import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * clipboard.handler — verifies that CLIPBOARD_WRITE surfaces failures
 * (invalid type, oversize, write failure) as thrown errors so the renderer
 * can react instead of silently showing "copied" toasts.
 *
 * CLIPBOARD_READ — on macOS Finder file copy (text/uri-list present), resolves absolute
 * POSIX path via osascript, falls back to readText() on failure, and verifies no spawn
 * when gate fails (other OS / plain text).
 */

// ── Module mocks (hoisted; cannot reference outer test variables) ──────────

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const writeText = vi.fn();
  const readText = vi.fn(() => 'hello');
  const availableFormats = vi.fn(() => [] as string[]);
  const read = vi.fn(() => '' as string);
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  return {
    ipcMain,
    clipboard: {
      writeText,
      readText,
      readImage: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.from([]) })),
      availableFormats,
      read,
    },
    app: { getPath: vi.fn(() => '/tmp') },
    // Expose registered handlers + clipboard.writeText for tests
    __handlers: handlers,
    __writeText: writeText,
    __readText: readText,
    __availableFormats: availableFormats,
    __read: read,
  };
});

vi.mock('fs', () => ({
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock osascript shell-out boundary — simulate success/failure/empty output without spawning.
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});

import * as electron from 'electron';
import { execFile } from 'node:child_process';
import { registerClipboardHandlers } from '../handlers/clipboard.handler';
import { IPC } from '../../../shared/constants';

// Pull the test fixtures back out of the mocked module
const handlers = (electron as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> }).__handlers;
const writeText = (electron as unknown as { __writeText: ReturnType<typeof vi.fn> }).__writeText;
const readText = (electron as unknown as { __readText: ReturnType<typeof vi.fn> }).__readText;
const availableFormats = (electron as unknown as { __availableFormats: ReturnType<typeof vi.fn> }).__availableFormats;
const pasteboardRead = (electron as unknown as { __read: ReturnType<typeof vi.fn> }).__read;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

// execFile(file, args, opts, cb) callback signature
type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;

// Simulate success case where osascript prints given string to stdout
function mockResolverStdout(stdout: string): void {
  execFileMock.mockImplementation(
    (_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecFileCb)(null, stdout, '');
    }
  );
}

// Change process.platform per test; restored in afterEach
const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn;
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  handlers.clear();
  writeText.mockReset();
  readText.mockReset();
  readText.mockReturnValue('hello');
  availableFormats.mockReset();
  availableFormats.mockReturnValue([] as string[]);
  pasteboardRead.mockReset();
  pasteboardRead.mockReturnValue('');
  execFileMock.mockReset();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  registerClipboardHandlers();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  stderrSpy.mockRestore();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CLIPBOARD_WRITE — error surfacing', () => {
  it('writes text to the clipboard on the happy path', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    await expect(handler({} as never, 'hello world')).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('hello world');
  });

  it('throws CLIPBOARD_INVALID_TYPE on non-string input (no silent return)', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    await expect(handler({} as never, 12345 as unknown as string))
      .rejects.toThrow(/CLIPBOARD_INVALID_TYPE/);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('throws CLIPBOARD_INVALID_TYPE on undefined', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    await expect(handler({} as never, undefined as unknown as string))
      .rejects.toThrow(/CLIPBOARD_INVALID_TYPE/);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('throws CLIPBOARD_TOO_LARGE when payload exceeds 1MB', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    const huge = 'x'.repeat(1_000_001);
    await expect(handler({} as never, huge))
      .rejects.toThrow(/CLIPBOARD_TOO_LARGE/);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('accepts payloads exactly at the 1MB boundary', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    const oneMb = 'x'.repeat(1_000_000);
    await expect(handler({} as never, oneMb)).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith(oneMb);
  });

  it('throws CLIPBOARD_WRITE_FAILED when underlying clipboard.writeText throws', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    writeText.mockImplementationOnce(() => {
      throw new Error('OpenClipboard failed: 0x800401D0');
    });
    await expect(handler({} as never, 'payload'))
      .rejects.toThrow(/CLIPBOARD_WRITE_FAILED.*OpenClipboard failed/);
  });

  it('CLIPBOARD_READ still works (sanity)', async () => {
    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
  });
});

describe('CLIPBOARD_READ — macOS Finder file-copy path resolution', () => {
  it('darwin fast path: public.file-url resolves WITHOUT osascript (the paste-delay fix)', async () => {
    setPlatform('darwin');
    pasteboardRead.mockReturnValue('file:///Users/foo/project/out/wmux-darwin-arm64/');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    // Directory trailing slash preserved as macOS provided it
    await expect(handler({} as never)).resolves.toBe('/Users/foo/project/out/wmux-darwin-arm64/');
    // Fast path: must not spawn osascript (per-paste spawn was the latency culprit)
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
  });

  it('darwin opaque bookmark (file:///.file/id=) falls back to the osascript resolver', async () => {
    setPlatform('darwin');
    pasteboardRead.mockReturnValue('file:///.file/id=6571367.8927864');
    mockResolverStdout('/Users/foo/project/out/wmux-darwin-arm64/\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('/Users/foo/project/out/wmux-darwin-arm64/');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe('/usr/bin/osascript');
  });

  it('darwin fast path NFC-normalizes NFD Korean folder names (Hangul path corruption)', async () => {
    setPlatform('darwin');
    const nfd = '한글'.normalize('NFD');
    pasteboardRead.mockReturnValue('file:///Users/foo/' + encodeURIComponent(nfd));

    const handler = getHandler(IPC.CLIPBOARD_READ);
    // Korean is outside SAFE_PATH_RE → single-quote for pty. Key assertion: inside quotes
    // is NFC composed form — NFD would decompose jamo into a different string.
    await expect(handler({} as never)).resolves.toBe("'/Users/foo/한글'");
  });

  it('darwin readText fallback NFC-normalizes NFD text (Finder copy path name)', async () => {
    setPlatform('darwin');
    readText.mockReturnValue('/Users/foo/한글'.normalize('NFD'));

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('/Users/foo/한글');
  });

  it('single-quotes the resolved path when it contains spaces', async () => {
    setPlatform('darwin');
    pasteboardRead.mockReturnValue('file:///.file/id=1');
    mockResolverStdout('/Users/foo/My Folder/file.txt\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe("'/Users/foo/My Folder/file.txt'");
  });

  it('neutralizes shell metacharacters in filenames ($, backtick, ", ;) via single-quoting', async () => {
    // Finder filenames are untrusted input entering the shell boundary — double quotes
    // still interpret $ and backticks (CodeRabbit). Inside single quotes all literal.
    setPlatform('darwin');
    pasteboardRead.mockReturnValue('file:///.file/id=1');
    mockResolverStdout('/Users/foo/we$ird `name";dir\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe(`'/Users/foo/we$ird \`name";dir'`);
  });

  it("escapes embedded single quotes with the POSIX '\\'' idiom", async () => {
    setPlatform('darwin');
    pasteboardRead.mockReturnValue('file:///.file/id=1');
    mockResolverStdout("/Users/foo/it's here\n");

    const handler = getHandler(IPC.CLIPBOARD_READ);
    // '...' closes at ', then \' literal, then reopens ': 'it'\''s here'
    await expect(handler({} as never)).resolves.toBe(`'/Users/foo/it'\\''s here'`);
  });

  it('falls back to readText when the resolver fails (non-zero exit / timeout)', async () => {
    setPlatform('darwin');
    pasteboardRead.mockReturnValue('file:///.file/id=1');
    execFileMock.mockImplementation(
      (_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecFileCb)(new Error('osascript timed out'), '', '');
      }
    );

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('falls back to readText when output is empty (browser URL exposes uri-list but no «class furl»)', async () => {
    setPlatform('darwin');
    pasteboardRead.mockReturnValue('file:///.file/id=1');
    // furl guard script returns empty for non-file clipboard (browser URL copy, etc.)
    mockResolverStdout('\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('falls back to readText when output is not an absolute path', async () => {
    setPlatform('darwin');
    pasteboardRead.mockReturnValue('file:///.file/id=1');
    mockResolverStdout('garbage-not-a-path\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
  });

  it('non-darwin → readText untouched and resolver is never spawned', async () => {
    setPlatform('linux');
    // Even with file-url slot, darwin gate cuts first
    pasteboardRead.mockReturnValue('file:///home/foo/x');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('darwin plain text copy (no file-url slot) → readText, no osascript spawn', async () => {
    setPlatform('darwin');
    pasteboardRead.mockReturnValue('');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
    // availableFormats remains for "check file when native read is empty" (Codex: clipboard
    // API versions that cannot read UTI must not degrade file paste to basename text).
    // What we guarantee here is no spawn — osascript is the latency culprit.
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
