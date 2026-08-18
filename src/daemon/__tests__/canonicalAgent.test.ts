import { describe, it, expect } from 'vitest';
import { IDENTITY_TTL_MS, resolveCanonicalAgentIdentity, detectorSuppressedBy } from '../canonicalAgent';
import type { AgentSlug } from '../../shared/agentIdentity';

const proc = (slug: AgentSlug | undefined, alive: boolean) =>
  slug === undefined ? { alive } : { slug, alive };
const auth = (slug: AgentSlug, ageMs: number, exact = true) => ({ slug, ageMs, exact });

describe('resolveCanonicalAgentIdentity (#919 tier rule)', () => {
  it('a live DIFFERENT-slug process beats even a fresh hook — the #916 regression guard', () => {
    // claude exited, codex banner re-armed the tracker; claude's authority is
    // 30 seconds old and exactly routed. The label must still be codex.
    expect(
      resolveCanonicalAgentIdentity({
        proc: proc('codex', true),
        auth: auth('claude', 30_000),
        screenSlug: 'codex',
      }),
    ).toEqual({ slug: 'codex', source: 'process' });
  });

  it('an unarmed tracker + fresh exact-routed hook → hook wins', () => {
    expect(
      resolveCanonicalAgentIdentity({ auth: auth('claude', 30_000), screenSlug: 'grok' }),
    ).toEqual({ slug: 'claude', source: 'hook' });
  });

  it('corroboration bypasses age and routing: a 25-min-old cwd-routed hook with a live same-slug process wins', () => {
    expect(
      resolveCanonicalAgentIdentity({
        proc: proc('claude', true),
        auth: auth('claude', 25 * 60_000, false),
      }),
    ).toEqual({ slug: 'claude', source: 'hook' });
  });

  it('a non-exact (cwd-guessed) authority never stands alone', () => {
    expect(
      resolveCanonicalAgentIdentity({
        auth: auth('claude', 30_000, false),
        screenSlug: 'grok',
      }),
    ).toEqual({ slug: 'grok', source: 'screen' });
  });

  it('a dead slugless tracked pick does not contradict a stale hook → screen wins', () => {
    expect(
      resolveCanonicalAgentIdentity({
        proc: proc(undefined, false),
        auth: auth('claude', 10 * 60_000),
        screenSlug: 'grok',
      }),
    ).toEqual({ slug: 'grok', source: 'screen' });
  });

  it('a stale hook for a dead process loses to the screen', () => {
    expect(
      resolveCanonicalAgentIdentity({
        proc: proc('claude', false),
        auth: auth('claude', 10 * 60_000),
        screenSlug: 'grok',
      }),
    ).toEqual({ slug: 'grok', source: 'screen' });
  });

  it('residue veto: a confirmed-dead same-slug screen read is not an agent', () => {
    // No live hook backs the residue — the death edge expired the authority,
    // so the strongest voice left is the detector's sticky banner.
    expect(
      resolveCanonicalAgentIdentity({
        proc: proc('claude', false),
        screenSlug: 'claude',
      }),
    ).toBeUndefined();
    // A cwd-guessed authority cannot stand alone — and must not rescue the
    // screen read from the veto either.
    expect(
      resolveCanonicalAgentIdentity({
        proc: proc('claude', false),
        auth: auth('claude', 30_000, false),
        screenSlug: 'claude',
      }),
    ).toBeUndefined();
  });

  it('a fresh exact hook rescues the same-slug screen read from the veto (relaunch inside the arm backoff)', () => {
    // GLM panel #919: same-slug relaunch within the 30s failure backoff —
    // the tracker entry is stale-dead, but a live bridge just re-signaled
    // from this exact ptyId. That is the relaunch, not residue; without the
    // rescue the pane's label nulls for up to the backoff window.
    expect(
      resolveCanonicalAgentIdentity({
        proc: proc('claude', false),
        auth: auth('claude', 5_000),
        screenSlug: 'claude',
      }),
    ).toEqual({ slug: 'claude', source: 'hook' });
    // Past IDENTITY_TTL the hook can no longer vouch: residue again.
    expect(
      resolveCanonicalAgentIdentity({
        proc: proc('claude', false),
        auth: auth('claude', IDENTITY_TTL_MS + 1),
        screenSlug: 'claude',
      }),
    ).toBeUndefined();
  });

  it('no attribution at all → screen tier (remote/SSH pane); nothing → undefined', () => {
    expect(resolveCanonicalAgentIdentity({ screenSlug: 'gemini' })).toEqual({
      slug: 'gemini',
      source: 'screen',
    });
    expect(resolveCanonicalAgentIdentity({})).toBeUndefined();
  });

  it('IDENTITY_TTL_MS is minutes, not the 30-min veto window', () => {
    expect(IDENTITY_TTL_MS).toBe(120_000);
    expect(
      resolveCanonicalAgentIdentity({
        auth: auth('claude', IDENTITY_TTL_MS + 1),
        screenSlug: 'grok',
      }),
    ).toEqual({ slug: 'grok', source: 'screen' });
  });
});

describe('detectorSuppressedBy (#919 detector veto)', () => {
  it('suppresses a screen read contradicted by a tier-1/2 identity', () => {
    expect(detectorSuppressedBy({ slug: 'codex', source: 'process' }, 'claude')).toBe(true);
    expect(detectorSuppressedBy({ slug: 'codex', source: 'hook' }, 'claude')).toBe(true);
  });

  it('lets an agreeing read through', () => {
    expect(detectorSuppressedBy({ slug: 'claude', source: 'process' }, 'claude')).toBe(false);
  });

  it('never vetoes on the screen tier — nothing stronger than the screen itself', () => {
    expect(detectorSuppressedBy({ slug: 'codex', source: 'screen' }, 'claude')).toBe(false);
  });

  it('lets an unconstrained event through', () => {
    expect(detectorSuppressedBy(undefined, 'claude')).toBe(false);
  });

  it('does NOT veto a display name this build cannot map', () => {
    // An unmappable banner (a new agent, a renamed one) says nothing about
    // identity. These events carry status and liveness too, so treating
    // "could not parse" as "contradicted" cost the pane its running/idle
    // updates over a name we merely failed to read.
    expect(detectorSuppressedBy({ slug: 'codex', source: 'process' }, undefined)).toBe(false);
    expect(detectorSuppressedBy({ slug: 'codex', source: 'hook' }, undefined)).toBe(false);
  });
});
