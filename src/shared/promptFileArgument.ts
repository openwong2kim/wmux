// ─── The prompt-file argument a fan-out worker is launched with ──────────────
//
// FanOutService.buildInitialCommand appends one argument to the agent command:
// the task prompt, read from its file by the pane's shell (POSIX `cat`, or
// PowerShell `Get-Content` piped through PS_LEGACY_ARGV_QUOTE). It is built
// here so the account quota gate can recognise exactly that argument: it is
// command substitution, but wmux's own read of a single-quoted path, not a
// command the user chained after the launch. Pure; shared by main and tests.

import { toWslPath } from './imagePaste';
import { isWslShellPath } from './wslDistro';

/**
 * #1490 — the PowerShell pipeline stage that turns the prompt file's text into
 * the string PowerShell hands to the agent as ONE intact argv entry.
 *
 * Windows PowerShell 5.1 (and 7.x with `$PSNativeCommandArgumentPassing` unset
 * or `Legacy`) builds a native command line without escaping embedded `"`: it
 * wraps the value in quotes only when it finds whitespace at an even count of
 * `"` characters, and passes it verbatim otherwise. A prompt such as
 * `Fix the "login page" bug` therefore reached the agent split at the inner
 * quotes, and everything after the first piece — the wmux preamble included —
 * was lost.
 *
 * The two legacy binders count quotes differently, so each gets its own escape
 * (both verified against powershell.exe 5.1 and pwsh 7.6 in Legacy mode):
 *  - 5.1 counts every `"`, escaped or not, so a `\"` escape flips the parity and
 *    the value goes out unwrapped. The stage quotes the value itself: `"…"`
 *    around it, each `"` inside written as `""` (the C runtime's in-quotes
 *    escape — two quote characters, so the parity never changes and 5.1 never
 *    adds a second pair). Backslashes in front of a quote, and at the end of
 *    the value, are doubled.
 *  - 6+ skips a `"` that follows a backslash, which breaks `""` after a
 *    backslash but makes the usual `\"` escape safe: no escaped quote is
 *    counted, so the binder wraps the value itself — and doubles its trailing
 *    backslashes itself, so only the ones in front of a quote are doubled here.
 * 7.3+ in `Standard` or `Windows` mode escapes arguments correctly on its own,
 * so the text passes through untouched there. 6.0–7.2 have only the legacy
 * binder and are assumed to match 7.6's Legacy mode; they were not run. The
 * variable is read with Get-Variable because 5.1 does not define it and a
 * profile's Set-StrictMode would make a bare `$PSNativeCommandArgumentPassing`
 * throw — the worker would not launch at all. The quote character is
 * spelled `[char]34` / `\x22` so the whole `"$(…)"` stays one quoted word for
 * the launch-line tokenizers (workerLaunch.spans, agentResume.tokenize). `\z`,
 * not `$`: `$` also matches before a final newline.
 *
 * Known gap: 7.3+ `Windows` mode still uses the legacy rules for `.cmd`/`.bat`
 * launchers (an npm shim without its `.ps1`), and the text passes through
 * unescaped there.
 */
export const PS_LEGACY_ARGV_QUOTE =
  "ForEach-Object { if ((Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction Ignore) -in 'Standard', 'Windows') { $_ } " +
  "elseif ($PSVersionTable.PSVersion.Major -ge 6) { $_ -replace '(\\\\*)\\x22', ('$1$1\\{0}' -f [char]34) } " +
  "else { '{0}{1}{0}' -f [char]34, ($_ -replace '(\\\\*)\\x22', ('$1$1{0}{0}' -f [char]34) -replace '(\\\\+)\\z', '$1$1') } }";

/**
 * The prompt argument for `promptPath`: `"$(cat '<path>')"` on POSIX, or
 * `"$(Get-Content -Raw -Encoding UTF8 -LiteralPath '<path>' | …)"` on Windows.
 * The path is a shell single-quoted literal (`'\''` on POSIX, `''` in
 * PowerShell), so spaces, `$`, backticks and quotes in it are never
 * re-interpreted; `-LiteralPath` also stops PowerShell's wildcard expansion.
 */
