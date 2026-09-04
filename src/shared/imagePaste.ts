/**
 * How a clipboard image reaches the foreground app when the user pastes into a
 * terminal pane (issue #1196).
 *
 * wmux has always taken the *path* route: main writes the bitmap to a PNG temp
 * file and the renderer types that path into the PTY. That works everywhere but
 * loses the agent's own inline-image handling, and under WSL the Windows temp
 * path is not even reachable from the Linux side without a /mnt hop.
 *
 * The *native* route sends the agent its own image-paste key instead and lets
 * it read the OS clipboard itself. Claude Code, for one, does exactly that —
 * `osascript «class PNGf»` on macOS, `xclip`/`wl-paste` on Linux, and
 * `powershell.exe` from inside WSL — and renders the result as a real inline
 * `[Image #N]` attachment rather than a file path.
 *
 * Only IMAGE-ONLY clipboards ever take the native route. A clipboard carrying
 * text is still pasted by wmux exactly as before, so ordinary copy/paste is
 * untouched by any mode here.
 */

/** Renderer-visible paste strategy for image-only clipboards. */
export type ImagePasteMode =
  /** Native for agents known to read the clipboard themselves, path otherwise. */
  | 'auto'
  /** Always hand the agent its image-paste key. */
  | 'native'
  /** Always write a temp PNG and paste its path (wmux's historical behavior). */
  | 'path';

export const IMAGE_PASTE_MODES: readonly ImagePasteMode[] = ['auto', 'native', 'path'];

export const DEFAULT_IMAGE_PASTE_MODE: ImagePasteMode = 'auto';

export function sanitizeImagePasteMode(value: unknown): ImagePasteMode {
  return IMAGE_PASTE_MODES.includes(value as ImagePasteMode)
    ? (value as ImagePasteMode)
    : DEFAULT_IMAGE_PASTE_MODE;
}

/**
 * Agent slugs whose TUI reads the OS clipboard on its own image-paste key.
 *
 * Deliberately a hard-coded allowlist rather than a guess: sending the key to an
 * agent that does NOT implement it is silent data loss (the byte lands in
 * readline as quoted-insert and the image never arrives). Verified against the
 * shipped Claude Code binary, whose keymap binds `chat:imagePaste`. Other
 * launchers stay on the path route until someone verifies them the same way.
 */
const NATIVE_IMAGE_PASTE_AGENTS = new Set<string>(['claude']);

export function agentSupportsNativeImagePaste(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && NATIVE_IMAGE_PASTE_AGENTS.has(slug);
}

/**
 * The key sequence that triggers the agent's own clipboard-image read.
 *
 * Claude Code binds `ctrl+v` on macOS/Linux and `alt+v` on Windows; under WSL it
 * binds BOTH. So a win32 host can always send Alt+V (`ESC v`) — that one
 * sequence covers a native Windows pane and a WSL pane alike, which is why this
 * needs no per-pane shell detection.
 */
export function nativeImagePasteSequence(platform: string): string {
  return platform === 'win32' ? '\x1bv' : '\x16';
}

export interface ImagePasteStrategyInput {
  mode: ImagePasteMode;
  /** Detected agent slug for the target PTY, if any. */
  agentSlug?: string | null;
}

/** Which route an image-only clipboard takes for this pane. */
export function resolveImagePasteStrategy({
  mode,
  agentSlug,
}: ImagePasteStrategyInput): 'native' | 'path' {
  if (mode === 'path') return 'path';
  if (mode === 'native') return 'native';
  return agentSupportsNativeImagePaste(agentSlug) ? 'native' : 'path';
}

/**
 * True when this pane's shell enters WSL.
 *
 * `wsl.exe` is the launcher wmux itself offers; the Store also installs
 * per-distro launchers (`ubuntu2404.exe`, `debian.exe`). `System32\bash.exe` is
 * the legacy entry point a user can still type by hand — matched by its
 * System32 location, which is what separates it from Git Bash's
 * `Git\bin\bash.exe` (a Windows-side shell that must NOT get a /mnt path).
 */
export function isWslShell(shellPath: string | null | undefined): boolean {
  if (typeof shellPath !== 'string' || !shellPath) return false;
  const posix = shellPath.replace(/\\/g, '/').toLowerCase();
  const stem = (posix.split('/').pop() ?? '').replace(/\.exe$/, '');
  if (WSL_NON_SHELLS.has(stem)) return false;
  if (WSL_LAUNCHER_RE.test(stem)) return true;
  return stem === 'bash' && /\/windows\/system32\/bash$/.test(posix.replace(/\.exe$/, ''));
}

/** Windows-side WSL tooling that is not a shell — a /mnt path there is wrong. */
const WSL_NON_SHELLS = new Set(['wslconfig', 'wslg', 'wslservice']);

/** `wsl.exe` plus the per-distro launchers the Store installs (`ubuntu2404.exe`). */
const WSL_LAUNCHER_RE =
  /^(?:wsl|ubuntu|debian|kali|opensuse|sles|oracle|fedora|alpine|archlinux)[a-z0-9._-]*$/;

/**
 * Translate a Windows path into the WSL mount that sees the same file
 * (`C:\Users\me\x.png` → `/mnt/c/Users/me/x.png`).
 *
 * Returns null for anything that is not a drive-letter absolute path — UNC
 * shares, relative paths, and paths that are already POSIX all keep their
 * original form rather than getting a bogus /mnt prefix.
 *
 * Assumes the default automount root. A wsl.conf that moves `automount.root`
 * makes this path wrong, and the pane cannot tell us — that setup should use
 * the 'native' or 'path' mode explicitly.
 */
export function toWslPath(windowsPath: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!m) return null;
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

/**
 * The image path as the pane's own filesystem sees it.
 *
 * Only rewrites when the host is Windows AND the pane is demonstrably a WSL
 * shell: guessing wrong would hand a PowerShell pane a /mnt path it cannot
 * open, which is worse than the status quo.
 */
export function imagePathForPane(
  imagePath: string,
  opts: { platform: string | undefined; shellPath?: string | null },
): string {
  if (opts.platform !== 'win32' || !isWslShell(opts.shellPath)) return imagePath;
  return toWslPath(imagePath) ?? imagePath;
}

/**
 * Characters that are safe unquoted in a POSIX shell word. Anything outside
 * this set — `$`, a backtick, a quote, a space — is quoted, because a pasted
 * path is a string the user never typed and must not be re-interpreted as
 * command substitution when it lands at a shell prompt. (The same rule the
 * macOS Finder-path paste uses; see clipboard.handler.ts.)
 */
const SAFE_POSIX_PATH_RE = /^[A-Za-z0-9_\-./~+@%,:=]+$/;

/** Single-quote a POSIX path unless every character is already safe. */
export function quotePosixPath(p: string): string {
  if (SAFE_POSIX_PATH_RE.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a pasted image path for the pane it is going to.
 *
 * An absolute POSIX path (macOS/Linux, and the /mnt rewrite for WSL) goes to a
 * POSIX shell, so it gets POSIX quoting. A Windows path keeps the historical
 * quote-on-space rule — cmd.exe treats a single quote as a literal character,
 * so POSIX rules there would corrupt the path rather than protect it.
 */
export function quoteImagePathForPty(imagePath: string): string {
  if (imagePath.startsWith('/')) return quotePosixPath(imagePath);
  return imagePath.includes(' ') ? `"${imagePath}"` : imagePath;
}
