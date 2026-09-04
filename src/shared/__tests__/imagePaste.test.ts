import { describe, it, expect } from 'vitest';
import {
  imagePathForPane,
  isWslShell,
  nativeImagePasteSequence,
  quoteImagePathForPty,
  resolveImagePasteStrategy,
  sanitizeImagePasteMode,
  toWslPath,
} from '../imagePaste';

describe('resolveImagePasteStrategy (#1196)', () => {
  it('auto goes native only for an agent that reads the clipboard itself', () => {
    expect(resolveImagePasteStrategy({ mode: 'auto', agentSlug: 'claude' })).toBe('native');
    expect(resolveImagePasteStrategy({ mode: 'auto', agentSlug: 'codex' })).toBe('path');
    // A plain shell pane has no detected agent — the native key would land in
    // readline as quoted-insert and the image would vanish.
    expect(resolveImagePasteStrategy({ mode: 'auto', agentSlug: undefined })).toBe('path');
  });

  it('explicit modes ignore the detected agent', () => {
    expect(resolveImagePasteStrategy({ mode: 'native', agentSlug: undefined })).toBe('native');
    expect(resolveImagePasteStrategy({ mode: 'path', agentSlug: 'claude' })).toBe('path');
  });
});

describe('nativeImagePasteSequence', () => {
  // Claude Code binds ctrl+v on macOS/Linux and alt+v on Windows; under WSL it
  // binds both, so one Alt+V covers a win32 host's native and WSL panes alike.
  it('sends Alt+V on Windows and Ctrl+V elsewhere', () => {
    expect(nativeImagePasteSequence('win32')).toBe('\x1bv');
    expect(nativeImagePasteSequence('darwin')).toBe('\x16');
    expect(nativeImagePasteSequence('linux')).toBe('\x16');
    expect(nativeImagePasteSequence(undefined)).toBe('\x16');
  });
});

describe('toWslPath / imagePathForPane', () => {
  it('maps a drive-letter path onto the WSL mount', () => {
    expect(toWslPath('C:\\Users\\me\\AppData\\Local\\Temp\\wmux-paste-1.png'))
      .toBe('/mnt/c/Users/me/AppData/Local/Temp/wmux-paste-1.png');
    expect(toWslPath('D:/tmp/x.png')).toBe('/mnt/d/tmp/x.png');
  });

  it('refuses to invent a mount for non-drive paths', () => {
    expect(toWslPath('\\\\server\\share\\x.png')).toBeNull();
    expect(toWslPath('/tmp/x.png')).toBeNull();
    expect(toWslPath('relative\\x.png')).toBeNull();
  });

  it('rewrites only for a WSL pane on a Windows host', () => {
    const win = 'C:\\Temp\\x.png';
    expect(imagePathForPane(win, { platform: 'win32', shellPath: 'C:\\Windows\\System32\\wsl.exe' }))
      .toBe('/mnt/c/Temp/x.png');
    // A PowerShell pane must keep the Windows path — a /mnt path is unopenable there.
    expect(imagePathForPane(win, { platform: 'win32', shellPath: 'C:\\...\\powershell.exe' })).toBe(win);
    // Unknown shell (daemon session we never recorded) → no guess.
    expect(imagePathForPane(win, { platform: 'win32', shellPath: undefined })).toBe(win);
    expect(imagePathForPane('/tmp/x.png', { platform: 'darwin', shellPath: '/bin/zsh' })).toBe('/tmp/x.png');
  });

  it('recognizes both WSL entry points and leaves Git Bash alone', () => {
    expect(isWslShell('C:\\Windows\\System32\\wsl.exe')).toBe(true);
    expect(isWslShell('wsl')).toBe(true);
    // Legacy WSL entry point — identified by its System32 location.
    expect(isWslShell('C:\\Windows\\System32\\bash.exe')).toBe(true);
    // Git Bash is a Windows-side shell: a /mnt path there is unopenable.
    expect(isWslShell('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(false);
    expect(isWslShell(undefined)).toBe(false);
  });
});

describe('sanitizeImagePasteMode', () => {
  it('falls back to auto for anything unknown (session.json is hand-editable)', () => {
    expect(sanitizeImagePasteMode('native')).toBe('native');
    expect(sanitizeImagePasteMode('path')).toBe('path');
    expect(sanitizeImagePasteMode('nope')).toBe('auto');
    expect(sanitizeImagePasteMode(undefined)).toBe('auto');
  });
});

describe('quoteImagePathForPty', () => {
  it('single-quotes a POSIX path carrying shell metacharacters', () => {
    // A Windows username can contain `$`; after the /mnt rewrite that path is
    // read by bash, where an unquoted `$user` would expand mid-paste.
    expect(quoteImagePathForPty('/mnt/c/Users/a$b/x.png')).toBe("'/mnt/c/Users/a$b/x.png'");
    expect(quoteImagePathForPty('/tmp/my shot.png')).toBe("'/tmp/my shot.png'");
    expect(quoteImagePathForPty("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
  });

  it('leaves a clean POSIX path bare', () => {
    expect(quoteImagePathForPty('/tmp/wmux-paste-1.png')).toBe('/tmp/wmux-paste-1.png');
  });

  it('keeps the quote-on-space rule for Windows paths (cmd has no POSIX quoting)', () => {
    expect(quoteImagePathForPty('C:\\Temp\\x.png')).toBe('C:\\Temp\\x.png');
    expect(quoteImagePathForPty('C:\\My Temp\\x.png')).toBe('"C:\\My Temp\\x.png"');
  });
});
