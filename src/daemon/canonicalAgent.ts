// Canonical pane-agent identity — the tier rule from issue #919.
//
// A pane's agent used to be decided by ONE signal: what the terminal printed
// (AgentDetector's screen gates), which cannot tell an agent from a sentence
// about an agent (#916: a Grok pane labelled Claude, twice). This module folds
// the three available signals into one precedence:
//
//   hook self-report  >  process image truth  >  screen chrome
//
// The hook tier is NOT unconditional: a hook authority is a 30-minute map
// entry, and letting it win on age alone reproduces #916 for half an hour
// after the agent exits (the panel's top finding). A hook wins only when
// CORROBORATED (a live same-slug process) or when FRESH and exactly routed
// and uncontradicted. Process truth — a live attributed process — beats both
// a stale hook and the screen. The screen stays the fallback for panes we
// cannot attribute (remote/SSH), which is why AgentDetector is untouched.
//
// Pure on purpose: no tracker/router imports, no clock, no I/O — the daemon
// reads its two maps and passes snapshots in, so every tier combination is
// unit-testable without a process table.
import type { AgentSlug } from '../shared/agentIdentity';

/**
 * How long an UNCORROBORATED hook authority may decide identity on its own.
 * Deliberately NOT the 30-min veto TTL (HOOK_AUTHORITY_TTL_MS) — that window
 * spans long quiet tool calls for notification suppression, but an identity
 * claim riding a stale entry would mislabel the pane's next agent. Bridge
 * hooks fire per tool use, so a live bridge re-signals well inside 2 minutes.
 * Corroboration (a live same-slug process) bypasses age entirely.
 */
export const IDENTITY_TTL_MS = 2 * 60_000;

/** What the tracker knows about the pane's attributed process, if any.
 *  `slug` undefined = attributed a slugless pick (wrapper/direct child) —
 *  its liveness still participates, its name does not. */
export interface CanonicalProcessState {
  slug?: AgentSlug;
  alive: boolean;
}

/** What the hook authority map knows: the last bridge agent for this pane,
 *  how recently it signaled, and whether the signal was routed by exact
 *  ptyId (trusted to stand alone) or the cwd-prefix fallback (may only
 *  corroborate — it can attach to a neighboring pane). */
export interface CanonicalHookAuthority {
  slug: AgentSlug;
  ageMs: number;
  exact: boolean;
}

export interface CanonicalAgentIdentity {
  slug: AgentSlug;
  source: 'hook' | 'process' | 'screen';
}

/**
 * The tier rule. Rows, in order:
 *
 *  1. Residue veto — the tracked agent is CONFIRMED DEAD and the screen still
 *     says the same slug: that is the detector's sticky residue, not a live
 *     agent. No identity (a genuine relaunch re-arms the tracker first).
 *  2. Corroborated hook — a live same-slug process backs the authority.
 *     Age and routing are irrelevant here: the process IS the evidence.
 *  3. Fresh exact-routed hook, uncontradicted — the bridge signaled within
 *     IDENTITY_TTL and was routed by exact ptyId, and no live process of a
 *     DIFFERENT slug contradicts it. A dead or slugless tracked process does
 *     not contradict (the hook may be the relaunch; the pick may be the
 *     wrapper the agent runs under).
 *  4. Live process truth — an attributed, live process beats a stale hook
 *     and the screen. This row is the #916 fix: after claude exits and codex
 *     re-arms the tracker, claude's stale authority cannot win.
 *  5. Screen — the fallback for unattributable panes (remote/SSH).
 */
export function resolveCanonicalAgentIdentity(inputs: {
  proc?: CanonicalProcessState;
  auth?: CanonicalHookAuthority;
  screenSlug?: AgentSlug;
  identityTtlMs?: number;
}): CanonicalAgentIdentity | undefined {
  const ttl = inputs.identityTtlMs ?? IDENTITY_TTL_MS;
  const { proc, auth, screenSlug } = inputs;

  if (proc?.slug && !proc.alive && proc.slug === screenSlug) return undefined;
  if (auth && proc?.slug === auth.slug && proc.alive) {
    return { slug: auth.slug, source: 'hook' };
  }
  const contradictedByLiveProcess =
    proc?.slug !== undefined && proc.slug !== auth?.slug && proc.alive;
  if (auth?.exact && auth.ageMs <= ttl && !contradictedByLiveProcess) {
    return { slug: auth.slug, source: 'hook' };
  }
  if (proc?.slug && proc.alive) return { slug: proc.slug, source: 'process' };
  if (screenSlug) return { slug: screenSlug, source: 'screen' };
  return undefined;
}
