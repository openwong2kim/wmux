import { terminalRegistry } from '../../hooks/useTerminal';
import { pastePtyChunked, type TerminalModesLike } from '../../utils/clipboardChunk';

/** C0 (incl. \t \n \r ESC), DEL and C1. A path holding one is never pasted. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

/** Characters every POSIX shell (and fish) reads literally in a bare word. */
const SAFE_POSIX_PATH_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Single-quote a path for a POSIX shell. `'` and `\` are written outside the
 * quotes (`'\''`, `'\\'`), which bash, zsh and fish all read the same way;
 * fish would otherwise treat `\'` and `\\` inside quotes as escapes.
 */
function quotePosixPath(p: string): string {
  if (SAFE_POSIX_PATH_RE.test(p)) return p;
  return `'${p.replace(/['\\]/g, (c) => (c === "'" ? `'\\''` : `'\\\\'`))}'`;
}

/** Characters PowerShell and cmd.exe both read literally in a bare argument. */
const SAFE_WINDOWS_PATH_RE = /^[A-Za-z0-9_.:\\/-]+$/;

/**
 * Characters that are not literal inside double quotes in PowerShell (`$`, a
 * backtick, `"` and the Unicode double quotes it also ends a string on) or in
 * cmd.exe (`%`, and `!` under delayed expansion). Without any of them a
 * double-quoted path reads the same in both.
 */
const WINDOWS_DOUBLE_QUOTE_UNSAFE_RE = /[$`%!"\u201C-\u201E]/;

/** What cmd.exe cannot read literally even inside double quotes. */
const CMD_UNQUOTABLE_RE = /"|%[^%]+%/;

/** PowerShell treats all four of these as a single quote inside '...'. */
const POWERSHELL_SINGLE_QUOTES_RE = /['\u2018\u2019\u201A\u201B]/g;

type WindowsShellKind = 'powershell' | 'cmd' | 'posix' | 'unknown';

function windowsShellKind(shell: string | undefined): WindowsShellKind {
  const base = (shell ?? '').toLowerCase().split(/[\\/]/).pop() ?? '';
  if (base.includes('pwsh') || base.includes('powershell')) return 'powershell';
  if (base === 'cmd' || base === 'cmd.exe') return 'cmd';
  if (base.includes('bash') || /^(wsl|sh|zsh|fish|dash|ksh)(\.exe)?$/.test(base)) return 'posix';
  return 'unknown';
}

/**
 * Quote a path for a Windows pane, or null when the pane's shell cannot read
 * it literally. A bare-safe path stays bare; otherwise double quotes, which
 * PowerShell and cmd.exe both read literally unless the name holds `$`, a
 * backtick, `%`, `!`, `"` or a Unicode double quote. Only then does the shell
 * matter: PowerShell gets single quotes with each single quote doubled; cmd.exe
 * cannot read single quotes, so it keeps double quotes unless the name holds
 * `"` or a `%name%` pair; an unknown shell gets nothing, since the two rules
 * disagree.
 */
function quoteWindowsPath(p: string, kind: WindowsShellKind): string | null {
  if (kind === 'posix') return quotePosixPath(p);
  if (SAFE_WINDOWS_PATH_RE.test(p)) return p;
  if (!WINDOWS_DOUBLE_QUOTE_UNSAFE_RE.test(p)) return `"${p}"`;
  if (kind === 'powershell') return `'${p.replace(POWERSHELL_SINGLE_QUOTES_RE, '$&$&')}'`;
  if (kind === 'cmd' && !CMD_UNQUOTABLE_RE.test(p)) return `"${p}"`;
  return null;
}

/**
 * Quote each path so the pane's shell reads it literally, and join with a
 * single space. `shell` is the pane's shell executable (only consulted on
 * Windows; undefined = unknown). A path containing a control character is left
 * out (a newline would submit the line outside bracketed paste), as is a path
 * the shell cannot read literally; if every path is left out the result is ''.
 */
export function quotePathsForPrompt(
  paths: string[],
  platform: string | undefined = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined,
  shell?: string,
): string {
  const kind = platform === 'win32' ? windowsShellKind(shell) : null;
  return paths
    .filter((p) => p && !CONTROL_CHAR_RE.test(p))
    .map((p) => (kind ? quoteWindowsPath(p, kind) : quotePosixPath(p)))
    .filter((q): q is string => q !== null)
    .join(' ');
}

/** ptyId → its shell executable. A pane's shell never changes, so one lookup per pane. */
const shellByPtyId = new Map<string, string>();

/** The pane's shell executable from the pty list, or undefined when unknown. */
async function ptyShell(ptyId: string): Promise<string | undefined> {
  const known = shellByPtyId.get(ptyId);
  if (known) return known;
  try {
    const shell = (await window.electronAPI.pty.list()).find((s) => s.id === ptyId)?.shell;
    if (shell) shellByPtyId.set(ptyId, shell);
    return shell;
  } catch {
    return undefined;
  }
}

/** Paste paths into the pane, quoted for its shell (no Enter). */
export async function insertPathsIntoPty(ptyId: string, paths: string[]): Promise<void> {
  if (!ptyId) return;
  const platform = window.electronAPI.platform;
  const shell = platform === 'win32' ? await ptyShell(ptyId) : undefined;
  await injectText(ptyId, quotePathsForPrompt(paths, platform, shell), false);
}

/** The ordered raw writes for a submit/no-submit inject. Pure, for testing. */
export function buildSubmitWrites(text: string, submit: boolean): string[] {
  return submit ? [text, '\r'] : [text];
}

/** Read the live terminal's bracketed-paste mode for this ptyId. */
function modesFor(ptyId: string): TerminalModesLike | null {
  const terminal = terminalRegistry.get(ptyId);
  const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } })?.modes;
  return modes ?? null;
}

/**
 * Inject text into the pane's PTY through the chunked paste path (bracketed-
 * paste safe, newline-normalized). When `submit` is true, follow with a single
 * CR to send it as one message.
 */
export async function injectText(ptyId: string, text: string, submit: boolean): Promise<void> {
  if (!ptyId || !text) return;
  const write = (d: string) => window.electronAPI.pty.write(ptyId, d);
  await pastePtyChunked(write, text, modesFor(ptyId));
  if (submit) write('\r');
}
