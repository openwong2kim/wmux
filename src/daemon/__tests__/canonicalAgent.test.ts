import { describe, it, expect } from 'vitest';
import { IDENTITY_TTL_MS, resolveCanonicalAgentIdentity } from '../canonicalAgent';
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
    expect(
      resolveCanonicalAgentIdentity({
        proc: proc('claude', false),
        auth: auth('claude', 30_000),
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
