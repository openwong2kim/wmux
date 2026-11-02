// ─── Fan-out worker first-run (A-1, orchestrator wave 2) ────────────────────
//
// A fan-out worker is a `claude` launched in a worktree the human has never
// opened. Wave 1 measured what that costs: 4/4 workers stopped on Claude Code's
// folder-trust prompt ("Is this a project you created or one you trust?") and
// then on a first-run onboarding prompt. `agentStatus` stayed `idle` and nobody
// pressed — these are not approval prompts, so no hook fires and no approval
// record exists. The brain saw silence and read it as work in progress.
//
// ── What was measured (spike, 2026-09-04, Claude Code 2.1.260) ──────────────
//
// Three candidates were tried against a real `claude` in a pty, in the order
// the wave-2 plan set:
//
//  1. A per-worker `CLAUDE_CONFIG_DIR` seeded with onboarding/trust/auto-mode
//     state. REJECTED: the prompts do disappear, but the worker comes up "Not
//     logged in · Run /login" — credentials do not follow the config dir (macOS
//     keeps them outside it), and copying the account record does not change
//     that. A worker that cannot authenticate is worse than one that prompts.
//     It would also detach the worker from the user's own ~/.claude settings and
//     hooks, and the wmux hooks are what produce approval records at all.
//
//  2. An env Claude Code itself honours: `CLAUDE_CODE_SANDBOXED=1`. ACCEPTED.
//     Verified live: an untrusted throwaway directory, no trust dialog, and the
//     session authenticated normally. It short-circuits Claude Code's trust
//     resolution ahead of the `projects[path].hasTrustDialogAccepted` lookup, so
//     wmux writes NOTHING to the user's global config to get it.
//
//  3. Writing `projects[<worktree>]` into the user's `~/.claude.json`. NOT
//     NEEDED, therefore not done — candidate 2 is strictly less invasive.
//     (Recorded for the next reader: trust resolution walks PARENT directories.
//     Trust on `<root>/<repoHash>` covers `<root>/<repoHash>/<task-slug>`, which
//     is why wave 1's second run did not re-prompt even though no per-worktree
//     entry was ever written.)
//
// The trust dialog is not the only first-run screen, and that is the second
// half of this module. Claude Code shows a FAMILY of one-shot interstitials
// (the auto-mode environment onboarding wave 1 hit, a fullscreen-renderer
// upsell reproduced during the spike) gated on counters in the user's global
// config. `CLAUDE_CODE_SANDBOXED` does not suppress them, and writing those
// counters is global user state wmux must not touch. Each advertises `Esc to
// cancel`, and ESC was verified to dismiss one and land on the composer — so a
// worker stuck on a KNOWN first-run interstitial is answered with ESC, and one
// stuck on anything else is reported rather than guessed at.
//
// ── Why the detector is an allow-list ───────────────────────────────────────
//
// "A menu with a cursor row and an Enter/Esc footer" also describes an
// AskUserQuestion prompt and a permission gate — the two things that must NEVER
// be answered by a blind keystroke from main (that is what the approval
// registry, its hook provenance and `decideApprovalPress` exist for). So the
// detector requires a known first-run HEADLINE as well. A new Claude Code
// release that invents a new interstitial therefore falls through to "stuck",
// which reports and waits: the safe direction.

import { looksLikeApprovalPrompt, readFolderTrustScreen } from '../daemon/approvals/approvalKeystrokes';
import { showsScreenReaderKeyRow } from '../daemon/approvals/screenReaderKeyRow';
import { CODEX_TRUST_HEADLINE, TRUST_HEADLINE } from './folderTrustWording';

/**
 * Opt-out. `off` / `0` / `false` (case-insensitive) turns off BOTH the env
 * injection and the first-run answerer for every fan-out worker; anything else
 * (including absent) leaves them on.
 *
 * An env var rather than a Settings toggle on purpose: this is a launch-time
 * property of the fan-out spawn, it has to be readable in main with no renderer
 * round trip, and a toggle would put a UI file in a lane that owns none.
 */
export const AGENT_FIRST_RUN_ENV = 'WMUX_AGENT_FIRST_RUN';

/** The env Claude Code reads to skip its workspace-trust dialog. */
export const CLAUDE_SANDBOXED_ENV = 'CLAUDE_CODE_SANDBOXED';

/** Launcher stems that get this module's launch env. Which workers the
 *  first-run watch reads is the agent row's firstRunWatch: a gemini or qwen
 *  worker is watched for its trust dialog only, and no other agent at all. */
export const SUPPORTED_STEMS: ReadonlySet<string> = new Set(['claude']);

