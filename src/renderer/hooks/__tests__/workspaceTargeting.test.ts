import { describe, it, expect } from 'vitest';
import { resolveWorkspaceTarget } from '../workspaceTargeting';

const ws = (id: string, name: string) => ({ id, name });

describe('resolveWorkspaceTarget', () => {
  it('resolves an exact ID, short-circuiting even when names are duplicated', () => {
    const list = [ws('ws-aaa', 'probe'), ws('ws-bbb', 'probe')];
    expect(resolveWorkspaceTarget(list, 'ws-bbb')).toEqual({ kind: 'resolved', id: 'ws-bbb' });
  });

  it('resolves a unique exact name (case-insensitive)', () => {
    const list = [ws('ws-aaa', 'Alpha'), ws('ws-bbb', 'Beta')];
    expect(resolveWorkspaceTarget(list, 'alpha')).toEqual({ kind: 'resolved', id: 'ws-aaa' });
  });

  it('REFUSES a duplicate exact name (ambiguous, lists both IDs)', () => {
    const list = [ws('ws-aaa', 'probe'), ws('ws-bbb', 'probe')];
    const r = resolveWorkspaceTarget(list, 'probe');
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.matches.map((m) => m.id)).toEqual(['ws-aaa', 'ws-bbb']);
  });

  it('resolves a unique substring (no over-rejection)', () => {
    const list = [ws('ws-aaa', 'cross-ws-probe'), ws('ws-bbb', 'beta')];
    expect(resolveWorkspaceTarget(list, 'probe')).toEqual({ kind: 'resolved', id: 'ws-aaa' });
  });

  it('an exact name beats a substring of another workspace (tier precedence)', () => {
    // "beta" is an exact name AND a substring of "beta-backup"; the exact tier
    // wins (the old single-pass .find was list-order dependent and could pick
    // beta-backup first).
    const list = [ws('ws-aaa', 'beta-backup'), ws('ws-bbb', 'beta')];
    expect(resolveWorkspaceTarget(list, 'beta')).toEqual({ kind: 'resolved', id: 'ws-bbb' });
  });

  it('resolves a number/index ("3", "3번", "workspace 3")', () => {
    const list = [ws('ws-1', 'Workspace 1'), ws('ws-3', 'Workspace 3')];
    expect(resolveWorkspaceTarget(list, '3')).toEqual({ kind: 'resolved', id: 'ws-3' });
    expect(resolveWorkspaceTarget(list, '3번')).toEqual({ kind: 'resolved', id: 'ws-3' });
    expect(resolveWorkspaceTarget(list, 'workspace 3')).toEqual({ kind: 'resolved', id: 'ws-3' });
  });

  it('KEEPS number/substring first-match (does NOT error on heuristic collision)', () => {
    // "3" matches both "Workspace 3" and "v3-app" (digit-run 3). The documented
    // addressing contract is first-match, NOT an ambiguity error (only EXACT
    // names are refused). This preserves the "N번" agent flow.
    const list = [ws('ws-3', 'Workspace 3'), ws('ws-v3', 'v3-app')];
    expect(resolveWorkspaceTarget(list, '3')).toEqual({ kind: 'resolved', id: 'ws-3' });
  });

  it('returns not-found when nothing matches', () => {
    const list = [ws('ws-aaa', 'Alpha')];
    expect(resolveWorkspaceTarget(list, 'zzz')).toEqual({ kind: 'not-found' });
  });

  it('returns not-found for a whitespace-only / empty target (no includes("") first-ws routing)', () => {
    // Without the guard, trim()→'' would substring-match every workspace and
    // silently route to the first (CodeRabbit). Must be not-found instead.
    const list = [ws('ws-aaa', 'Alpha'), ws('ws-bbb', 'Beta')];
    expect(resolveWorkspaceTarget(list, '   ')).toEqual({ kind: 'not-found' });
    expect(resolveWorkspaceTarget(list, '')).toEqual({ kind: 'not-found' });
  });

  it('trims surrounding whitespace before matching id and name', () => {
    const list = [ws('ws-aaa', 'Alpha')];
    expect(resolveWorkspaceTarget(list, '  ws-aaa  ')).toEqual({ kind: 'resolved', id: 'ws-aaa' });
    expect(resolveWorkspaceTarget(list, '  alpha  ')).toEqual({ kind: 'resolved', id: 'ws-aaa' });
  });
});