export function promptFileArgument(promptPath: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const escaped = promptPath.replace(/'/g, "''");
    return `"$(Get-Content -Raw -Encoding UTF8 -LiteralPath '${escaped}' | ${PS_LEGACY_ARGV_QUOTE})"`;
  }
  const escaped = promptPath.replace(/'/g, "'\\''");
  return `"$(cat '${escaped}')"`;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Exactly the shapes wmux builds, matched against one whole shell word at a
// time (shellWords below), never against a stretch of the line. The path part
// only admits the shell's own single-quote escapes, no `"`, and (POSIX) no
// backslash, so the word the shell reads is the word matched.
const POSIX_PROMPT_ARGUMENT = /"\$\(cat '(?:[^'"\\]|'\\'')*'\)"/.source;
const WIN_PROMPT_ARGUMENT =
  /"\$\(Get-Content -Raw -Encoding UTF8 -LiteralPath '(?:[^'"]|'')*' \| /.source + escapeRegExp(PS_LEGACY_ARGV_QUOTE) + /\)"/.source;
/** #2231 — cmd.exe evaluates no `$(…)`, so a cmd pane's claude was handed the
 *  PowerShell expression as its prompt. There the argument names the file
 *  instead (cmdPromptFileArgument). */
const CMD_PROMPT_LEAD = 'Read your task from this file and follow it: ';
// A drive path with forward slashes and nothing any shell would expand or end
// the quoted word on: `"`, `%`, `!` (cmd), `$` and a backtick (PowerShell,
// POSIX) — the guards strip this shape as wmux's own, so it must stay inert.
// PowerShell also ends a double-quoted string on the typographic quotes
// U+201C-U+201E (and U+2018-U+201B are its single quotes), so every one of
// them is out too, as is any control character.
const CMD_PROMPT_UNSAFE = '"%!$`\\\\\\u2018-\\u201f\\u0000-\\u001f\\u007f';
const CMD_PROMPT_ARGUMENT = `"${escapeRegExp(CMD_PROMPT_LEAD)}[A-Za-z]:/[^${CMD_PROMPT_UNSAFE}]*"`;
const PROMPT_FILE_ARGUMENT = new RegExp(`^(?:${POSIX_PROMPT_ARGUMENT}|${WIN_PROMPT_ARGUMENT}|${CMD_PROMPT_ARGUMENT})$`);

/**
 * The line's words as a shell splits them: runs of non-blank text, where a
 * `'…'` or `"…"` (a backslash escaping the next character outside single
 * quotes) keeps its blanks. The same splitting agentResume.tokenize does, plus
 * escapes, with each word's span in the line. A quote left open runs to the
 * end. Pure.
 */
function shellWords(line: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const start = i;
    while (i < line.length && !/\s/.test(line[i])) {
      const c = line[i];
      if (c === '\\') {
        i += 2;
      } else if (c === "'") {
        i++;
        while (i < line.length && line[i] !== "'") i++;
        i++;
      } else if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
        i++;
      } else {
        i++;
      }
    }
    out.push({ start, end: Math.min(i, line.length) });
  }
  return out;
}

/** Replace each whole word of `line` that `match` returns text for. */
function replaceWords(line: string, match: (word: string) => string | null): string {
  let out = '';
  let at = 0;
  for (const w of shellWords(line)) {
    const next = match(line.slice(w.start, w.end));
    if (next === null) continue;
    out += line.slice(at, w.start) + next;
    at = w.end;
  }
  return out + line.slice(at);
}

/**
 * The prompt argument for a cmd.exe pane: a short prompt naming the prompt
 * file, `"Read your task from this file and follow it: C:/…/prompt.md"`.
 * cmd has no command substitution, and a prompt's text (`" & % ^ < > |`,
 * newlines) cannot ride a cmd command line intact, so the text stays in its
 * file and claude reads it from there. Null when the path cannot be written
 * that way: not a drive path, or holding `"`, `%` or `!`. Pure.
 */