/** Is the first-run handling enabled at all? */
export function firstRunEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[AGENT_FIRST_RUN_ENV];
  if (typeof raw !== 'string') return true;
  return !['off', '0', 'false', 'no'].includes(raw.trim().toLowerCase());
}

/**
 * The launcher stem of a fan-out command (`/opt/bin/claude --model opus` →
 * `claude`). Windows suffixes are stripped so `claude.cmd` is still claude.
 */
export function launcherStem(agentCmd: string): string {
  const first = agentCmd.trim().split(/\s+/)[0] ?? '';
  const base = first.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * Extra env for a fan-out task pane, keyed on the launcher stem. Empty for any
 * non-claude agent and when the opt-out is set — never a partial guess.
 */
export function firstRunEnvForAgent(
  agentCmd: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!firstRunEnabled(env)) return {};
  if (!SUPPORTED_STEMS.has(launcherStem(agentCmd))) return {};
  return { [CLAUDE_SANDBOXED_ENV]: '1' };
}

// ── First-run screen detection ──────────────────────────────────────────────

/**
 * A first-run screen we recognise.
 *   - `trust`        the folder-trust dialog. NEVER auto-answered: answering it
 *                    is granting consent on the human's behalf, and candidate 2
 *                    means a worker only reaches it when the operator opted out.
 *   - `interstitial` a one-shot onboarding/upsell menu. Answered with ESC, the
 *                    dismissal the screen itself advertises.
 *   - `model-error`  the first turn came back "There's an issue with the
 *                    selected model (…)". Not a menu and not answerable by a
 *                    keystroke — reported, so the row stops claiming `working`.
 */
export type FirstRunPromptKind = 'trust' | 'interstitial' | 'model-error';

export interface FirstRunPrompt {
  kind: FirstRunPromptKind;
  /** The headline that matched — logged, so a stuck worker names its screen. */
  headline: string;
  /** `model-error` only: the model the agent named, when the screen printed it
   *  in parentheses. Absent when the message carried no name. */
  model?: string;
}

/** ESC. The only byte this module ever writes into a worker pane. */
export const FIRST_RUN_DISMISS_KEY = '\x1b';

/**
 * Known one-shot interstitials, by headline. Extending this list is the
 * intended maintenance: a screen that is not here is reported, not guessed.
 */
const INTERSTITIAL_HEADLINES: readonly { re: RegExp; label: string }[] = [
  { re: /teach auto mode about your environment/i, label: 'auto-mode environment onboarding' },
  { re: /try the new fullscreen renderer/i, label: 'fullscreen renderer upsell' },
];

/** The footer both families render under their options. */
const CONFIRM_FOOTER = /enter to confirm/i;

/**
 * The first turn's model rejection, e.g.
 * `There's an issue with the selected model (glm-5.3)`.
 *
 * Not a menu: no options, no confirm footer, nothing to press. It is here
 * because from the outside it is indistinguishable from an idle worker — the
 * exact confusion the rest of this module exists to remove — and it was the
 * failure mode of every fan-out worker in three dogfood runs (the operator's
 * `~/.zshrc` exported `ANTHROPIC_MODEL`, and the pane's login shell re-exports
 * it after wmux has set the spawn env). The launch now neutralises that (see
 * `workerLaunchCommand` in FanOutService), so this detector is the backstop for
 * every other way a worker can end up on a model it cannot use.
 *
 * The apostrophe class covers the typographic `’` a TUI may render.
 */
const MODEL_ERROR_HEADLINE = /^there[''’]s an issue with the selected model(?:\s*\(([^)\n]{1,80})\))?/i;

/** How far back from the bottom of the viewport the error may be. The port
 *  reads a 40-line tail; the error is the LAST thing the pane printed, and the
 *  lines above it are the worker's own transcript — including its prompt, which
 *  for a task ABOUT this bug quotes the message verbatim. */
const MODEL_ERROR_TAIL_LINES = 6;

/** Box/bullet furniture Claude Code draws to the left of a line. Stripped so
 *  the headline can still be ANCHORED to the start of the text. */
const SCREEN_DECORATION = /^[│┃|⎿⏺●\s]{0,4}/;

/** The prefix Claude Code puts on an echoed user message, and on the composer. */
const ECHO_MARKER = /^[>❯›]/;

/**
 * Find the model error in the tail of a viewport, refusing to read the worker's
 * own words as the agent's.
 *
 * Three guards, and all three were needed: the phrase is anchored to the start
 * of a line (a sentence mentioning it mid-line is prose), only the last few
 * lines are considered, and an echoed user message is skipped — including its
 * CONTINUATION lines, which carry no `>` of their own and are distinguishable
 * only by their indent. Without the last one, a worker whose prompt wrapped the
 * phrase onto a second line reported itself broken.
 */
