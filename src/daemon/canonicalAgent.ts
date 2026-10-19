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
import { agentSlugToDisplay, type AgentSlug } from '../shared/agentIdentity';

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
  /**
   * How long ago the deciding signal was seen, when it was not seen just now:
   * set only for an uncorroborated hook, which may be an authority entry up
   * to IDENTITY_TTL old. A live process (alone or corroborating a hook) and
   * the screen are observed now.
   */
  observedAgoMs?: number;
}

/**
 * The tier rule. Rows, in order:
 *
 *  1. Residue veto — the tracked agent is CONFIRMED DEAD and the screen still
 *     says the same slug: that is the detector's sticky residue, not a live
 *     agent. No identity — UNLESS a fresh exact-routed hook backs the same
 *     slug: that is the relaunch itself (a live bridge fired from this very
 *     ptyId; the tracked entry is merely stale because the relaunch's arm()
 *     can sit out the failure backoff), and row 3 must be allowed to answer.
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

  if (
    proc?.slug && !proc.alive && proc.slug === screenSlug
    && !(auth?.exact && auth.ageMs <= ttl)
  ) return undefined;
  if (auth && proc?.slug === auth.slug && proc.alive) {
    return { slug: auth.slug, source: 'hook' };
  }
  const contradictedByLiveProcess =
    proc?.slug !== undefined && proc.slug !== auth?.slug && proc.alive;
  if (auth?.exact && auth.ageMs <= ttl && !contradictedByLiveProcess) {
    return { slug: auth.slug, source: 'hook', observedAgoMs: auth.ageMs };
  }
  if (proc?.slug && proc.alive) return { slug: proc.slug, source: 'process' };
  if (screenSlug) return { slug: screenSlug, source: 'screen' };
  return undefined;
}

/**
 * #919 — the suppression test shared by both detector-emission sites: a
 * DETECTOR-origin event whose screen slug is contradicted by a tier-1/2
 * (hook/process) canonical identity must not broadcast at all — a false
 * detection should not notify, which also beats relabeling it. Screen-tier
 * canonical (nothing stronger than the screen itself) and unconstrained
 * events (canonical undefined) broadcast unchanged.
 *
 * An ABSENT screen slug is not a contradiction. A display name this build
 * cannot map (a new agent, a renamed banner) says nothing about identity, and
 * these events carry status and liveness as well as a label — suppressing them
 * would cost the pane its running/idle updates over a name we merely failed to
 * parse. resolveCanonicalAgentIdentity already treats an absent slug as "no
 * constraint"; this test has to agree with it.
 */
export function detectorSuppressedBy(
  canonical: CanonicalAgentIdentity | undefined,
  screenSlug?: AgentSlug,
): boolean {
  if (screenSlug === undefined) return false;
  return canonical !== undefined && canonical.source !== 'screen' && canonical.slug !== screenSlug;
}

/**
 * May this identity be written to the pane's persisted `lastDetectedAgent`?
 *
 * `lastDetectedAgent` is the sole basis of the post-restart resume pill, and
 * a screen-tier identity is the weakest evidence there is: a banner row the
 * detector matched with no process or hook behind it. That is enough to
 * NAME a pane that has no agent yet (the first banner on an unarmed pane,
 * before the probe lands), but not to FLIP a pane that already names one.
 * The flip is how a Claude pane became "codex" for the pill: a Claude reply
 * quoting Codex's banner row, a shell echo after Claude exited — persisted
 * with saveImmediate, surviving the restart, and contradicting the Claude
 * resume binding the hook had written. A hook or a live process may still
 * change the name; the user switching agents in a pane is seen by the
 * tracker as a launch, which is process-tier.
 */
export function mayPersistIdentity(
  current: AgentSlug | undefined,
  canonical: CanonicalAgentIdentity,
): boolean {
  if (current === canonical.slug) return false;
  if (!current) return true;
  return canonical.source !== 'screen';
}

