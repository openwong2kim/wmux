// 4d (channels remediation) — boot-time agent-candidate seeding.
//
// Symptom: right after `npm start`, live (recovered) agent panes in
// workspaces the user has not VISITED yet never show up in the "Add an
// agent pane" roster picker or the @-mention candidates. Candidate
// eligibility is gated on `surfaceAgent[ptyId]?.name`, and that map is
// populated only by live agent detection (banner gate → session:agent →
// useNotificationListener), which fires on terminal output — an unvisited
// workspace produces none.
//
// Fix: at boot hydration (the same pty.list pass that seeds supervision /
// resume state), ask the daemon's AgentDetector directly for each session
// that has no surfaceAgent entry yet (`metadata.resolveAgent`, the same
// authoritative pull the running-status backfill uses) and seed the map.
// Live detection later overwrites the seed (setSurfaceAgent keeps newer
// names/statuses), so a stale seed self-heals on visit.
//
// Pure decision logic lives here (repo precedent: planChannelMessageDelivery,
// authorDisplay) so the seeding rules are unit-testable without mounting
// AppLayout.

import { agentDisplayToSlug, isAgentSlug, type AgentSlug } from '../../shared/agentIdentity';

/** Narrow a daemon-reported agent identity to a known slug. The daemon's
 *  `getAgentName` returns the DISPLAY name ('Claude Code'), not the slug —
 *  Codex review #1: treating it as a slug seeded candidates whose auto-name
 *  lost the '(claude)' suffix. Accept both shapes: slug passthrough for
 *  slug-shaped inputs, the canonical display→slug table for display-shaped
 *  ones. Unknown values seed the name without a slug (the auto-name suffix
 *  stays generic instead of lying).
 *
 *  Both lookups now come from the shared identity table. The hand-written set
 *  this used to carry was missing `openclaude`, so a slug-shaped 'openclaude'
 *  fell through to the display→slug map — which only knows 'OpenClaude' — and
 *  returned undefined, reintroducing exactly the suffix loss described above
 *  for one agent. */
export function asAgentSlug(name: string): AgentSlug | undefined {
  if (isAgentSlug(name)) return name;
  return agentDisplayToSlug(name);
}

// Panes already asked this app-run. Without this, every daemon:connected
// re-runs hydrate and re-fans-out resolveAgent to every NON-agent pane
// (plain shells never gain a surfaceAgent entry, so the name-gate alone
// never filters them — Claude review #5). Module-scoped like the mention
// rate-limit ledgers; reset seam for tests.
const seedAttempted = new Set<string>();

/** Mark a pane as attempted regardless of outcome (call when the resolve
 *  settles). A later LIVE detection still lands via its own path. */
export function markSeedAttempted(ptyId: string): void {
  seedAttempted.add(ptyId);
}

export function __resetSeedAttemptedForTests(): void {
  seedAttempted.clear();
}

/**
 * Which hydrated sessions need a boot-time agent-identity pull? Only those
 * with NO detected name yet and not already attempted this run — a live
 * detection (or a previous seed) must never be re-queried or overwritten
 * by a slower boot pull.
 */
export function planAgentCandidateSeed(
  sessionIds: readonly string[],
  surfaceAgent: Readonly<Record<string, { name: string } | undefined>>,
): string[] {
  return sessionIds.filter(
    (id) => id.length > 0 && !surfaceAgent[id]?.name && !seedAttempted.has(id),
  );
}

/**
 * Which panes can be named from the daemon's PROCESS truth (`pty.list`
 * `liveAgent`) right now? A resumed agent with no session-start hook (Codex)
 * whose banner the detector missed has no other name source until its first
 * turn ends, and the resolveAgent seed above is one-shot per pane and runs
 * before the user relaunches anything.
 *
 * Runs after the known-gone wipe and never contradicts it: a pane whose agent
 * process was seen dying, or whose shell is back at its prompt, is skipped.
 * A pane already named for the SAME agent keeps its entry — live detection and
 * hooks carry status this seed does not know. A pane named for a different
 * agent is renamed: the live process outranks a stale label (the #919 tier
 * rule), which is what a quick exit-and-relaunch leaves behind.
 *
 * Status: `running` while OSC 133 says the agent owns the terminal — the same
 * synthetic value identity-only hydration uses, which the roster shows as idle
 * until activity or a hook proves a turn — and `idle` otherwise.
 */
export function planLiveAgentSeed(
  sessions: ReadonlyArray<{ id: string; liveAgent?: string }>,
  surfaceAgent: Readonly<Record<string, { name: string; slug?: string } | undefined>>,
  agentAlive: Readonly<Record<string, boolean>>,
  commandRunning: Readonly<Record<string, boolean>>,
): Array<{ ptyId: string; slug: AgentSlug; status: 'running' | 'idle' }> {
  const seeds: Array<{ ptyId: string; slug: AgentSlug; status: 'running' | 'idle' }> = [];
  for (const { id, liveAgent } of sessions) {
    if (!id || !isAgentSlug(liveAgent)) continue;
    const existing = surfaceAgent[id];
    if (existing?.name && (existing.slug ?? agentDisplayToSlug(existing.name)) === liveAgent) continue;
    if (agentAlive[id] === false || commandRunning[id] === false) continue;
    seeds.push({ ptyId: id, slug: liveAgent, status: commandRunning[id] === true ? 'running' : 'idle' });
  }
  return seeds;
}
