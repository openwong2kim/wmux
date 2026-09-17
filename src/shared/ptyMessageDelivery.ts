/** Utilities for safe PTY delivery of structured inter-agent messages. */

import { agentDisplayToSlug, isAgentSlug, type AgentSlug } from './agentIdentity';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const VISIBLE_ESCAPE = '␛';

/**
 * Escape raw ESC bytes before wrapping a bracketed paste payload. Otherwise a
 * malicious body could include ESC [ 201 ~ to close the bracketed paste early.
 */
export function sanitizeBracketedPastePayload(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b/g, VISIBLE_ESCAPE);
}

export function formatBracketedPastePayload(text: string): string {
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPastePayload(text)}${BRACKETED_PASTE_END}`;
}

export function isMultilinePtyPayload(text: string): boolean {
  return text.includes('\n') || text.includes('\r');
}

// ---------------------------------------------------------------------------
// Per-agent submit profile (#1337)
// ---------------------------------------------------------------------------
//
// Every structured message wmux pushes into an agent pane is written as two
// separate PTY writes: the bracketed paste, then Enter after a gap.
//
//   t=0                      t=SUBMIT DELAY
//   ├── ESC[200~ … ESC[201~  ├── '\r'
//   │   (paste lands in the  │   (agent's composer submits — or does not)
//   │    agent's composer)   │
//
// The gap is not cosmetic. A TUI that classifies a rapid run of input as a
// paste (Codex ships `tui/src/bottom_pane/paste_burst.rs` and a
// `disable_paste_burst` config key) absorbs an Enter that arrives while the
// burst is still open, so the nudge is left sitting in the composer and the
// agent never starts a turn. That is #1337.
//
// MEASURED, not reasoned. codex-cli 0.154.0, driven through a real ConPTY on
// Windows, fed the exact bytes this function writes (bracketed paste, wait,
// CR), screen read back with a headless terminal and scored on the COMPOSER:
// a composer showing its placeholder took the draft, a composer still holding
// the nudge did not.
//
//     gap     paste had reached the composer    nudge stranded
//             by the time the CR was written
//     100 ms  5 of 20 runs                      2 of 20 runs
//     500 ms  10 of 10 runs                     0 of 10 runs
//
// The RACE is the durable finding, not the rate. At 100 ms the Enter is
// usually written into a composer that has not received the paste yet, and the
// nudge is then intermittently lost. At 500 ms the paste had landed first,
// every time. The stranding itself is bursty — both failures above fell in one
// batch of ten, and a second machine running the same binary and probe saw 12
// of 12 submit at 100 ms — so a short clean run does not disprove it and a
// short bad run does not size it.
//
// Do not trust any "stranded" count taken before this scorer existed: the
// earlier one keyed on the "Working" footer, which disappears as soon as the
// turn fails, so it miscounted submitted runs as stranded. It could not
// produce the opposite error, so its "submitted" observations still stand —
// which is why 300, 350, 400, 600, 800, 1000 and 2000 ms are all still known
// to submit.
//
// Two facts are keyed off the same signal, so they live in one table rather
// than two parallel ones that can drift:
//
//   submitDelayMs — how long to wait before Enter.
//   assurance     — whether wmux may claim the Enter actually started a turn.
//
// `assured` is reserved for Claude Code: wmux has a hook bridge that proves
// turn start there (agent.user_prompt_submit / agent.stop) and the whole of
// its dogfood history behind a bare CR. Every other agent, Codex included, is
// `unverified` — wmux writes the bytes and has no way to learn whether the
// composer took them. Same discipline as `keystrokesForAgent` in
// `src/daemon/approvals/approvalKeystrokes.ts`: an agent we have not measured
// gets the conservative answer, never a guess.
//
// UNKNOWN IS UNVERIFIED. A pane whose agent we cannot name may be a bare
// shell, a remote session, or an agent this build predates. None of those is
// evidence that Enter submitted anything.

/** Whether wmux can vouch that a written Enter actually submitted the draft. */
export type SubmitAssurance = 'assured' | 'unverified';

export interface AgentSubmitProfile {
  /** Gap between the bracketed paste and the Enter that submits it. */
  submitDelayMs: number;
  assurance: SubmitAssurance;
}

/**
 * The gap that has always been used, and the only one with production proof
 * behind it (Claude Code panes, every A2A nudge since the feature shipped).
 */
export const DEFAULT_SUBMIT_DELAY_MS = 100;

/**
 * The gap for agents that run a paste-burst heuristic on their input. See the
 * measurement table above for where this number comes from. It is sized to
 * close a race, not to beat an exact threshold: 500 ms is where the paste was
 * observed to have reached the composer before the Enter in every run.
 *
 * The tradeoff being accepted: a wider gap is also a wider window in which a
 * human can type into the same composer before our Enter lands, submitting a
 * mixed draft. The nudge path has never guarded that (unlike
 * `deliverScheduledPrompt`, which aborts when the input revision moved), so
 * this trades a rare mixed draft for a nudge that actually arrives. The old
 * 100 ms was not a safe window either, just a narrower one.
 */
export const PASTE_BURST_SUBMIT_DELAY_MS = 500;

/**
 * Agents known to classify rapid input as a paste, so an Enter written too
 * soon after the paste is swallowed by the burst instead of submitting.
 *
 * Codex only, and only because the heuristic is named in the shipped binary.
 * Adding a slug here is a claim about that agent's input handling; make it
 * from a measurement, not from a family resemblance.
 */
const PASTE_BURST_AGENTS: ReadonlySet<AgentSlug> = new Set<AgentSlug>(['codex']);

/**
 * Agents whose Enter wmux may report as a real submit. Deliberately one entry
 * — see the header. Widening this set means claiming a receipt on the
 * sender's behalf, so it needs the same kind of evidence Claude's hook bridge
 * provides, not a successful manual test.
 */
const SUBMIT_ASSURED_AGENTS: ReadonlySet<AgentSlug> = new Set<AgentSlug>(['claude']);

/**
 * A pane state in which even Claude's Enter does not start a turn: the TUI is
 * showing a question or approval dialog, so the CR ANSWERS the dialog. Reported
 * by the AskUserQuestion hook and by the detector's approval-prompt regexes.
 */
const AWAITING_INPUT_STATUS = 'awaiting_input';

/**
 * Resolve the submit profile for a pane.
 *
 * `agent` is whatever the caller has: the canonical slug, or the DISPLAY name
 * the renderer carries in `surfaceAgent[ptyId].name` / workspace metadata
 * ("Codex CLI", not "codex"). Both are accepted because both are what call
 * sites actually hold, and a display name silently failing to match the table
 * would be an invisible regression to the old global behavior.
 *
 * `agentStatus` only ever narrows `assurance`, never widens it. An ABSENT
 * status stays assured for Claude: a Claude composer takes a CR as a submit,
 * which is the behavior every nudge has relied on. It is specifically
 * `awaiting_input` that breaks the claim, because there the CR is an answer to
 * a dialog rather than the start of a turn.
 */
export function submitProfileForAgent(
  agent?: string | null,
  agentStatus?: string | null,
): AgentSubmitProfile {
  const slug = resolveAgentSlug(agent);
  const assured =
    !!slug && SUBMIT_ASSURED_AGENTS.has(slug) && agentStatus !== AWAITING_INPUT_STATUS;
  return {
    submitDelayMs:
      slug && PASTE_BURST_AGENTS.has(slug) ? PASTE_BURST_SUBMIT_DELAY_MS : DEFAULT_SUBMIT_DELAY_MS,
    assurance: assured ? 'assured' : 'unverified',
  };
}

/**
 * Accept a slug or a display name; anything else resolves to no agent. Both
 * lookups come from `agentIdentity`'s canonical table, so a newly added agent
 * is recognised here without touching this file — while the behavior tables
 * above stay explicit opt-in.
 */
function resolveAgentSlug(agent?: string | null): AgentSlug | undefined {
  if (!agent) return undefined;
  return agentDisplayToSlug(agent) ?? (isAgentSlug(agent) ? agent : undefined);
}