export function cmdPromptFileArgument(promptPath: string): string | null {
  const p = promptPath.replace(/\\/g, '/');
  if (!/^[A-Za-z]:\//.test(p) || new RegExp(`[${CMD_PROMPT_UNSAFE}]`).test(p)) return null;
  return `"${CMD_PROMPT_LEAD}${p}"`;
}

/** The line with every prompt-file argument wmux builds taken out, so what is
 *  left can be checked for a user's own command chain. Only a whole word that
 *  is exactly one of those shapes goes; text inside another word (a quoted
 *  string that merely contains it) stays and is checked. */
export function stripPromptFileArgument(command: string): string {
  return replaceWords(command, (word) => (PROMPT_FILE_ARGUMENT.test(word) ? '' : null));
}

// The Windows shape again, as a whole word, with the path captured
// (PowerShell's `''` escape still in it).
const WIN_PROMPT_ARGUMENT_PATH = new RegExp(
  `^"\\$\\(Get-Content -Raw -Encoding UTF8 -LiteralPath '((?:[^'"]|'')*)' \\| ${escapeRegExp(PS_LEGACY_ARGV_QUOTE)}\\)"$`,
);

/**
 * The launch line for the shell its pane really runs. FanOutService builds
 * the prompt argument from the platform before any pane exists, so on Windows
 * it is always the PowerShell shape; a pane whose shell is WSL (Settings ›
 * Terminal › Default shell) runs bash, which rejects that shape outright
 * (`syntax error near unexpected token '('`). There the argument becomes the
 * POSIX one, `"$(cat '/mnt/<drive>/…')"`, on the same file as WSL mounts it.
 * A path WSL cannot name that way (a UNC share) is left alone, as is every
 * other line and every other shell: PowerShell reads the shape it was built
 * for. Pure.
 */
export function promptFileArgumentForShell(line: string, opts: { wsl: boolean; cmd?: boolean }): string {
  if (!opts.wsl && !opts.cmd) return line;
  return replaceWords(line, (word) => {
    const m = WIN_PROMPT_ARGUMENT_PATH.exec(word);
    if (!m) return null;
    const file = m[1].replace(/''/g, "'");
    if (opts.cmd) return cmdPromptFileArgument(file);
    const mounted = toWslPath(file);
    return mounted === null ? null : promptFileArgument(mounted, 'linux');
  });
}

/** What makes a path one a cmd launch line cannot carry, in plain words
 *  (`contains "!"`, `is a UNC path`), or null. `unsafe` is a character class
 *  body. Pure. */
function cmdPathFlaw(file: string, unsafe: string): string | null {
  const p = file.replace(/\\/g, '/');
  if (p.startsWith('//')) return 'is a UNC path';
  if (!/^[A-Za-z]:\//.test(p)) return 'is not a drive path';
  const bad = new RegExp(`[${unsafe}]`).exec(p)?.[0];
  if (bad === undefined) return null;
  const code = bad.charCodeAt(0);
  return code < 0x20 || code === 0x7f ? 'has a control character' : `contains "${bad}"`;
}

// The merge-lane guard's files under the data folder ride the cmd line as
// `--settings="<path>"`: refused by isQuotable (`'`, `"`, `` ` ``, `$`, `%`,
// `!`, UNC) and by isPlainCmdLaunchLine (`&`, `|`, `^`, `<`, `>`, a line
// break). Control characters too (no Windows folder name holds one).
// PowerShell's typographic quotes do not matter here: the line runs in cmd.
// What isQuotable refuses in every shell (with a UNC path).
const ANY_SHELL_DATA_DIR_UNSAFE = '\'"`$%!\\u0000-\\u001f\\u007f';
const CMD_DATA_DIR_UNSAFE = '\'"`$%!&|^<>\\u0000-\\u001f\\u007f';

/** #2256's sentence for a data folder no shell can pass the guard's files
 *  from. One wording whichever shell refused the worker (#2268), so the room
 *  card and the phone show one message. */
function noShellDataDirSentence(flaw: string): string {
  return `Command Prompt cannot pass the wmux data folder (its path ${flaw}), and no other shell can either; move the folder`;
}

/**
 * #2268 — the merge-lane guard's refusal of a data folder no shell can pass
 * its files from, as #2256's sentence, or null. It refuses exactly what
 * botWorkerGuard.isQuotable refuses (`'`, `"`, `` ` ``, `$`, `%`, `!`, a run
 * of backslashes such as a UNC prefix), on a Windows or a POSIX path alike:
 * the guard's files are named under that folder, so a PowerShell or WSL
 * worker is refused for the same cause as a Command Prompt one, and now says
 * so instead of reading as a line the guard cannot carry. Pure.
 */
export function dataDirNoShellRefusal(dataDir: string): string | null {
  let flaw: string | null = null;
  if (dataDir.startsWith('\\\\')) flaw = 'is a UNC path';
  else {
    const bad = /['"`$%!]/.exec(dataDir)?.[0];
    if (bad !== undefined) flaw = `contains "${bad}"`;
    else if (/\\\\/.test(dataDir)) flaw = 'has a run of backslashes';
  }
  return flaw === null ? null : noShellDataDirSentence(flaw);
}

/**
 * #2256 — why a bot worker's launch line cannot start in a cmd.exe pane, as
 * the sentence its owner sees, or null. The prompt file's path must take the
 * cmd form (cmdPromptFileArgument), and, for a claude line (`guardsDataDir`),
 * the merge-lane guard's files under `dataDir` must pass cmd as they are
 * spliced (CMD_DATA_DIR_UNSAFE). Without this the refusal read as a
 * merge-lane guard failure, or as a line cmd would split. Short enough that a
 * room card's title holds it whole. Pure.
 */
export function cmdLaunchPathRefusal(line: string, dataDir: string, guardsDataDir: boolean): string | null {
  // No shell passes the guard's files from such a folder (isQuotable), so
  // PowerShell is no remedy there: only moving the folder is.
  const stuck = guardsDataDir ? cmdPathFlaw(dataDir, ANY_SHELL_DATA_DIR_UNSAFE) : null;
  if (stuck && stuck !== 'is not a drive path') return noShellDataDirSentence(stuck);
  const remedy = 'set Default shell to PowerShell (Settings › Terminal) or move';
  for (const w of shellWords(line)) {
    const m = WIN_PROMPT_ARGUMENT_PATH.exec(line.slice(w.start, w.end));
    if (!m) continue;
    const flaw = cmdPathFlaw(m[1].replace(/''/g, "'"), CMD_PROMPT_UNSAFE);
    if (flaw) return `Command Prompt cannot pass the prompt file (its path ${flaw}); ${remedy} the wmux data folder`;
  }
  const flaw = guardsDataDir ? cmdPathFlaw(dataDir, CMD_DATA_DIR_UNSAFE) : null;
  return flaw ? `Command Prompt cannot pass the wmux data folder (its path ${flaw}); ${remedy} the folder` : null;
}

/** The launch line as the pane running `shell` takes it (a WSL or cmd pane
 *  gets its own prompt argument). Pure over `platform`. */
export function launchLineForShell(line: string, shell: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return line;
  return promptFileArgumentForShell(line, { wsl: isWslShellPath(shell), cmd: isCmdShellPath(shell) });
}

/** A cmd.exe shell path (`cmd`, `cmd.exe`, `C:\\Windows\\System32\\cmd.exe`). Pure. */
export function isCmdShellPath(shell: string | undefined | null): boolean {
  return typeof shell === 'string' && /(^|[\\/])cmd(\.exe)?$/i.test(shell.trim());
}
