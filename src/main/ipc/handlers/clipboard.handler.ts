import { ipcMain, clipboard, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { foregroundRemoteShellClient, imagePathForPane } from '../../../shared/imagePaste';
import { getPtyShell } from '../../pty/ptyShellRegistry';
import { EphemeralClipboard } from '../../clipboard/ephemeralClipboard';
import { clipboardHasImage, readClipboardPng } from '../../clipboard/clipboardImage';
import { ELEMENT_SHOT_PREFIX } from '../../../shared/browserElementHandoff';

let ephemeral: EphemeralClipboard | null = null;

/**
 * Take the pairing link off the clipboard if it is still there. Clipboard
 * reads are asynchronous, so the quit paths await this before the app exits.
 */
export function clearEphemeralClipboard(): Promise<void> {
  return ephemeral?.clear() ?? Promise.resolve();
}

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
    // Element screenshots from the browser hand-off share the sweep.
    if (!(name.startsWith('wmux-paste-') || name.startsWith(ELEMENT_SHOT_PREFIX)) || !name.endsWith('.png')) continue;
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
/**
 * Fast path: read the copied file's URL straight from the clipboard via
 * Electron — no subprocess. Electron hands a copied file over as
 * `text/uri-list` (on macOS, the pasteboard's file URLs), one RFC 2483 URI
 * per line; a real file URL (`file:///Users/me/%ED%8F%B4%EB%8D%94`) resolves
 * here. Only the opaque `file:///.file/id=` bookmark form cannot be resolved
 * in JS — that, and a file URL this cannot read, take the osascript path below.
 * This is what makes ordinary Finder path pastes instant instead of paying
 * an osascript SPAWN (hundreds of ms, 2s worst case) on every Cmd+V.
 *
 * The decoded path is normalized to NFC: macOS hands out NFD-decomposed
 * names, and pasting decomposed jamo into a terminal renders Korean folder
 * names as broken syllable parts and breaks string matching against typed
 * NFC input. (Same normalization the osascript fallback applies.)
 */
/** Sentinel: the clipboard HAS a file, but in a form only AppleScript can
 *  resolve — the caller should take the osascript path. */
const OPAQUE_FILE_URL = Symbol('opaque-file-url');

async function readFileUrlFromPasteboard(): Promise<string | typeof OPAQUE_FILE_URL | null> {
  let raw: string;
  try {
    // A single-format check first: listing every type is the slow path below.
    if (!(await clipboard.has('text/uri-list'))) return null;
    const item = (await clipboard.read()).find((i) => i.types.includes('text/uri-list'));
    if (!item) return null;
    raw = Buffer.from(await (await item.getType('text/uri-list')).arrayBuffer()).toString('utf8');
  } catch {
    return null;
  }
  // A copied link that is no file is plain text: readText has it.
  const url = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? '';
  if (!url.startsWith('file://')) return null;
  // A file is there from here on: anything unreadable goes to osascript, so a
  // file paste never regresses to Finder's basename-only readText.
  // Opaque Finder bookmark (`file:///.file/id=…`) — unresolvable in JS.
  if (url.includes('/.file/id=')) return OPAQUE_FILE_URL;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.slice('file://'.length));
  } catch {
    return OPAQUE_FILE_URL; // malformed percent-encoding
  }
  // Strip a possible host segment (file://localhost/...): everything up to
  // the first '/' is host.
  const slash = decoded.indexOf('/');
  const p = slash >= 0 ? decoded.slice(slash) : decoded;
  return p.startsWith('/') ? p.normalize('NFC') : OPAQUE_FILE_URL;
}

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
        // NFC 정규화: macOS는 NFD(자모 분해)로 경로를 돌려주므로, 그대로 pty에
        // 붙이면 한글 폴더명이 깨져 보이고 NFC로 타이핑한 문자열과 매칭도 실패한다.
        resolve(filePath.startsWith('/') ? filePath.normalize('NFC') : null);
      }
    );
  });
}

/**
 * The remote-session client in a pane's foreground (see
 * foregroundRemoteShellClient), or null when unknown.
 *
 * POSIX only: ConPTY has no foreground process group, so on Windows the
 * answer is always null and the paste keeps its historical behavior. The
 * shell pid comes from whoever owns the PTY (daemon or local PTYManager).
 */
