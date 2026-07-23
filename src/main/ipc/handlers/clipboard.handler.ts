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

// On macOS Finder Cmd+C for file/folder, clipboard.readText() returns only the "name".
// Full absolute path lives only in public.file-url slot as opaque file:///.file/id= ref,
// which pure JS (fs.realpathSync) or shell stat cannot resolve (ENOTDIR). Only AppleScript
// «class furl» coercion returns real POSIX path, so shell out via osascript. Use execFile
// not exec to avoid shell interpolation; command takes no user input (fixed script).
const OSASCRIPT_PATH = '/usr/bin/osascript';
const OSASCRIPT_TIMEOUT_MS = 2000;

// Finder filenames are user-uncontrolled input crossing into shell (pty). Quoting only
// spaces with double quotes is insufficient — $ and backticks still expand inside quotes,
// and " in the name breaks quoting (CodeRabbit). POSIX single quotes make all chars
// literal (except ' escaped as '\''), so wrap in single quotes when any unsafe char exists.
// macOS-only branch; target shells are POSIX family (zsh/bash/fish) only.
const SAFE_PATH_RE = /^[A-Za-z0-9_\-./~+@%,:=]+$/;
function quotePathForPty(p: string): string {
  if (SAFE_PATH_RE.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve absolute POSIX path of Finder file/folder on clipboard.
 *
 * Return path only when clipboard info actually has «class furl». Copying URL from browser
 * may expose text/uri-list, but without furl returns empty → caller falls back to readText().
 * (Without this furl guard, URL becomes garbage path like "/https/::example.com:.." — live probe confirmed.)
 *
 * Limit: multi-file copy — «class furl» coercion returns only "first" item
 * (single-item support is requirement; multi-select out of scope).
 *
 * Failure/timeout/non-file/empty output all return null — never worsen paste behavior.
 */
/**
 * Fast path: read the pasteboard's `public.file-url` slot directly via
 * Electron — no subprocess. Finder usually writes a REAL file URL here
 * (`file:///Users/me/%ED%8F%B4%EB%8D%94`); only some copy paths produce the
 * opaque `file:///.file/id=` bookmark form, which we cannot resolve in JS —
 * those return null and fall through to the osascript path below. This is
 * what makes ordinary Finder path pastes instant instead of paying an
 * osascript SPAWN (hundreds of ms, 2s worst case) on every Cmd+V.
 *
 * The decoded path is normalized to NFC: macOS hands out NFD-decomposed
 * names, and pasting decomposed jamo into a terminal renders Korean folder
 * names as broken syllable parts and breaks string matching against typed
 * NFC input. (Same normalization the osascript fallback applies.)
 */
/** Sentinel: the pasteboard HAS a file URL, but in the opaque bookmark form
 *  only AppleScript can resolve — the caller should take the osascript path. */
const OPAQUE_FILE_URL = Symbol('opaque-file-url');

function readFileUrlFromPasteboard(): string | typeof OPAQUE_FILE_URL | null {
  try {
    // Electron's string `read()` is restricted to MIME-like formats on some
    // versions, while the pasteboard slot is a native UTI — `readBuffer` is
    // the reliable accessor (Codex review, PR #479). Try both; a failure on
    // either is just a fall-through, never an exception out of this helper.
    let raw = '';
    try {
      raw = clipboard.readBuffer('public.file-url').toString('utf8');
    } catch {
      /* fall through to read() */
    }
    if (!raw) {
      try {
        raw = clipboard.read('public.file-url');
      } catch {
        /* not readable as string either */
      }
    }
    if (!raw || typeof raw !== 'string') return null;
    const url = raw.trim();
    if (!url.startsWith('file://')) return null;
    // Opaque Finder bookmark (`file:///.file/id=…`) — unresolvable in JS.
    if (url.includes('/.file/id=')) return OPAQUE_FILE_URL;
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.slice('file://'.length));
    } catch {
      return null; // malformed percent-encoding — let readText handle it
    }
    // Strip a possible host segment (file://localhost/...): everything up to
    // the first '/' is host.
    const slash = decoded.indexOf('/');
    const p = slash >= 0 ? decoded.slice(slash) : decoded;
    return p.startsWith('/') ? p.normalize('NFC') : null;
  } catch {
    return null;
  }
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
        // osascript appends newline at end — strip only that; keep path as-is
        // (trailing '/' on dirs preserved as macOS gave it; fine for cd).
        const filePath = (typeof stdout === 'string' ? stdout : '').replace(/\r?\n+$/, '');
        // Not absolute (empty, non-file furl result etc.) → don't trust, fall back.
        // NFC normalization: macOS returns NFD (decomposed jamo) paths; pasting raw into
        // pty breaks CJK folder names and fails match against NFC-typed strings.
        resolve(filePath.startsWith('/') ? filePath.normalize('NFC') : null);
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
    // Platform + format gate: only on darwin when clipboard has file/folder (text/uri-list)
    // try path resolution. Otherwise (plain text, other OS) return readText() immediately —
    // zero delay/behavior change for normal paste.
    if (process.platform === 'darwin') {
      // Fast path first: try reading the `public.file-url` slot DIRECTLY —
      // a single-format read. Deliberately NOT gated on availableFormats():
      // format enumeration touches every pasteboard type Finder registered
      // (icons, promises) and is itself a known macOS slow path (VS Code /
      // Electron issue lore), so the old gate taxed every ordinary text
      // paste too. A non-file clipboard just returns null here and falls
      // through to readText() with no extra cost. Only the opaque
      // `.file/id=` bookmark form still needs the osascript fallback — that
      // keeps ordinary Finder path pastes instant instead of paying an
      // osascript SPAWN (the reported multi-hundred-ms paste delay).
      const fromPasteboard = readFileUrlFromPasteboard();
      // osascript fallback fires for the opaque bookmark form AND when the
      // native reads yielded nothing but the pasteboard demonstrably holds a
      // file (uri-list present) — e.g. an Electron version whose clipboard
      // APIs can't surface the UTI (Codex review: never regress a file paste
      // to Finder's basename-only readText). The enumeration gate is only
      // reached on that fallback path; successful native reads skip it.
      const filePath =
        typeof fromPasteboard === 'string'
          ? fromPasteboard
          : fromPasteboard === OPAQUE_FILE_URL ||
              clipboard.availableFormats().includes('text/uri-list')
            ? await resolveFinderFilePath()
            : null;
      if (filePath) {
        // Renderer consumers are all terminal paste sites — write string raw to pty
        // (Terminal.tsx handlePaste, useTerminal.ts Cmd+V/Ctrl+V/Ctrl+Shift+V/right-click).
        // Quote only in file-resolution branch; see quotePathForPty ($/backtick/" must be safe too).
        return quotePathForPty(filePath);
      }
      // Resolution failed (non-file furl, timeout, empty output etc.) → readText() fallback below.
    }
    const text = clipboard.readText();
    // darwin + "path-like single-line text" only NFC normalize: catches Finder "Copy Pathname"
    // (Option+Cmd+C) emitting NFD (decomposed jamo). Normalizing all arbitrary text would
    // corrupt intentionally NFD source snippets/test vectors/normalization-sensitive remote
    // fs filenames (Codex review), so apply narrowly to absolute-path shape only.
    if (
      process.platform === 'darwin' &&
      /^(\/|~\/)/.test(text) &&
      !text.includes('\n')
    ) {
      return text.normalize('NFC');
    }
    return text;
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
