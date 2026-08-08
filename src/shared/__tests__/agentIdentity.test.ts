// Guards the invariants that the six hand-synced slug tables used to violate.
//
// The bug this file exists to prevent already shipped once:
// `agentCandidateSeed.ts` listed seven of the eight slugs, and
// `] satisfies AgentSlug[]` did not catch it because `satisfies` rejects EXTRA
// members but never OMISSIONS. Every consumer now derives from
// `AGENT_IDENTITIES`, so the parity assertions below are really asserting that
// nobody has quietly reintroduced a second list.

import { describe, expect, it } from 'vitest';

import {
  AGENT_IDENTITIES,
  AGENT_SLUGS,
  AGENT_SLUG_SET,
  agentDisplayToSlug,
  agentSlugToDisplay,
  isAgentSlug,
} from '../agentIdentity';
import { asRecoveryAgentSlug } from '../ptyRecovery';
import { isAgentSignal } from '../hooks/signal-types';
import { asAgentSlug } from '../../renderer/channels/agentCandidateSeed';

describe('agent identity table', () => {
  it('has no duplicate slugs or display names', () => {
    const slugs = AGENT_IDENTITIES.map((a) => a.slug);
    const displays = AGENT_IDENTITIES.map((a) => a.display);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(displays).size).toBe(displays.length);
  });

  it('keeps every slug safe for HookSignalRouter key construction', () => {
    // `key()` builds `${slug}:${ptyId}:${kind}` and `dropPty` scans for
    // `:${ptyId}:`. A slug containing `:` would make that scan ambiguous.
    for (const slug of AGENT_SLUGS) {
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(slug).not.toContain(':');
    }
  });

  it('round-trips slug → display → slug for every agent', () => {
    for (const { slug, display } of AGENT_IDENTITIES) {
      expect(agentSlugToDisplay(slug)).toBe(display);
      expect(agentDisplayToSlug(display)).toBe(slug);
    }
  });

  it('returns undefined for an unknown display name rather than throwing', () => {
    expect(agentDisplayToSlug('Some Other CLI')).toBeUndefined();
    expect(agentDisplayToSlug('')).toBeUndefined();
  });

  it('narrows only known slugs', () => {
    expect(isAgentSlug('claude')).toBe(true);
    expect(isAgentSlug('Claude Code')).toBe(false);
    expect(isAgentSlug('nope')).toBe(false);
    expect(isAgentSlug(undefined)).toBe(false);
    expect(isAgentSlug(42)).toBe(false);
  });
});

describe('every slug consumer accepts the whole table', () => {
  // Each of these used to carry its own copy of the list. If a future change
  // reintroduces a local list that misses an agent, exactly one of these fails
  // and names the agent.

  it('asRecoveryAgentSlug (resume binding)', () => {
    for (const slug of AGENT_SLUGS) {
      expect(asRecoveryAgentSlug(slug)).toBe(slug);
    }
    expect(asRecoveryAgentSlug('nope')).toBeUndefined();
    expect(asRecoveryAgentSlug(undefined)).toBeUndefined();
  });

  it('isAgentSignal (daemon RPC envelope guard)', () => {
    for (const slug of AGENT_SLUGS) {
      expect(
        isAgentSignal({
          kind: 'agent.stop',
          agent: slug,
          cwd: 'D:\\wmux',
          ts: 1,
          payload: {},
        }),
      ).toBe(true);
    }
    expect(
      isAgentSignal({ kind: 'agent.stop', agent: 'nope', cwd: 'D:\\wmux', ts: 1, payload: {} }),
    ).toBe(false);
  });

  it('asAgentSlug (channel candidate seeding) accepts BOTH shapes', () => {
    // REGRESSION: `openclaude` was absent from this consumer's local set, so a
    // slug-shaped 'openclaude' fell through to the display→slug map (which only
    // knows 'OpenClaude') and returned undefined, dropping the '(openclaude)'
    // suffix from the auto-name.
    for (const { slug, display } of AGENT_IDENTITIES) {
      expect(asAgentSlug(slug)).toBe(slug);
      expect(asAgentSlug(display)).toBe(slug);
    }
    expect(asAgentSlug('some-other-agent')).toBeUndefined();
  });

  it('AGENT_SLUG_SET matches AGENT_SLUGS exactly', () => {
    expect(AGENT_SLUG_SET.size).toBe(AGENT_SLUGS.length);
    for (const slug of AGENT_SLUGS) expect(AGENT_SLUG_SET.has(slug)).toBe(true);
  });
});