async function paneRemoteShell(
  ptyId: unknown,
  shellPidFor: ((ptyId: string) => Promise<number | undefined>) | undefined,
): Promise<string | null> {
  if (process.platform === 'win32' || !shellPidFor || typeof ptyId !== 'string' || !ptyId) return null;
  const pid = await shellPidFor(ptyId).catch(() => undefined);
  if (typeof pid !== 'number' || pid <= 0) return null;
  const stdout = await new Promise<string | null>((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,pgid=,tpgid=,comm='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, out) => {
      resolve(error ? null : String(out));
    });
  });
  return stdout === null ? null : foregroundRemoteShellClient(stdout, pid);
}

export function registerClipboardHandlers(
  opts: { shellPidFor?: (ptyId: string) => Promise<number | undefined> } = {},
): void {
  cleanupStalePasteFiles();

  // Remove any previously registered handlers before re-registering.
  // ipcMain.handle() throws if the same channel is registered twice (e.g.
  // during dev HMR reloads), which silently kills clipboard IPC.
  ipcMain.removeHandler(IPC.CLIPBOARD_WRITE);
  ipcMain.removeHandler(IPC.CLIPBOARD_READ);
  ipcMain.removeHandler(IPC.CLIPBOARD_READ_IMAGE);
  ipcMain.removeHandler(IPC.CLIPBOARD_HAS_IMAGE);
  ipcMain.removeHandler(IPC.CLIPBOARD_PANE_REMOTE_SHELL);

  ipcMain.handle(IPC.CLIPBOARD_WRITE, wrapHandler(IPC.CLIPBOARD_WRITE, async (_event: Electron.IpcMainInvokeEvent, text: string) => {
    // Surface validation failures so renderer can react instead of silently
    // showing "copied" toasts when nothing actually reached the clipboard.
    if (typeof text !== 'string') {
      throw new Error('CLIPBOARD_INVALID_TYPE');
    }
    if (text.length > 1_000_000) {
      throw new Error('CLIPBOARD_TOO_LARGE');
    }
    try {
      await clipboard.writeText(text);
    } catch (err) {
      // Win32 clipboard can fail under lock contention with other apps —
      // surface the underlying message so renderer can retry/notify.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CLIPBOARD_WRITE_FAILED: ${msg}`);
    }
  }));

  // A pairing link copied from the Remote popover: main owns its lifetime so a
  // renderer remount cannot orphan it, and quitting the app clears it
  // (clearEphemeralClipboard).
  ephemeral ??= new EphemeralClipboard({ readText: () => clipboard.readText(), writeText: (t) => clipboard.writeText(t) });
  ipcMain.removeHandler(IPC.CLIPBOARD_WRITE_EPHEMERAL);
  ipcMain.handle(IPC.CLIPBOARD_WRITE_EPHEMERAL, wrapHandler(IPC.CLIPBOARD_WRITE_EPHEMERAL,
    async (_event: Electron.IpcMainInvokeEvent, text: unknown, ttlMs: unknown) => {
      if (typeof text !== 'string' || text.length === 0 || text.length > 4096) throw new Error('CLIPBOARD_INVALID_TYPE');
      const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) ? ttlMs : 0;
      try {
        await ephemeral?.write(text, ttl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`CLIPBOARD_WRITE_FAILED: ${msg}`);
      }
    }));
  ipcMain.removeHandler(IPC.CLIPBOARD_KEEP_EPHEMERAL);
  ipcMain.handle(IPC.CLIPBOARD_KEEP_EPHEMERAL, wrapHandler(IPC.CLIPBOARD_KEEP_EPHEMERAL,
    (_event: Electron.IpcMainInvokeEvent, stillValid: unknown) => {
      ephemeral?.keepOnly(typeof stillValid === 'string' ? stillValid : '');
    }));

  ipcMain.handle(IPC.CLIPBOARD_READ, wrapHandler(IPC.CLIPBOARD_READ, async (_event: Electron.IpcMainInvokeEvent) => {
    // 플랫폼 + 포맷 게이트: darwin이고 클립보드에 파일/폴더(text/uri-list)가 있을
    // 때만 경로 해석을 시도한다. 그 외(일반 텍스트, 타 OS)는 기존과 완전히 동일하게
    // readText()를 즉시 반환하므로 일반 붙여넣기의 지연·동작 변화는 0이다.
    if (process.platform === 'darwin') {
      // Fast path first: a single-format check for a copied file's URL list,
      // read only when it is there. Deliberately NOT gated on listing every
      // type: format enumeration touches every pasteboard type Finder registered
      // (icons, promises) and is itself a known macOS slow path (VS Code /
      // Electron issue lore), so the old gate taxed every ordinary text
      // paste too. A non-file clipboard just returns null here and falls
      // through to readText() with no extra cost. Only the opaque
      // `.file/id=` bookmark form still needs the osascript fallback — that
      // keeps ordinary Finder path pastes instant instead of paying an
      // osascript SPAWN (the reported multi-hundred-ms paste delay).
      const fromPasteboard = await readFileUrlFromPasteboard();
      // osascript fallback fires for the opaque bookmark form AND for a file
      // whose URL could not be read here (Codex review: never regress a file
      // paste to Finder's basename-only readText).
      const filePath =
        typeof fromPasteboard === 'string'
          ? fromPasteboard
          : fromPasteboard === OPAQUE_FILE_URL
            ? await resolveFinderFilePath()
            : null;
      if (filePath) {
        // 이 값을 소비하는 렌더러 호출부는 전부 터미널 붙여넣기 사이트라 문자열을
        // 그대로 pty에 쓴다(Terminal.tsx handlePaste, useTerminal.ts의 Cmd+V/
        // Ctrl+V/Ctrl+Shift+V/우클릭). 파일 해석 분기에서만 인용하며, 방식은
        // quotePathForPty 참고(공백뿐 아니라 $·백틱·" 등도 안전해야 한다).
        return quotePathForPty(filePath);
      }
      // 해석 실패(비파일 furl, 타임아웃, 빈 출력 등) → 아래 readText() 폴백.
    }
    const text = await clipboard.readText();
    // darwin + "경로처럼 생긴 단일행 텍스트"만 NFC 정규화: Finder의 "경로명
    // 복사"(Option+Cmd+C)가 NFD(자모 분해)를 내놓는 케이스를 잡는다. 임의
    // 텍스트를 전부 정규화하면 의도적으로 NFD인 소스 스니펫/테스트 벡터/
    // 정규화-민감 원격 fs의 파일명이 훼손되므로(Codex 리뷰), 절대경로 형태로
    // 판별되는 것만 좁게 적용한다.
    if (
      process.platform === 'darwin' &&
      /^(\/|~\/)/.test(text) &&
      !text.includes('\n')
    ) {
      return text.normalize('NFC');
    }
    return text;
  }));

  ipcMain.handle(IPC.CLIPBOARD_READ_IMAGE, wrapHandler(IPC.CLIPBOARD_READ_IMAGE, async (_event: Electron.IpcMainInvokeEvent, ptyId?: string) => {
    const png = await readClipboardPng();
    if (!png) return null;

    const tempDir = app.getPath('temp');
    // Date.now() alone can collide when pasting rapidly; add a random suffix
    const filePath = path.join(
      tempDir,
      `wmux-paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    );
    fs.writeFileSync(filePath, png);
    // A WSL pane sees the Windows temp dir only under /mnt (#1196): pasting the
    // native `C:\...` path there hands the agent a file it cannot open. Any pane
    // whose shell we can't identify keeps the untouched path — a wrong /mnt
    // rewrite for a PowerShell pane would be worse than no rewrite at all.
    return imagePathForPane(filePath, {
      platform: process.platform,
      // Renderer-supplied; anything but a non-empty string is treated as "no
      // pane", which just means no rewrite.
      shellPath: getPtyShell(typeof ptyId === 'string' && ptyId ? ptyId : undefined),
    });
  }));

  ipcMain.handle(IPC.CLIPBOARD_PANE_REMOTE_SHELL, wrapHandler(IPC.CLIPBOARD_PANE_REMOTE_SHELL, (_event: Electron.IpcMainInvokeEvent, ptyId?: unknown) => {
    return paneRemoteShell(ptyId, opts.shellPidFor);
  }));

  ipcMain.handle(IPC.CLIPBOARD_HAS_IMAGE, wrapHandler(IPC.CLIPBOARD_HAS_IMAGE, (_event: Electron.IpcMainInvokeEvent) => {
    return clipboardHasImage();
  }));
}
