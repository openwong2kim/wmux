import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * clipboard.handler — verifies that CLIPBOARD_WRITE surfaces failures
 * (invalid type, oversize, write failure) as thrown errors so the renderer
 * can react instead of silently showing "copied" toasts.
 *
 * CLIPBOARD_READ — macOS에서 Finder 파일 복사(text/uri-list 존재) 감지 시
 * osascript로 절대 POSIX 경로를 해석하고, 실패하면 readText()로 폴백하며,
 * 게이트를 통과하지 못하면(타 OS·일반 텍스트) 스폰 자체가 없음을 검증한다.
 */

// ── Module mocks (hoisted; cannot reference outer test variables) ──────────

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const writeText = vi.fn();
  const readText = vi.fn(() => 'hello');
  const availableFormats = vi.fn(() => [] as string[]);
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
    },
    app: { getPath: vi.fn(() => '/tmp') },
    // Expose registered handlers + clipboard.writeText for tests
    __handlers: handlers,
    __writeText: writeText,
    __readText: readText,
    __availableFormats: availableFormats,
  };
});

vi.mock('fs', () => ({
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// osascript 셸아웃 경계 모킹 — 실제 프로세스를 스폰하지 않고
// 성공/실패/빈 출력 시나리오를 시뮬레이션한다.
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
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

// execFile(file, args, opts, cb) 콜백 시그니처
type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;

// osascript가 stdout으로 주어진 문자열을 내놓는 성공 케이스를 시뮬레이션
function mockResolverStdout(stdout: string): void {
  execFileMock.mockImplementation(
    (_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecFileCb)(null, stdout, '');
    }
  );
}

// process.platform을 테스트별로 바꾸고 afterEach에서 원복한다
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
  it('darwin + text/uri-list + resolver success → returns absolute POSIX path (newline trimmed)', async () => {
    setPlatform('darwin');
    availableFormats.mockReturnValue(['text/plain', 'text/uri-list']);
    mockResolverStdout('/Users/foo/project/out/wmux-darwin-arm64/\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    // 디렉터리 trailing slash는 macOS가 준 그대로 유지된다
    await expect(handler({} as never)).resolves.toBe('/Users/foo/project/out/wmux-darwin-arm64/');
    // osascript는 절대경로 + 셸 인터폴레이션 없는 execFile로만 호출된다
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe('/usr/bin/osascript');
    // 경로가 해석됐으므로 이름만 주는 readText는 쓰이지 않는다
    expect(readText).not.toHaveBeenCalled();
  });

  it('single-quotes the resolved path when it contains spaces', async () => {
    setPlatform('darwin');
    availableFormats.mockReturnValue(['text/uri-list']);
    mockResolverStdout('/Users/foo/My Folder/file.txt\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe("'/Users/foo/My Folder/file.txt'");
  });

  it('neutralizes shell metacharacters in filenames ($, backtick, ", ;) via single-quoting', async () => {
    // Finder 파일명은 사용자 통제 밖 입력이 셸로 들어가는 경계 — 큰따옴표는 $·백틱을
    // 여전히 해석하므로 부족하다(CodeRabbit 지적). 단일따옴표 안은 전부 리터럴.
    setPlatform('darwin');
    availableFormats.mockReturnValue(['text/uri-list']);
    mockResolverStdout('/Users/foo/we$ird `name";dir\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe(`'/Users/foo/we$ird \`name";dir'`);
  });

  it("escapes embedded single quotes with the POSIX '\\'' idiom", async () => {
    setPlatform('darwin');
    availableFormats.mockReturnValue(['text/uri-list']);
    mockResolverStdout("/Users/foo/it's here\n");

    const handler = getHandler(IPC.CLIPBOARD_READ);
    // '...'가 '에서 닫히고 \' 리터럴을 잇고 다시 '로 열린다: 'it'\''s here'
    await expect(handler({} as never)).resolves.toBe(`'/Users/foo/it'\\''s here'`);
  });

  it('falls back to readText when the resolver fails (non-zero exit / timeout)', async () => {
    setPlatform('darwin');
    availableFormats.mockReturnValue(['text/uri-list']);
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
    availableFormats.mockReturnValue(['text/uri-list']);
    // furl 가드 스크립트는 비파일 클립보드(브라우저 URL 복사 등)에서 빈 문자열을 낸다
    mockResolverStdout('\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it('falls back to readText when output is not an absolute path', async () => {
    setPlatform('darwin');
    availableFormats.mockReturnValue(['text/uri-list']);
    mockResolverStdout('garbage-not-a-path\n');

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
  });

  it('non-darwin → readText untouched and resolver is never spawned', async () => {
    setPlatform('linux');
    // uri-list가 있어도 darwin 게이트가 먼저 컷한다
    availableFormats.mockReturnValue(['text/uri-list']);

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('darwin without text/uri-list (plain text copy) → readText, no spawn', async () => {
    setPlatform('darwin');
    availableFormats.mockReturnValue(['text/plain']);

    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
