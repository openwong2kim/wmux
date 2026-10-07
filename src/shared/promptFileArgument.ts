// ─── The prompt-file argument a fan-out worker is launched with ──────────────
//
// FanOutService.buildInitialCommand appends one argument to the agent command:
// the task prompt, read from its file by the pane's shell (POSIX `cat`, or
// PowerShell `Get-Content` piped through PS_LEGACY_ARGV_QUOTE). It is built
// here so the account quota gate can recognise exactly that argument: it is
// command substitution, but wmux's own read of a single-quoted path, not a
// command the user chained after the launch. Pure; shared by main and tests.

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

// Exactly the two shapes promptFileArgument builds, as whole words. The path
// part only admits the shell's own single-quote escapes, so a match is always
// one literal path and can never span a `')" && … "$(cat '` chain.
const POSIX_PROMPT_ARGUMENT = /"\$\(cat '(?:[^']|'\\'')*'\)"/.source;
const WIN_PROMPT_ARGUMENT =
  /"\$\(Get-Content -Raw -Encoding UTF8 -LiteralPath '(?:[^']|'')*' \| /.source + escapeRegExp(PS_LEGACY_ARGV_QUOTE) + /\)"/.source;
const PROMPT_FILE_ARGUMENT = new RegExp(`(^|\\s)(?:${POSIX_PROMPT_ARGUMENT}|${WIN_PROMPT_ARGUMENT})(?=\\s|$)`, 'g');

/** The line with every prompt-file argument wmux builds taken out, so what is
 *  left can be checked for a user's own command chain. */
export function stripPromptFileArgument(command: string): string {
  return command.replace(PROMPT_FILE_ARGUMENT, '$1');
}
