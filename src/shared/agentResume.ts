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
 * Mechanism, per agent (see RESUME_BY_LAUNCHER): resume the pane's own EXACT
 * session, never a guess. Two grammars:
 *   - flag form (Claude Code): `--resume <id>`.
 *   - subcommand form (Codex): `resume <id>` (verified via `codex resume --help`,
 *     v0.142.2).
 * There is no "latest in this folder" form (`--continue` / `resume --last`):
 * several panes can share a folder, and each would reopen the same newest
 * conversation. With no exact binding the command is left a fresh launch.
 * Resume is cwd-scoped, so the caller MUST only apply this when the original
 * cwd still exists — otherwise it would resume an unrelated session.
 *
 * v1 covers `claude` and `codex`. opencode/gemini/aider/copilot are a
 * deliberate follow-up (their resume ergonomics differ); their absence from
 * RESUME_BY_LAUNCHER also gates the resume pill (resumeOfferForRecovered) so we
 * never offer a resume we cannot actually perform.
 *
 * The grammar per agent is data on its registry row (`resume` in
 * src/shared/agentIdentity.ts); this module turns it into commands.
 *
 * This module lives in src/shared so the daemon (tsconfig.daemon.json scopes
 * to src/daemon + src/shared) can import it WITHOUT reaching into
 * integrations/shared (out of the daemon's tsconfig).
 */

import { AGENT_ROWS, agentRow } from './agentIdentity';

/**
 * Per-launcher resume grammar. Two shapes, expressed uniformly as
 * {picker, withId} so the insertion logic stays agent-agnostic:
 *   - flag form (Claude): picker `--resume`, exact `--resume <id>`.
 *   - subcommand form (Codex): picker `resume`, exact `resume <id>`.
 * `withId` returns the tokens inserted right after the launcher token;
 * `picker` is what a person-driven resume types when no exact binding applies
 * (#1946). An unattended path with no exact binding resumes nothing. Membership
 * here also gates the resume pill.
 */
interface ResumeGrammar {
  /**
   * #1946: insertion that opens the agent's own session picker (Claude
   * `--resume`, Codex `resume`), filtered to the shell's folder. What the resume
   * pill, chip and Deck type when no exact session is bound: several panes can
   * share a folder, and a latest-in-folder guess would reopen the same newest
   * conversation in every one of them.
   */
  readonly picker: string;
  /** Insertion that resumes the EXACT origin session id. */
  readonly withId: (sessionId: string) => string;
  /** The flag that pins a fresh launch's session id (Claude `--session-id`), if any. */
  readonly pin?: string;
}

// Derived from the registry's `resume` rows (src/shared/agentIdentity.ts), keyed
// by slug. A Map, not an object index: a slug now reaches here from ANOTHER
// machine (#1342), and `constructor` / `toString` must not answer with
// something off a prototype. `split`/`join` rather than `replace`, so a `$&`
// inside a session id is inserted literally.
const RESUME_BY_LAUNCHER: ReadonlyMap<string, ResumeGrammar> = new Map(
  AGENT_ROWS.flatMap((row): [string, ResumeGrammar][] => {
    const spec = row.resume;
    return spec
      ? [[row.slug, { picker: spec.picker, withId: (id) => spec.exact.split('{id}').join(id), ...(spec.pin ? { pin: spec.pin } : {}) }]]
      : [];
  }),
);

/**
 * The resume grammar for an agent slug, or undefined if wmux cannot resume it.
 * Exported for the resume pill, which assembles its command progressively
 * (permission stage) rather than via {@link toResumeCommand}.
 */
export function resumeGrammarFor(agent: string): ResumeGrammar | undefined {
  // A Map lookup, not a bare object index: a plain object literal answers
  // `constructor` / `toString` with something truthy off its prototype, and a
  // slug now reaches here from ANOTHER machine (#1342). Without this, such a
  // slug passes as a resumable agent and then has no `withId` to call.
  return RESUME_BY_LAUNCHER.get(agent);
}

/**
 * X6 ③: Claude Code's per-invocation permission mode, as stamped on every user
 * turn in the `.jsonl` transcript (`"permissionMode":"bypassPermissions"`, etc.).
 * Permission mode is NOT restored state — it must be RE-APPLIED as a launch flag
 * on resume, or a `--dangerously-skip-permissions` workflow drops back to prompts
 * after a reboot.
 */
export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'plan' | 'auto' | 'default';

/**
 * permissionMode → the launch flag that re-enables it. `default` maps to no flag
 * (Claude's normal prompting). Verified 2026-06-14 (live): `--resume <id>` and
 * `--dangerously-skip-permissions` coexist (F6).
 */
export const PERMISSION_FLAG: Readonly<Record<PermissionMode, string>> = {
  bypassPermissions: '--dangerously-skip-permissions',
  acceptEdits: '--permission-mode acceptEdits',
  plan: '--permission-mode plan',
  auto: '--permission-mode auto',
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
 * #1916 — where the resume pill's and chip's skip-permissions toggle starts:
 * on only when the line resumes the EXACT recorded conversation and that
 * conversation ran with `bypassPermissions`. Everything else starts off,
 * including a binding that only reaches the session picker.
 */
export function defaultResumeSkipPermissions(
  recordedMode: PermissionMode | undefined,
  exact: boolean,
): boolean {
  return exact && recordedMode === 'bypassPermissions';
}

/**
 * #1916 — the permission flag a user-typed resume line carries.
 *
 * - A line without an exact session (the session picker, #1946) carries NO
 *   flag. The conversation
 *   it reaches is not one wmux can vouch for, so it must never be combined with
 *   `--dangerously-skip-permissions`. Bypass needs an exact binding.
 * - On an exact resume, the toggle ON types `--dangerously-skip-permissions`.
 *   The toggle OFF restores the recorded mode, except a recorded
 *   `bypassPermissions`: OFF means no bypass.
 * - An agent with no permission-mode flag (Codex) gets ''.
 */
export function resumePermissionFlag(args: {
  agent: string;
  exact: boolean;
  recordedMode: PermissionMode | undefined;
  skipPermissions: boolean;
}): string {
  if (!args.exact || !agentSupportsPermissionFlag(args.agent)) return '';
  if (args.skipPermissions) return PERMISSION_FLAG.bypassPermissions;
  return args.recordedMode === 'bypassPermissions' ? '' : permissionFlagFor(args.recordedMode);
}

/**
 * Whether an agent accepts a permission-mode launch flag. Claude only in v1 —
 * `PERMISSION_FLAG` is a Claude Code concept; Codex has no equivalent (its
 * `permissionMode` is never captured). Gates the resume chip's
 * skip-permissions toggle so it never shows a Codex user a flag Codex rejects.
 */
export function agentSupportsPermissionFlag(agent: string): boolean {
  return agentRow(agent)?.permissions === 'permission-mode';
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
 * Whether a resume binding read from disk, or received over the wire, has the
 * fields its consumers read without a check: a non-empty agent, session id and
 * folder (`cwd`). A stored binding failing this is skipped, never used.
 */
export function isUsableResumeBinding(binding: unknown): binding is ResumeBinding {
  if (binding === null || typeof binding !== 'object') return false;
  const b = binding as Record<string, unknown>;
  return (
    typeof b.agent === 'string' && b.agent.length > 0
    && typeof b.sessionId === 'string' && b.sessionId.length > 0
    && typeof b.cwd === 'string' && b.cwd.length > 0
  );
}

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * #1823: whether `sessionId` has the shape `agent`'s resume grammar accepts.
 * Claude session ids and Codex thread ids are both UUIDs; a Codex rollout
 * filename stem (`rollout-<local time>-<uuid>`) is neither, and stored under
 * `agent: 'claude'` it made a Codex pane offer `claude --resume rollout-…`.
 * Other agents keep their own id formats, so only these two are checked.
 */
export function isPlausibleResumeSessionId(agent: string, sessionId: string): boolean {
  if (agentRow(agent)?.resume?.idFormat === 'uuid') return UUID_RE.test(sessionId);
  return sessionId.length > 0;
}

/** The parts of a Codex rollout filename stem (`rollout-YYYY-MM-DDTHH-MM-SS-<uuid>`). */
export function parseCodexRolloutStem(stem: string): { year: string; month: string; day: string; threadId: string } | undefined {
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(stem);
  return m ? { year: m[1], month: m[2], day: m[3], threadId: m[4] } : undefined;
}

/**
 * Unquoted tokens that mean "already resuming" or "not a resumable run" →
 * leave the command unchanged. `--continue`/`--resume`/`-c`/`-r` already
 * resume; `-p`/`--print` is a non-interactive one-shot (rewriting it to a
 * resume would change its semantics and, under `restart: always`, could
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
 * True when `next` must NOT replace `prev`: both belong to the same transcript
 * agent, `prev` already points at a real transcript, and `next` names a
 * DIFFERENT session that has no transcript yet.
 *
 * - claude: a SessionStart fires before its transcript exists (F9) and carries
 *   the provisional id; a reboot in between would `--resume <wrong id>`.
 * - codex (#1624): during the first turn Codex also completes an internal
 *   title-generation thread that never gets a rollout. Its notify inherits the
 *   pane env, so it arrives pane-exact and would otherwise clobber the real
 *   session and leave the pane `no-transcript-path`.
 *
 * A genuine session switch (`/new`, resume) still rebinds: transcript discovery
 * re-applies the new id WITH its path the moment its transcript exists.
 */
export function isProvisionalCapture(prev: ResumeBinding | undefined, next: ResumeBinding): boolean {
  return !!prev
    && (next.agent === 'claude' || next.agent === 'codex')
    && prev.agent === next.agent
    && !!prev.transcriptPath
    && !next.transcriptPath
    && prev.sessionId !== next.sessionId;
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
 * `--resume`/`resume <id>` are cwd-scoped), or undefined otherwise. There is
 * no latest-in-folder fallback: it cannot tell apart panes that share a folder.
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
): string | undefined {
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
  return undefined;
}

/**
 * Whether `tokens` (a tokenized launch line) is an agent run wmux must leave
 * alone: already resuming, or a non-interactive one-shot. The detection is
 * grammar-specific:
 *   - Codex (subcommand form): `codex resume ...` already resumes, `codex
 *     exec|e ...` is a non-interactive one-shot (Codex's analogue of claude
 *     `-p`). Codex's `-c`/`-r`/`-p` are config/other flags, NOT resume flags,
 *     so the Claude flag heuristic must NOT apply to it — otherwise a valid
 *     `codex -c model=o3` is wrongly left un-resumed (CodeRabbit).
 *   - Claude (flag form): exact SKIP_TOKENS plus short-flag clusters that
 *     contain c/r/p (e.g. `-cp`). Errs toward skipping. Checked on UNQUOTED
 *     tokens only.
 */
function alreadyResumingOrOneShot(stem: string, tokens: readonly Token[]): boolean {
  if (stem === 'codex') {
    return tokens.length > 1 &&
      !tokens[1].quoted &&
      (tokens[1].value === 'resume' || tokens[1].value === 'exec' || tokens[1].value === 'e');
  }
  for (const t of tokens) {
    if (t.quoted) continue;
    if (SKIP_TOKENS.has(t.value)) return true;
    if (/^-[a-z]*[crp][a-z]*$/.test(t.value)) return true;
  }
  return false;
}

/**
 * The source ranges of every unquoted `<pin> <id>` / `<pin>=<id>` (Claude
 * `--session-id`) in `tokens`. Each range starts at the end of the token before
 * it, so removing it also removes the separating space. Scanning stops at an
 * unquoted `--`: what follows is the prompt.
 */
function pinFlagRanges(tokens: readonly Token[], pin: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.quoted) continue;
    if (t.value === '--') break;
    if (t.value === pin && i + 1 < tokens.length) {
      ranges.push([tokens[i - 1].end, tokens[i + 1].end]);
      i++;
    } else if (t.value.startsWith(`${pin}=`)) {
      ranges.push([tokens[i - 1].end, t.end]);
    }
  }
  return ranges;
}