function detectModelError(screen: string): FirstRunPrompt | null {
  const lines = screen.split('\n');
  let inEcho = false;
  for (const raw of lines.slice(Math.max(0, lines.length - MODEL_ERROR_TAIL_LINES))) {
    if (raw.trim().length === 0) {
      inEcho = false; // a blank line closes the echoed block.
      continue;
    }
    const indented = /^\s{2,}/.test(raw);
    const line = raw.replace(SCREEN_DECORATION, '');
    if (ECHO_MARKER.test(line)) {
      inEcho = true;
      continue;
    }
    if (inEcho && indented) continue;
    inEcho = false;
    const m = MODEL_ERROR_HEADLINE.exec(line);
    if (!m) continue;
    const model = m[1]?.trim();
    return { kind: 'model-error', headline: 'selected-model error', ...(model ? { model } : {}) };
  }
  return null;
}

/** The agent a folder-trust screen names, for the headline: Gemini CLI and
 *  Qwen Code say who will be trusted; Codex names itself, or is known by its
 *  own choice labels when it does not. */
const TRUST_SCREEN_AGENTS: readonly (readonly [RegExp, string])[] = [
  [/\bGemini CLI\b/, 'gemini'],
  [/\bQwen Code\b/, 'qwen'],
  [/\bCodex\b|Trust and continue|Yes, continue|No, quit/, 'codex'],
];

/** A screen's text with box borders dropped and rows joined, so a name or a
 *  question a narrow box wrapped still reads whole. */
function boxlessText(screen: string): string {
  return screen.split('\n').map((row) => row.replace(/[│║┃╭╮╰╯─]/g, ' ')).join(' ').replace(/\s+/g, ' ');
}

/** "gemini folder trust dialog", or "folder trust dialog" when no agent is named. */
function trustHeadline(text: string): string {
  const agent = TRUST_SCREEN_AGENTS.find(([re]) => re.test(text))?.[1];
  return agent ? `${agent} folder trust dialog` : 'folder trust dialog';
}

/**
 * Is `screen` showing a first-run prompt?
 *
 * Three conditions for an interstitial, all required: a known headline, the
 * confirm footer, and a selection-cursor option row (the same row shape the
 * approval pre-write check uses). The trust dialog is matched on its headline
 * plus the footer — its options are `No, exit` / `Yes, I trust this folder`,
 * and it is reported rather than answered anyway.
 *
 * The model error is checked FIRST and outside the footer gate: it is an error
 * line, not a menu, so it renders none of the menu furniture.
 */
export function detectFirstRunPrompt(screen: string): FirstRunPrompt | null {
  if (!screen) return null;
  const modelError = detectModelError(screen);
  if (modelError) return modelError;
  const rows = screen.split('\n');
  const hasFooter = CONFIRM_FOOTER.test(screen);
  if (hasFooter && TRUST_HEADLINE.test(screen)) return { kind: 'trust', headline: 'workspace trust dialog' };
  // Other agents' trust dialogs (Gemini CLI and Qwen Code draw no confirm
  // footer), read as the input guard reads them; one too narrow to read its
  // choices is still the dialog.
  if (readFolderTrustScreen(rows) !== null) return { kind: 'trust', headline: trustHeadline(boxlessText(screen)) };
  if (!hasFooter) return null;
  if (!looksLikeApprovalPrompt(rows)) return null;
  for (const { re, label } of INTERSTITIAL_HEADLINES) {
    if (re.test(screen)) return { kind: 'interstitial', headline: label };
  }
  return null;
}

/** Menu furniture that means "something is waiting for a keypress". */
const MENU_FOOTER = /enter to (?:confirm|continue)|press enter to/i;

export type LaunchScreen =
  /** A screen this module recognises (see detectFirstRunPrompt). */
  | { kind: 'first-run'; prompt: FirstRunPrompt }
  /** Some other menu. Nothing may be typed or pasted into it. */
  | { kind: 'blocking'; headline: string };

/**
 * Scheduled runs: what stands between a freshly launched agent and the prompt
 * paste. Known first-run screens (including codex's trust dialog) are named;
 * any other screen that shows a cursor option row, a confirm footer or the
 * key row of Claude Code's screen-reader layout is `blocking`, so an unknown
 * menu is reported instead of being pasted into. Null means the screen shows
 * no menu at all.
 */
