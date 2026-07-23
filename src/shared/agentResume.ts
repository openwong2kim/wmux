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
 * Mechanism, per agent (see RESUME_BY_LAUNCHER): resume the latest / an exact
 * session in the pane's cwd. Two grammars:
 *   - flag form (Claude Code): `--continue` (latest-in-cwd) / `--resume <id>`
 *     (exact). Verified 2026-06-13: `--continue` resumes the latest session for
 *     the cwd with zero captured state and is a graceful fresh start when there
 *     is nothing to continue.
 *   - subcommand form (Codex): `resume --last` (most recent recorded) /
 *     `resume <id>` (exact; UUID takes precedence). Verified via
 *     `codex resume --help` (v0.142.2).
 * Resume is cwd-scoped, so the caller MUST only apply this when the original
 * cwd still exists — otherwise it would resume an unrelated session.
 *
 * v1 covers `claude` and `codex`. opencode/gemini/aider/copilot are a
 * deliberate follow-up (their resume ergonomics differ); their absence from
 * RESUME_BY_LAUNCHER also gates the resume pill (resumeOfferForRecovered) so we
 * never offer a resume we cannot actually perform.
 *
 * This module lives in src/shared so the daemon (tsconfig.daemon.json scopes
 * to src/daemon + src/shared) can import it WITHOUT reaching into
 * integrations/shared (out of the daemon's tsconfig).
 */

/**
 * Per-launcher resume grammar. Two shapes, expressed uniformly as
 * {fallback, withId} so the insertion logic stays agent-agnostic:
 *   - flag form (Claude): fallback `--continue`, exact `--resume <id>`.
 *   - subcommand form (Codex): fallback `resume --last`, exact `resume <id>`.
 * `withId` returns the tokens inserted right after the launcher token;
 * `fallback` is used when no exact binding applies (no capture, cwd mismatch,
 * or a purged/dead transcript). Membership here also gates the resume pill.
 */
interface ResumeGrammar {
  /** Insertion when no exact-session binding applies (latest-in-cwd). */
  readonly fallback: string;
  /** Insertion that resumes the EXACT origin session id. */
  readonly withId: (sessionId: string) => string;
}

const RESUME_BY_LAUNCHER: Readonly<Record<string, ResumeGrammar>> = {
  claude: { fallback: '--continue', withId: (id) => `--resume ${id}` },
  codex: { fallback: 'resume --last', withId: (id) => `resume ${id}` },
};

/**
 * The resume grammar for an agent slug, or undefined if wmux cannot resume it.
 * Exported for the resume pill, which assembles its command progressively
 * (permission stage) rather than via {@link toResumeCommand}.
 */
export function resumeGrammarFor(agent: string): ResumeGrammar | undefined {
  return RESUME_BY_LAUNCHER[agent];
}

/**
 * X6 ③: Claude Code's per-invocation permission mode, as stamped on every user
 * turn in the `.jsonl` transcript (`"permissionMode":"bypassPermissions"`, etc.).
 * Permission mode is NOT restored state — it must be RE-APPLIED as a launch flag
 * on resume, or a `--dangerously-skip-permissions` workflow drops back to prompts
 * after a reboot.
 */
export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';

/**
 * permissionMode → the launch flag that re-enables it. `default` maps to no flag
 * (Claude's normal prompting). Verified 2026-06-14 (live): `--resume <id>` and
 * `--dangerously-skip-permissions` coexist (F6).
 */
export const PERMISSION_FLAG: Readonly<Record<PermissionMode, string>> = {
  bypassPermissions: '--dangerously-skip-permissions',
  acceptEdits: '--permission-mode acceptEdits',
  plan: '--permission-mode plan',
  default: '',
};

/**
 * The launch flag(s) that re-apply `mode`, or '' when none is needed (default
 * mode, unknown mode, or no mode captured). Exported for the resume pill, which
 * assembles its command progressively rather than via {@link toResumeCommand}.
 */
export function permissionFlagFor(mode: PermissionMode | undefined): string {
  if (!mode) return '';
  return PERMISSION_FLAG[mode] ?? '';
}

/**
 * Whether an agent accepts a permission-mode launch flag. Claude only in v1 —
 * `PERMISSION_FLAG` is a Claude Code concept; Codex has no equivalent (its
 * `permissionMode` is never captured). Gates the resume chip's
 * skip-permissions toggle so it never shows a Codex user a flag Codex rejects.
 */
export function agentSupportsPermissionFlag(agent: string): boolean {
  return agent === 'claude';
}

/**
 * Normalize a cwd for resume-binding equality: backslashes → forward slashes,
 * lowercase a leading Windows drive letter, strip a trailing separator. POSIX
 * paths stay case-sensitive. So `D:\repo` and `d:/repo/` compare equal but
 * `/Foo` and `/foo` do not. Shared by the resume builder, the daemon recovery /
 * spool guards, and the renderer pill so all agree on "same directory" — a raw
 * `===` rejected harmless formatting diffs and dropped a valid exact resume to
 * `--continue` (codex P2).
 */
export function normalizeResumeCwd(p: string): string {
  let out = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * X6 ③: a per-session resume binding, captured live from the claude hook and
 * persisted on the daemon session record so it survives a SIGKILL/reboot.
 *
 * `sessionId` is the ORIGIN conversation id — derived from the transcript
 * filename, NOT the hook's `payload.session_id` (which mints a NEW uuid on
 * resume, upstream #12235; the transcript file is appended in place so its
 * basename always points at the origin).
 */
export interface ResumeBinding {
  /** Agent launcher slug. 'claude' in v1. */
  agent: string;
  /** `--resume` argument: the origin session id (basename of the transcript). */
  sessionId: string;
  /** Origin cwd — hard cwd-match guard, since `--resume` is cwd-scoped (F7). */
  cwd: string;
  /** Last-observed permission mode (F5). Restored only on explicit user intent. */
  permissionMode?: PermissionMode;
  /**
   * Absolute path to the origin transcript `.jsonl`. Stored so staleness can be
   * decided by an `fs.existsSync` probe (D5) — a purged id makes `--resume` a
   * "No conversation found." dead-end (F8 — it exits 0, so no exit-code signal).
   * Storing the exact path keeps the probe slug-rule-free (claude's cwd→slug
   * mapping is version-drift-prone; capture deliberately avoided depending on it).
   */
  transcriptPath?: string;
  /** Capture time (ms). Staleness is decided by existence-probe, not a TTL. */
  ts: number;
}

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

export interface Token {
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
 *
 * Exported so the role→model rewrite (orchestratorRole.applyRoleBinding) shares
 * the EXACT same launcher/quoting rules — a `--model` inside a quoted prompt
 * must be classified identically by both modules.
 */
export function tokenize(command: string): Token[] {
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
 *  lowercase. `"C:\\tools\\claude.cmd"` → `claude`; `claude-foo` → `claude-foo`.
 *  Exported so the role→model rewrite agrees with resume on what a launcher is. */
export function launcherStem(firstToken: string): string {
  const base = firstToken.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * X6 ③: merge a freshly-captured binding over the previously-persisted one,
 * keeping `permissionMode` and `transcriptPath` STICKY. The bridge reads
 * permissionMode from the transcript's last 64KB; a turn that writes >64KB after
 * the last user line makes that read miss and return undefined (codex review
 * 2026-06-14). A capture that couldn't observe the mode must NOT wipe a mode we
 * already captured — so undefined fields fall back to the prior binding's value.
 * `sessionId`/`cwd` always take the latest (they come from stable fields).
 */
export function mergeResumeBinding(
  prev: ResumeBinding | undefined,
  next: ResumeBinding,
): ResumeBinding {
  const merged: ResumeBinding = { ...next };
  // Sticky fields are only valid for the SAME conversation. When next points at
  // a different session/cwd/agent (e.g. a fresh SessionStart in a reused pane),
  // carrying prev's permissionMode/transcriptPath forward would leak the old
  // pane's bypassPermissions or run the D5 liveness probe against the wrong file
  // (CodeRabbit). Gate the carry-forward on conversation identity.
  const sameConversation =
    prev?.agent === next.agent &&
    prev?.sessionId === next.sessionId &&
    prev?.cwd === next.cwd;
  if (sameConversation && !merged.permissionMode && prev?.permissionMode) merged.permissionMode = prev.permissionMode;
  if (sameConversation && !merged.transcriptPath && prev?.transcriptPath) merged.transcriptPath = prev.transcriptPath;
  return merged;
}

/**
 * Decide what to insert after the launcher token: the grammar's id-aware
 * insertion (`grammar.withId(id)` + optional permFlag) when a valid binding
 * exists for THIS launcher and its origin cwd still matches the pane (F7:
 * `--resume`/`resume <id>` are cwd-scoped), or the grammar's plain `fallback`
 * (`--continue` / `resume --last`) otherwise.
 *
 * The permission flag is OPT-IN (`options.restorePermissionMode`) and OFF by
 * default. The only auto-run consumer is the supervised replay path, which must
 * be fail-safe per D6 — never silently re-grant `--dangerously-skip-permissions`
 * with no human in the loop. The resume pill (explicit user Enter) opts in via
 * {@link permissionFlagFor} instead of this builder. Codex has no such flag
 * (permissionMode is never captured for it), so permFlag is always empty there.
 */
function resumeInsertion(
  stem: string,
  grammar: ResumeGrammar,
  binding: ResumeBinding | undefined,
  paneCwd: string | undefined,
  options: { restorePermissionMode?: boolean } | undefined,
): string {
  if (
    binding &&
    binding.agent === stem &&
    binding.sessionId &&
    binding.cwd &&
    paneCwd &&
    normalizeResumeCwd(binding.cwd) === normalizeResumeCwd(paneCwd)
  ) {
    let insertion = grammar.withId(binding.sessionId);
    if (options?.restorePermissionMode) {
      const permFlag = permissionFlagFor(binding.permissionMode);
      if (permFlag) insertion += ` ${permFlag}`;
    }
    return insertion;
  }
  return grammar.fallback;
}

/**
 * Return `command` rewritten to resume the agent's previous session, or the
 * command UNCHANGED when it is not a known single-agent launcher, when it is
 * already a resume/one-shot, or when it uses syntax we won't touch (env
 * assignment, pipeline — anything whose first token is not a bare launcher).
 *
 * With a valid `binding` whose cwd matches `paneCwd`, resumes the EXACT session
 * (`--resume <id>`); otherwise falls back to `--continue` (latest-in-cwd, still
 * correct for the single-session case). Permission-mode restore is opt-in via
 * `options.restorePermissionMode` (default OFF — D6 fail-safe).
 *
 * Idempotent: re-applying never double-adds the flag (`--resume`/`--continue`
 * are both skip tokens).
 */
export function toResumeCommand(
  command: string,
  binding?: ResumeBinding,
  paneCwd?: string,
  options?: { restorePermissionMode?: boolean },
): string {
  const tokens = tokenize(command);
  if (tokens.length === 0) return command;

  // The launcher must be a bare command (its first token's stem). An env
  // assignment (`FOO=bar`) or a path that doesn't basename to a known launcher
  // falls through unchanged.
  const stem = launcherStem(tokens[0].value);
  const grammar = RESUME_BY_LAUNCHER[stem];
  if (!grammar) return command;

  // Already resuming / one-shot? The detection is grammar-specific:
  //   - Codex (subcommand form): `codex resume ...` already resumes, `codex
  //     exec|e ...` is a non-interactive one-shot (Codex's analogue of claude
  //     `-p`). Codex's `-c`/`-r`/`-p` are config/other flags, NOT resume flags,
  //     so the Claude flag heuristic must NOT apply to it — otherwise a valid
  //     `codex -c model=o3` is wrongly left un-resumed (CodeRabbit).
  //   - Claude (flag form): exact SKIP_TOKENS plus short-flag clusters that
  //     contain c/r/p (e.g. `-cp`). Errs toward skipping. Checked on UNQUOTED
  //     tokens only.
  if (stem === 'codex') {
    if (
      tokens.length > 1 &&
      !tokens[1].quoted &&
      (tokens[1].value === 'resume' || tokens[1].value === 'exec' || tokens[1].value === 'e')
    ) {
      return command;
    }
  } else {
    for (const t of tokens) {
      if (t.quoted) continue;
      if (SKIP_TOKENS.has(t.value)) return command;
      if (/^-[a-z]*[crp][a-z]*$/.test(t.value)) return command;
    }
  }

  // Insert the resume tokens immediately after the launcher token, preserving
  // the rest of the command (and its spacing/quoting) verbatim.
  const insert = resumeInsertion(stem, grammar, binding, paneCwd, options);
  const at = tokens[0].end;
  return `${command.slice(0, at)} ${insert}${command.slice(at)}`;
}

/** Whether a launch command would be rewritten by {@link toResumeCommand}. */
export function isResumableLaunchCommand(command: string): boolean {
  return toResumeCommand(command) !== command;
}

/**
 * X6 Feature ②: does a RECOVERED session qualify for the one-click resume pill?
 *
 * Only INTERACTIVE agent shells do: the user typed `claude`/`codex` in a plain
 * pane and a reboot replayed the SHELL (the agent is gone — the pill offers to
 * bring it back). Excluded:
 *   - exec/supervised units — they already auto-resume via execLaunchCommand
 *     (Feature ①); a pill would be a redundant second resume.
 *   - panes that never ran a detectable agent (no lastDetectedAgent).
 *   - agents wmux cannot actually resume (absent from RESUME_BY_LAUNCHER, e.g.
 *     gemini/aider) — offering one would surface a pill that types a broken
 *     command (the generalized form of the codex `--continue` bug).
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
  const agent = session.lastDetectedAgent;
  if (!agent || !RESUME_BY_LAUNCHER[agent]) return undefined;
  return agent;
}