/**
 * Return `command` rewritten to resume the agent's previous session, or the
 * command UNCHANGED when it is not a known single-agent launcher, when it is
 * already a resume/one-shot, or when it uses syntax we won't touch (env
 * assignment, pipeline — anything whose first token is not a bare launcher).
 *
 * Only a valid `binding` whose cwd matches `paneCwd` resumes, and it resumes
 * that EXACT session (`--resume <id>` / `resume <id>`). Without one the command
 * stays a fresh launch: never `--continue` / `resume --last`, which pick the
 * newest conversation in the folder and so cannot tell apart panes sharing it.
 * Permission-mode restore is opt-in via `options.restorePermissionMode`
 * (default OFF — D6 fail-safe).
 *
 * A pin flag (Claude `--session-id <id>`) in the launch line is removed either way: the
 * id names a conversation that may now exist, and Claude refuses to start a
 * new session under an id already in use ("Session ID … is already in use",
 * verified 2026-10-09). On resume the binding's id is the authority, not the
 * flag's (a `/clear` or `/resume` may have moved the pane on).
 *
 * Unattended paths only (supervised replay): nobody is there to drive a
 * picker. The resume pill, chip and Deck type the grammar's `picker` instead
 * when no exact session is bound (#1946).
 *
 * Idempotent: re-applying never double-adds the flag (`--resume` is a skip
 * token).
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
  const grammar = RESUME_BY_LAUNCHER.get(stem);
  if (!grammar) return command;
  if (alreadyResumingOrOneShot(stem, tokens)) return command;

  let out = command;
  if (grammar.pin) {
    for (const [from, to] of pinFlagRanges(tokens, grammar.pin).reverse()) out = out.slice(0, from) + out.slice(to);
  }
  // Insert the resume tokens immediately after the launcher token, preserving
  // the rest of the command (and its spacing/quoting) verbatim.
  const insert = resumeInsertion(stem, grammar, binding, paneCwd, options);
  if (insert === undefined) return out;
  const at = tokens[0].end;
  return `${out.slice(0, at)} ${insert}${out.slice(at)}`;
}

/**
 * Whether a launch command is one {@link toResumeCommand} would resume given an
 * exact binding: a known agent launcher that is not already resuming and not a
 * one-shot.
 */
