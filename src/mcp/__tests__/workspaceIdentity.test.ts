import { describe, expect, it } from 'vitest';
import { classifyWorkspaceListResult } from '../workspaceIdentity';

const WS = 'ws-target-1234';

describe('classifyWorkspaceListResult — env-hint liveness gate', () => {
  it('returns "live" when a bare array contains the id', () => {
    const result = [{ id: 'ws-other' }, { id: WS }, { id: 'ws-more' }];
    expect(classifyWorkspaceListResult(result, WS)).toBe('live');
  });

  it('returns "absent" when a bare array does NOT contain the id (confirmed ghost)', () => {
    const result = [{ id: 'ws-other' }, { id: 'ws-more' }];
    expect(classifyWorkspaceListResult(result, WS)).toBe('absent');
  });

  it('returns "absent" for an empty array', () => {
    expect(classifyWorkspaceListResult([], WS)).toBe('absent');
  });

  it('unwraps a { workspaces: [...] } envelope — live', () => {
    const result = { workspaces: [{ id: WS }] };
    expect(classifyWorkspaceListResult(result, WS)).toBe('live');
  });

  it('unwraps a { workspaces: [...] } envelope — absent', () => {
    const result = { workspaces: [{ id: 'ws-other' }] };
    expect(classifyWorkspaceListResult(result, WS)).toBe('absent');
  });

  it('returns "unknown" for the renderer retryable "still starting" envelope', () => {
    // This is the boot-reconcile shape the renderer returns while paneGate is
    // pending. It must NOT be read as "absent" — the hint may be perfectly valid.
    const result = { error: 'wmux is still starting (paneGate=pending)', retryable: true };
    expect(classifyWorkspaceListResult(result, WS)).toBe('unknown');
  });

  it('returns "unknown" for null / undefined', () => {
    expect(classifyWorkspaceListResult(null, WS)).toBe('unknown');
    expect(classifyWorkspaceListResult(undefined, WS)).toBe('unknown');
  });

  it('returns "unknown" for non-array primitives', () => {
    expect(classifyWorkspaceListResult('oops', WS)).toBe('unknown');
    expect(classifyWorkspaceListResult(42, WS)).toBe('unknown');
  });

  it('ignores malformed (non-object) entries inside the array', () => {
    const result = [null, 'junk', { id: WS }];
    expect(classifyWorkspaceListResult(result, WS)).toBe('live');
  });

  it('does not match when entries lack an id field', () => {
    const result = [{ name: 'Workspace 1' }, { metadata: {} }];
    expect(classifyWorkspaceListResult(result, WS)).toBe('absent');
  });
});
