/**
 * X6 — agent session resume on supervised restart/recovery.
 *
 * Pure transform: given the launch command of a supervised exec unit, return
 * the command rewritten to RESUME the agent's previous session instead of
 * starting a fresh one, so a daemon restart / OS reboot revives the agent
 * CONVERSATION (not just the process — that is X8's job).
 *
 * Only applied on REPLAY paths (recovery + supervisor restart), never on first
 * launch — the persisted `meta.exec.command` always stays the original, and the
 * replay sites pass the rewritten string as a NON-persisted launch command
 * (see DaemonSessionManager.createSession `execLaunchCommand`).
 *
 * Mechanism, per agent: append the agent's "continue latest session in this
 * cwd" flag. For Claude Code that is `--continue` (verified 2026-06-13: it
 * resumes the latest session for the cwd with zero captured state, and is a
 * graceful fresh start when there is nothing to continue). Resume is
 * cwd-scoped, so the caller MUST only apply this when the original cwd still
 * exists — otherwise it would resume an unrelated homedir session.
 *
 * v1 covers `claude` only. cmux supports 16 agents; codex/opencode/gemini
 * resume forms are a deliberate follow-up (their resume ergonomics differ and
 * none is needed for the reboot-survival headline).
 *
 * This module lives in src/shared so the daemon (tsconfig.daemon.json scopes
 * to src/daemon + src/shared) can import it WITHOUT reaching into
 * integrations/shared (out of the daemon's tsconfig).
 */

/** Agent launcher executable stems we know how to resume → the resume flag. */
const RESUME_FLAG_BY_LAUNCHER: Readonly<Record<string, string>> = {
  claude: '--continue',
};

/**
 * Unquoted tokens that mean "already resuming" or "not a resumable run" →
 * leave the command unchanged. `--continue`/`--resume`/`-c`/`-r` already
 * resume; `-p`/`--print` is a non-interactive one-shot (rewriting it to
 * `--continue` would change its semantics and, under `restart: always`, could
 * re-run a print loop). We err toward NOT rewriting: a missed resume just
 * starts fresh, a wrong rewrite changes behavior.
 */
const SKIP_TOKENS: ReadonlySet<string> = new Set([
  '--continue',
  '--resume',
  '--print',
  '-c',
  '-r',
  '-p',
]);

interface Token {
  /** Literal value with surrounding quotes stripped. */
  value: string;
  /** True if any part of the token was quoted (so flags inside a prompt
   *  string like `claude "explain --continue"` are NOT treated as flags). */
  quoted: boolean;
  /** Index in the source string just past this token (for splice insertion). */
  end: number;
}

/**
 * Minimal POSIX-ish tokenizer: splits on unquoted whitespace, respects single
 * and double quotes (a quoted span contributes to the current token and marks
 * it `quoted`). Good enough for launch commands; not a full shell parser.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  const n = command.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(command[i])) i++;
    if (i >= n) break;
    let value = '';
    let quoted = false;
    while (i < n && !/\s/.test(command[i])) {
      const c = command[i];
      if (c === '"' || c === "'") {
        quoted = true;
        const q = c;
        i++;
        while (i < n && command[i] !== q) {
          value += command[i];
          i++;
        }
        if (i < n) i++; // consume closing quote
      } else {
        value += c;
        i++;
      }
    }
    tokens.push({ value, quoted, end: i });
  }
  return tokens;
}

/** Launcher executable stem: basename, drop a Windows executable extension,
 *  lowercase. `"C:\\tools\\claude.cmd"` → `claude`; `claude-foo` → `claude-foo`. */
function launcherStem(firstToken: string): string {
  const base = firstToken.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * Return `command` rewritten to resume the agent's previous session, or the
 * command UNCHANGED when it is not a known single-agent launcher, when it is
 * already a resume/one-shot, or when it uses syntax we won't touch (env
 * assignment, pipeline — anything whose first token is not a bare launcher).
 *
 * Idempotent: re-applying never double-adds the flag.
 */
export function toResumeCommand(command: string): string {
  const tokens = tokenize(command);
  if (tokens.length === 0) return command;

  // The launcher must be a bare command (its first token's stem). An env
  // assignment (`FOO=bar`) or a path that doesn't basename to a known launcher
  // falls through unchanged.
  const stem = launcherStem(tokens[0].value);
  const resumeFlag = RESUME_FLAG_BY_LAUNCHER[stem];
  if (!resumeFlag) return command;

  // Already resuming / one-shot? Check UNQUOTED tokens only, exact match plus
  // short-flag clusters that contain c/r/p (e.g. `-cp`). Errs toward skipping.
  for (const t of tokens) {
    if (t.quoted) continue;
    if (SKIP_TOKENS.has(t.value)) return command;
    if (/^-[a-z]*[crp][a-z]*$/.test(t.value)) return command;
  }

  // Insert the resume flag immediately after the launcher token, preserving the
  // rest of the command (and its spacing/quoting) verbatim.
  const at = tokens[0].end;
  return `${command.slice(0, at)} ${resumeFlag}${command.slice(at)}`;
}

/** Whether a launch command would be rewritten by {@link toResumeCommand}. */
export function isResumableLaunchCommand(command: string): boolean {
  return toResumeCommand(command) !== command;
}

/**
 * X6 Feature ②: does a RECOVERED session qualify for the one-click resume pill?
 *
 * Only INTERACTIVE agent shells do: the user typed `claude` in a plain pane and
 * a reboot replayed the SHELL (the agent is gone — the pill offers to bring it
 * back). Excluded:
 *   - exec/supervised units — they already auto-resume via execLaunchCommand
 *     (Feature ①); a pill would be a redundant second resume.
 *   - panes that never ran a detectable agent (no lastDetectedAgent).
 *
 * Returns the agent slug to offer, or undefined. The caller is responsible for
 * the "recovered THIS boot" half of the gate — a live reconnect must never
 * reach here (Codex eng review EC4).
 */
export function resumeOfferForRecovered(session: {
  exec?: { command: string };
  supervision?: unknown;
  lastDetectedAgent?: string;
}): string | undefined {
  if (session.exec || session.supervision) return undefined;
  return session.lastDetectedAgent || undefined;
}