export function classifyLaunchScreen(screen: string): LaunchScreen | null {
  if (!screen) return null;
  const known = detectFirstRunPrompt(screen);
  if (known) return { kind: 'first-run', prompt: known };
  const text = boxlessText(screen);
  if (CODEX_TRUST_HEADLINE.test(text)) return { kind: 'first-run', prompt: { kind: 'trust', headline: trustHeadline(text) } };
  const rows = screen.split('\n');
  if (looksLikeApprovalPrompt(rows) || MENU_FOOTER.test(screen) || showsScreenReaderKeyRow(rows)) {
    return { kind: 'blocking', headline: 'unrecognised menu' };
  }
  return null;
}

// ── The post-spawn watch ────────────────────────────────────────────────────

/** How long we watch a freshly spawned worker for a first-run screen. */
export const FIRST_RUN_WATCH_MS = 6_000;

/** Total budget, answers included. The plan's report deadline. */
export const FIRST_RUN_DEADLINE_MS = 30_000;

/** Gap between screen reads. */
export const FIRST_RUN_POLL_MS = 500;

/** Consecutive clean, non-empty reads that end the watch early. Two rather than
 *  one: a single clean read can be the pane before Claude Code has painted. */
export const FIRST_RUN_CLEAN_READS = 2;

/** At most this many ESCs per worker. A screen that survives three dismissals
 *  is not the family this module knows about. */
export const FIRST_RUN_MAX_ANSWERS = 3;

/**
 * F15 — how long after a CLEAN watch to look once more for the model error.
 *
 * The watch's clean-read exit fires at ~{@link FIRST_RUN_WATCH_MS}, which is
 * about when Claude Code finishes painting its composer — and the model error
 * only arrives after that, once the first turn has been sent and refused. So
 * the clean exit is routinely too early for this one screen. The caller runs
 * this re-read OFF the critical path (fan-out spawns are serial; nobody should
 * pay a longer watch N times over), which is why it can afford to be generous.
 */
export const FIRST_RUN_MODEL_RECHECK_MS = 12_000;

export interface FirstRunPort {
  /** Current viewport text of the pane. Fails soft — '' means "nothing read". */
  readScreen: (ptyId: string) => Promise<string>;
  /** Write one key sequence into the pane. May throw; the caller reports. */
  sendKey: (ptyId: string, sequence: string) => Promise<void>;
}

export type FirstRunOutcome =
  /** No first-run screen was ever seen. */
  | { status: 'clear' }
  /** One was seen and dismissed; the pane is free. */
  | { status: 'answered'; headline: string }
  /** Still on screen at the deadline, or a screen we refuse to answer. */
  | {
      status: 'stuck';
      headline: string;
      reason: 'trust' | 'unanswered' | 'send-failed' | 'model';
      /** `model` only — the model the agent named, when it printed one. */
      model?: string;
    };

