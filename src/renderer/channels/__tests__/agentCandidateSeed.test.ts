// 4d — boot-time agent-candidate seeding decision logic.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  planAgentCandidateSeed,
  planLiveAgentSeed,
  asAgentSlug,
  markSeedAttempted,
  __resetSeedAttemptedForTests,
} from '../agentCandidateSeed';

beforeEach(() => {
  __resetSeedAttemptedForTests();
});

describe('planAgentCandidateSeed', () => {
  it('picks only sessions with no detected agent name yet', () => {
    const surfaceAgent = {
      'pty-live': { name: 'claude' },       // already detected — never re-pulled
      'pty-empty-name': { name: '' },        // empty name = not detected
    } as Record<string, { name: string } | undefined>;
    expect(
      planAgentCandidateSeed(['pty-live', 'pty-empty-name', 'pty-unseen'], surfaceAgent),
    ).toEqual(['pty-empty-name', 'pty-unseen']);
  });

  it('handles the empty boot state (no sessions, no map)', () => {
    expect(planAgentCandidateSeed([], {})).toEqual([]);
    expect(planAgentCandidateSeed(['a', 'b'], {})).toEqual(['a', 'b']);
  });

  it('drops empty session ids defensively', () => {
    expect(planAgentCandidateSeed(['', 'x'], {})).toEqual(['x']);
  });

  it('never re-asks a pane already attempted this run (reconnect fan-out guard, Claude #5)', () => {
    markSeedAttempted('pty-shell'); // resolved to null earlier (plain shell)
    expect(planAgentCandidateSeed(['pty-shell', 'pty-new'], {})).toEqual(['pty-new']);
  });
});

describe('asAgentSlug', () => {
  it('narrows slug-shaped inputs', () => {
    expect(asAgentSlug('claude')).toBe('claude');
    expect(asAgentSlug('codex')).toBe('codex');
    expect(asAgentSlug('opencode')).toBe('opencode');
  });

  it('maps DISPLAY names — the shape the daemon detector actually returns (Codex #1)', () => {
    expect(asAgentSlug('Claude Code')).toBe('claude');
    expect(asAgentSlug('Codex CLI')).toBe('codex');
    expect(asAgentSlug('Gemini CLI')).toBe('gemini');
  });

  it('returns undefined for unknown values (future agents seed name-only)', () => {
    expect(asAgentSlug('some-new-agent')).toBeUndefined();
    expect(asAgentSlug('')).toBeUndefined();
  });
});

describe('planLiveAgentSeed', () => {
  it('names a recovered Codex pane from process truth before any turn', () => {
    const seeds = planLiveAgentSeed(
      [
        { id: 'daemon-codex', liveAgent: 'codex' },
        { id: 'daemon-shell' },
      ],
      {},
      {},
      { 'daemon-codex': true },
    );
    expect(seeds).toEqual([{ ptyId: 'daemon-codex', slug: 'codex' }]);
  });

  it('never resurrects an agent known to be gone', () => {
    const sessions = [
      { id: 'died', liveAgent: 'codex' },
      { id: 'at-prompt', liveAgent: 'gemini' },
    ];
    expect(planLiveAgentSeed(sessions, {}, { died: false }, { 'at-prompt': false })).toEqual([]);
  });

  it('keeps a name that live detection or a hook already set', () => {
    const seeds = planLiveAgentSeed(
      [{ id: 'p1', liveAgent: 'codex' }],
      { p1: { name: 'Claude Code' } },
      {},
      {},
    );
    expect(seeds).toEqual([]);
  });

  it('ignores a value that is not an agent slug', () => {
    expect(planLiveAgentSeed([{ id: 'p1', liveAgent: 'Codex CLI' }], {}, {}, {})).toEqual([]);
  });
});