export function isResumableLaunchCommand(command: string): boolean {
  const tokens = tokenize(command);
  if (tokens.length === 0) return false;
  const stem = launcherStem(tokens[0].value);
  return RESUME_BY_LAUNCHER.has(stem) && !alreadyResumingOrOneShot(stem, tokens);
}

/**
 * A1 — pin a FRESH launch of an agent that has a pin flag (Claude
 * `--session-id`, see AgentResumeSpec.pin) to a wmux-minted conversation id
 * (`claude --session-id <id> …`), so the pane's exact id is known from the
 * agent's command line before any hook arrives (the transcript is then
 * `<id>.jsonl`). Returns `command` unchanged unless it is certainly a fresh
 * interactive Claude launch:
 *   - the first token is the launcher itself (an env assignment, `cd … &&`
 *     or any other prefix is someone else's syntax);
 *   - it does not already resume, continue, fork, print or pin an id;
 *   - the token after the launcher is not an unquoted word: that is a
 *     subcommand (`claude mcp …`, `claude doctor`) or shell syntax, and cannot
 *     be told apart from an unquoted prompt.
 * The caller unwraps a leading worker model-env marker first (see
 * launchSessionPin.ts).
 */
export function withLaunchSessionId(command: string, sessionId: string): string {
  if (!UUID_RE.test(sessionId)) return command;
  const tokens = tokenize(command);
  if (tokens.length === 0) return command;
  const stem = launcherStem(tokens[0].value);
  const pin = RESUME_BY_LAUNCHER.get(stem)?.pin;
  if (!pin || alreadyResumingOrOneShot(stem, tokens)) return command;
  if (tokens.some((t) => !t.quoted && (t.value.startsWith(pin) || t.value === '--fork-session'))) return command;
  const next = tokens[1];
  if (next && !next.quoted && !next.value.startsWith('-')) return command;
  const at = tokens[0].end;
  return `${command.slice(0, at)} ${pin} ${sessionId.toLowerCase()}${command.slice(at)}`;
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
  if (!agent || !RESUME_BY_LAUNCHER.has(agent)) return undefined;
  return agent;
}