export interface FirstRunWatchOptions {
  watchMs?: number;
  deadlineMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Log sink; defaults to console.warn with the [fanout:first-run] tag. */
  log?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Watch a freshly spawned worker pane and clear a known first-run screen.
 *
 * Returns as soon as the pane looks normal (two consecutive non-empty reads
 * with no first-run screen after the watch window), so the happy path costs a
 * couple of viewport reads rather than the whole window. A screen we will not
 * answer — the trust dialog — returns immediately: waiting 30 s to say "a human
 * must press this" only delays the report.
 */
export async function clearFirstRunPrompts(
  ptyId: string,
  port: FirstRunPort,
  options: FirstRunWatchOptions = {},
): Promise<FirstRunOutcome> {
  const watchMs = options.watchMs ?? FIRST_RUN_WATCH_MS;
  const deadlineMs = options.deadlineMs ?? FIRST_RUN_DEADLINE_MS;
  const pollMs = options.pollMs ?? FIRST_RUN_POLL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string): void => console.warn(`[fanout:first-run] ${m}`));

  const started = now();
  let answers = 0;
  let cleanReads = 0;
  let answeredHeadline: string | null = null;
  let lastPrompt: FirstRunPrompt | null = null;

  while (now() - started < deadlineMs) {
    let screen = '';
    try {
      screen = await port.readScreen(ptyId);
    } catch {
      // A viewport we cannot read is no evidence — keep watching.
      screen = '';
    }
    const prompt = detectFirstRunPrompt(screen);
    lastPrompt = prompt;

    if (prompt?.kind === 'trust') {
      log(
        `pane ${ptyId} is on the workspace trust dialog; wmux does not answer it. ` +
          `Set ${AGENT_FIRST_RUN_ENV}=on (the default) so the worker launches with ` +
          `${CLAUDE_SANDBOXED_ENV}, or accept the folder once by hand.`,
      );
      return { status: 'stuck', headline: prompt.headline, reason: 'trust' };
    }

    if (prompt?.kind === 'model-error') {
      // Same no-blind-press rule as the trust dialog, for the same reason: wmux
      // reports what it sees rather than typing at a screen it did not author.
      // Returning immediately is deliberate — the error is terminal for that
      // turn, so waiting out the deadline only delays the report.
      log(
        `pane ${ptyId} came back with a selected-model error` +
          `${prompt.model ? ` (${prompt.model})` : ''}; wmux does not pick a model for you. ` +
          `Run /model <model> in the pane, or stop the shell rc from exporting one.`,
      );
      return {
        status: 'stuck',
        headline: prompt.headline,
        reason: 'model',
        ...(prompt.model ? { model: prompt.model } : {}),
      };
    }

    if (prompt) {
      cleanReads = 0;
      if (answers >= FIRST_RUN_MAX_ANSWERS) {
        log(`pane ${ptyId} still shows "${prompt.headline}" after ${answers} dismissals`);
        return { status: 'stuck', headline: prompt.headline, reason: 'unanswered' };
      }
      try {
        await port.sendKey(ptyId, FIRST_RUN_DISMISS_KEY);
      } catch (err) {
        log(`could not dismiss "${prompt.headline}" on pane ${ptyId}: ${String(err)}`);
        return { status: 'stuck', headline: prompt.headline, reason: 'send-failed' };
      }
      answers += 1;
      answeredHeadline = prompt.headline;
      log(`dismissed "${prompt.headline}" on pane ${ptyId}`);
    } else if (screen.trim().length > 0) {
      cleanReads += 1;
      if (cleanReads >= FIRST_RUN_CLEAN_READS && now() - started >= watchMs) {
        return answeredHeadline
          ? { status: 'answered', headline: answeredHeadline }
          : { status: 'clear' };
      }
    }

    await sleep(pollMs);
  }

  if (lastPrompt) {
    log(`pane ${ptyId} still shows "${lastPrompt.headline}" at the deadline`);
    return { status: 'stuck', headline: lastPrompt.headline, reason: 'unanswered' };
  }
  return answeredHeadline ? { status: 'answered', headline: answeredHeadline } : { status: 'clear' };
}

/** The composer Gemini CLI and Qwen Code draw once they take a prompt (live
 *  captures; a narrow pane wraps it, inside a box's borders). */
const TRUST_WATCH_READY = /Type\s+your\s+message\s+or\s+@path/;

/** How long the trust-only watch reads: its dialog can be drawn well after
 *  launch (a slow install or auth step first). */
export const TRUST_WATCH_DEADLINE_MS = 120_000;
/** It reads at the first-run poll for this long, then every TRUST_WATCH_SLOW_POLL_MS. */
const TRUST_WATCH_FAST_MS = 30_000;
const TRUST_WATCH_SLOW_POLL_MS = 2_000;

/**
 * Watch a freshly launched worker whose agent has only a folder-trust dialog
 * to stop at (an agent row's firstRunWatch 'trust'). Reads until the dialog
 * shows (stuck), the agent's composer shows (clear), or its own deadline
 * (TRUST_WATCH_DEADLINE_MS) passes (clear), slower after the first 30 s; unlike {@link clearFirstRunPrompts} it does not stop after a few
 * calm reads, since the dialog can be drawn well after launch. Nothing is
 * ever pressed. The dialog is read with the input guard's own reader, so no
 * other text on the screen (a model error) can hide it.
 */
export async function watchFolderTrust(
  ptyId: string,
  port: FirstRunPort,
  options: Pick<FirstRunWatchOptions, 'sleep' | 'now' | 'log'> = {},
): Promise<FirstRunOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string): void => console.warn(`[fanout:first-run] ${m}`));

  const started = now();
  while (now() - started < TRUST_WATCH_DEADLINE_MS) {
    let screen = '';
    try {
      screen = await port.readScreen(ptyId);
    } catch {
      // A viewport we cannot read is no evidence — keep watching.
      screen = '';
    }
    if (readFolderTrustScreen(screen.split('\n')) !== null) {
      log(`pane ${ptyId} is on its folder trust dialog; wmux does not answer it. Accept the folder once by hand.`);
      return { status: 'stuck', headline: 'folder trust dialog', reason: 'trust' };
    }
    if (TRUST_WATCH_READY.test(boxlessText(screen))) return { status: 'clear' };
    await sleep(now() - started < TRUST_WATCH_FAST_MS ? FIRST_RUN_POLL_MS : TRUST_WATCH_SLOW_POLL_MS);
  }
  return { status: 'clear' };
}
