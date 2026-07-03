import { ipcMain, clipboard, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';

// Paste temp files must outlive the next paste: consumers (e.g. Claude Code)
// read the pasted file path later, so deleting the previous file on each paste
// destroys earlier images when multiple are pasted (issue #201). Instead,
// sweep stale files older than MAX_PASTE_FILE_AGE_MS once at startup.
const MAX_PASTE_FILE_AGE_MS = 24 * 60 * 60 * 1000;

function cleanupStalePasteFiles(): void {
  const tempDir = app.getPath('temp');
  let entries: string[];
  try {
    entries = fs.readdirSync(tempDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_PASTE_FILE_AGE_MS;
  for (const name of entries) {
    if (!name.startsWith('wmux-paste-') || !name.endsWith('.png')) continue;
    const filePath = path.join(tempDir, name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch { /* file vanished or locked; skip */ }
  }
}

// macOS Finder에서 파일/폴더를 Cmd+C 하면 clipboard.readText()는 "이름"만 준다.
// 전체 절대경로는 public.file-url 슬롯의 불투명한 file:///.file/id= 참조에만
// 들어있는데, 이 참조는 순수 JS(fs.realpathSync)나 셸 stat으로 해석되지 않는다
// (ENOTDIR). AppleScript의 «class furl» 강제 변환만이 실제 POSIX 경로를 돌려주므로
// osascript로 셸아웃한다. 셸 인터폴레이션이 없도록 exec가 아닌 execFile를 쓰고,
// 명령은 사용자 입력을 받지 않는다(고정 스크립트).
const OSASCRIPT_PATH = '/usr/bin/osascript';
const OSASCRIPT_TIMEOUT_MS = 2000;

// Finder 파일명은 사용자 통제 밖 입력이 셸(pty)로 들어가는 경계다. 공백만 큰따옴표로
// 감싸는 방식은 부족하다 — 큰따옴표 안에서도 $·백틱은 셸이 해석하고, 이름에 " 자체가
// 있으면 인용이 깨진다(CodeRabbit 지적). POSIX 단일따옴표는 내부의 모든 문자를
// 리터럴로 만들므로(유일한 예외인 '는 '\''로 잇는다) 안전문자 외가 하나라도 있으면
// 단일따옴표로 감싼다. macOS 한정 분기라 대상 셸은 POSIX 계열(zsh/bash/fish)뿐이다.
const SAFE_PATH_RE = /^[A-Za-z0-9_\-./~+@%,:=]+$/;
function quotePathForPty(p: string): string {
  if (SAFE_PATH_RE.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * 클립보드에 있는 Finder 파일/폴더의 절대 POSIX 경로를 해석한다.
 *
 * clipboard info에 «class furl»가 실제로 존재할 때만 경로를 반환한다. 브라우저에서
 * URL을 복사하면 text/uri-list가 노출될 수 있는데, 그 경우 furl이 없어 빈 문자열이
 * 나오고 → 호출부가 readText() 폴백으로 떨어진다. (이 furl 가드가 없으면 URL이
 * "/https/::example.com:.." 같은 가비지 경로로 강제 변환되어 붙는다 — 라이브 프로브로 확인.)
 *
 * 한계: 여러 파일을 한꺼번에 복사하면 «class furl» 강제 변환은 "첫 번째" 항목만
 * 돌려준다(단일 항목 지원이 요구사항, 다중 선택은 범위 밖).
 *
 * 실패·타임아웃·비파일·빈 출력은 전부 null로 반환해 붙여넣기를 절대 악화시키지 않는다.
 */
function resolveFinderFilePath(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      OSASCRIPT_PATH,
      [
        '-e', 'set out to ""',
        '-e', 'repeat with t in (clipboard info)',
        '-e', 'if (first item of t) is «class furl» then',
        '-e', 'set out to POSIX path of (the clipboard as «class furl»)',
        '-e', 'exit repeat',
        '-e', 'end if',
        '-e', 'end repeat',
        '-e', 'return out',
      ],
      { timeout: OSASCRIPT_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        // osascript는 결과 끝에 개행을 붙인다 — 그것만 제거하고 경로는 그대로 둔다
        // (디렉터리의 뒤쪽 '/'는 macOS가 준 그대로 유지; cd에 문제없다).
        const filePath = (typeof stdout === 'string' ? stdout : '').replace(/\r?\n+$/, '');
        // 절대경로가 아니면(빈 값, 비파일 furl 결과 등) 신뢰하지 않고 폴백한다.
        resolve(filePath.startsWith('/') ? filePath : null);
      }
    );
  });
}

export function registerClipboardHandlers(): void {
  cleanupStalePasteFiles();

  // Remove any previously registered handlers before re-registering.
  // ipcMain.handle() throws if the same channel is registered twice (e.g.
  // during dev HMR reloads), which silently kills clipboard IPC.
  ipcMain.removeHandler(IPC.CLIPBOARD_WRITE);
  ipcMain.removeHandler(IPC.CLIPBOARD_READ);
  ipcMain.removeHandler(IPC.CLIPBOARD_READ_IMAGE);
  ipcMain.removeHandler(IPC.CLIPBOARD_HAS_IMAGE);

  ipcMain.handle(IPC.CLIPBOARD_WRITE, wrapHandler(IPC.CLIPBOARD_WRITE, (_event: Electron.IpcMainInvokeEvent, text: string) => {
    // Surface validation failures so renderer can react instead of silently
    // showing "copied" toasts when nothing actually reached the clipboard.
    if (typeof text !== 'string') {
      throw new Error('CLIPBOARD_INVALID_TYPE');
    }
    if (text.length > 1_000_000) {
      throw new Error('CLIPBOARD_TOO_LARGE');
    }
    try {
      clipboard.writeText(text);
    } catch (err) {
      // Win32 clipboard can fail under lock contention with other apps —
      // surface the underlying message so renderer can retry/notify.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CLIPBOARD_WRITE_FAILED: ${msg}`);
    }
  }));

  ipcMain.handle(IPC.CLIPBOARD_READ, wrapHandler(IPC.CLIPBOARD_READ, async (_event: Electron.IpcMainInvokeEvent) => {
    // 플랫폼 + 포맷 게이트: darwin이고 클립보드에 파일/폴더(text/uri-list)가 있을
    // 때만 경로 해석을 시도한다. 그 외(일반 텍스트, 타 OS)는 기존과 완전히 동일하게
    // readText()를 즉시 반환하므로 일반 붙여넣기의 지연·동작 변화는 0이다.
    if (
      process.platform === 'darwin' &&
      clipboard.availableFormats().includes('text/uri-list')
    ) {
      const filePath = await resolveFinderFilePath();
      if (filePath) {
        // 이 값을 소비하는 렌더러 호출부는 전부 터미널 붙여넣기 사이트라 문자열을
        // 그대로 pty에 쓴다(Terminal.tsx handlePaste, useTerminal.ts의 Cmd+V/
        // Ctrl+V/Ctrl+Shift+V/우클릭). 파일 해석 분기에서만 인용하며, 방식은
        // quotePathForPty 참고(공백뿐 아니라 $·백틱·" 등도 안전해야 한다).
        return quotePathForPty(filePath);
      }
      // 해석 실패(비파일 furl, 타임아웃, 빈 출력 등) → 아래 readText() 폴백.
    }
    return clipboard.readText();
  }));

  ipcMain.handle(IPC.CLIPBOARD_READ_IMAGE, wrapHandler(IPC.CLIPBOARD_READ_IMAGE, (_event: Electron.IpcMainInvokeEvent) => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;

    const tempDir = app.getPath('temp');
    // Date.now() alone can collide when pasting rapidly; add a random suffix
    const filePath = path.join(
      tempDir,
      `wmux-paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    );
    fs.writeFileSync(filePath, image.toPNG());
    return filePath;
  }));

  ipcMain.handle(IPC.CLIPBOARD_HAS_IMAGE, wrapHandler(IPC.CLIPBOARD_HAS_IMAGE, (_event: Electron.IpcMainInvokeEvent) => {
    return clipboard.availableFormats().some(f => f.startsWith('image/'));
  }));
}