/**
 * Record a canonical identity on the pane's persisted meta. Returns true when
 * the meta changed and must be saved.
 *
 * The one writer for every site that learns identity: a detector event, a
 * process launch or death edge, and a hook signal. The hook site is what
 * corrects a rename the screen tier was refused: Claude persisted, the user
 * starts Codex, Codex's banner arrives before the probe attributes it (screen
 * tier, refused), and attribution then fails; Codex's own exact hook resolves
 * hook-tier through the same freshness, routing and process-contradiction
 * rules and renames the pane here.
 *
 * The evidence stamp is upgraded once when a hook or a live process proves a
 * name the screen tier (or a legacy write) set, so a later launch can be told
 * from a guess without a write per event. It is also refreshed when the
 * pane's saved conversation belongs to another agent and was captured after
 * the stamp, but before the signal now seen: the recovery pill trusts the
 * name over that binding only when the stamp is the newer of the two. The
 * stamp is the time the signal was observed, not the time it was recorded,
 * so a hook authority cached before the binding cannot outrank it, and a
 * binding stamped ahead of the clock is left to win rather than rewritten
 * on every hook signal. That costs at most one write per binding capture.
 */
export function recordPaneIdentity(
  meta: {
    lastDetectedAgent?: AgentSlug;
    lastDetectedAgentEvidence?: { source: CanonicalAgentIdentity['source']; at: number };
    resumeBinding?: { agent: string; ts: number };
  },
  canonical: CanonicalAgentIdentity | undefined,
  now: number,
): boolean {
  if (!canonical) return false;
  const observedAt = now - (canonical.observedAgoMs ?? 0);
  if (meta.lastDetectedAgent === canonical.slug) {
    if (canonical.source === 'screen') return false;
    const stamp = meta.lastDetectedAgentEvidence;
    const proven = stamp?.source === 'hook' || stamp?.source === 'process';
    const binding = meta.resumeBinding;
    const outdatedByBinding = proven && binding !== undefined && binding.agent !== canonical.slug
      && typeof binding.ts === 'number' && binding.ts >= (stamp?.at ?? Infinity) && observedAt > binding.ts;
    if (proven && !outdatedByBinding) return false;
  } else if (!mayPersistIdentity(meta.lastDetectedAgent, canonical)) {
    return false;
  }
  meta.lastDetectedAgent = canonical.slug;
  meta.lastDetectedAgentEvidence = { source: canonical.source, at: observedAt };
  return true;
}

/** #1307 — true only when the tracked process is alive and of the
 *  expected slug, the one tier with a death edge; hook and screen
 *  carry none, so neither can stand in for this check. */
export function provesLiveAgent(
  proc: CanonicalProcessState | undefined,
  expectedSlug: AgentSlug,
): boolean {
  return proc?.alive === true && proc.slug === expectedSlug;
}

/**
 * #1303 — the agent name readDaemonAgentState reports for a pane, decided
 * from canonical identity rather than the detector's sticky screen read.
 *
 * An ABSENT detector name is not "no agent". A resumed or named Claude session
 * titles the terminal with the session name and draws no banner, so the
 * detector never names it while the hook and process tiers already know the
 * agent. The caller resolves `canonical` with `screenSlug` included; this only
 * picks the label.
 */
export function reportedAgentName(inputs: {
  rawName?: string | null;
  screenSlug?: AgentSlug;
  canonical?: CanonicalAgentIdentity;
}): string | null {
  const { rawName, screenSlug, canonical } = inputs;
  if (canonical) return agentSlugToDisplay(canonical.slug);
  // #919 residue veto: a mappable screen slug with no canonical backing is
  // sticky detector residue, not a live agent.
  if (!rawName || screenSlug) return null;
  return rawName;
}

/**
 * Whether a pane's agent is running right now, read off the daemon's
 * canonical agent state (`readDaemonAgentState`). `/api/sessions` rows carry it
 * as `agentAlive`, and a transcript binding's `/turns` `agentAlive` takes its
 * live half from the same call (and adds that the live agent owns the bound
 * conversation), so a `false` here is never a `true` there.
 *
 * - `true`: a live, attributed process of the pane's canonical agent
 *   (`agentVerified`, see provesLiveAgent).
 * - `false`: the daemon names no agent for the pane. The shell is back at its
 *   prompt, the tracked agent died, or no hook, process or screen evidence
 *   names one. A sticky `lastDetectedAgent` is no evidence here.
 * - `undefined`: the daemon cannot tell. An agent is named (a fresh hook or
 *   the screen) but no live process proves it yet, or the reader has no state.
 */
export function agentAliveVerdict(
  state: { agentName: string | null; agentVerified?: boolean } | undefined,
): boolean | undefined {
  if (state?.agentVerified === undefined) return undefined;
  if (state.agentVerified) return true;
  return state.agentName === null ? false : undefined;
}
