// ptyOwnership — mirror-first ownership / role-binding resolution (T1~T6).
//
// Deliberately uses the REAL WorkspaceMirror singleton driven through
// setSnapshot, never a mock of the mirror itself: when the guard under test IS
// the suspected component, mocking it repeats the blindness (see the
// DaemonNotificationRouter suppression-wedge postmortem). Only the renderer
// bridge (sendToRenderer) is mocked — it is the round-trip boundary whose
// call count is the observable under test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getWorkspaceMirror,
  __resetWorkspaceMirrorForTest,
} from '../WorkspaceMirror';
import {
  resolvePtyOwnerWorkspace,
  assertWorkspaceOwnsPty,
  resolveRoleBindingForPty,
} from '../ptyOwnership';
import { STALE_TRUST_MS } from '../../pipe/handlers/hooks.rpc';

vi.mock('../../pipe/handlers/_bridge', () => ({
  sendToRenderer: vi.fn(),
}));

import { sendToRenderer } from '../../pipe/handlers/_bridge';

const mockedSend = vi.mocked(sendToRenderer);
const getWindow = () => null;

/** Push a snapshot where ws-A owns pty-1/pty-2 and ws-B owns pty-3. */
function pushSnapshot(overrides: { roleBindings?: Record<string, unknown> } = {}): void {
  getWorkspaceMirror().setSnapshot({
    ts: Date.now(),
    entries: [
      { id: 'ws-A', name: 'A', activePtyId: 'pty-1', ptyIds: ['pty-1', 'pty-2'] },
      { id: 'ws-B', name: 'B', activePtyId: 'pty-3', ptyIds: ['pty-3'] },
    ],
    fleets: [],
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetWorkspaceMirrorForTest();
  mockedSend.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  __resetWorkspaceMirrorForTest();
});

describe('resolvePtyOwnerWorkspace — assert posture (expected given)', () => {
  it('T1: fresh mirror agreeing with the expectation skips the round-trip', async () => {
    pushSnapshot();
    const owner = await resolvePtyOwnerWorkspace(getWindow, 'pty-1', { expected: 'ws-A' });
    expect(owner).toBe('ws-A');
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('T2: fresh mirror DISAGREEING falls back to the round-trip (deny authority)', async () => {
    pushSnapshot();
    // Mirror says pty-3 → ws-B, caller expects ws-A. The renderer (fresher)
    // says the pane just moved into ws-A — the round-trip verdict wins.
    mockedSend.mockResolvedValue({ workspaceId: 'ws-A' });
    const owner = await resolvePtyOwnerWorkspace(getWindow, 'pty-3', { expected: 'ws-A' });
    expect(owner).toBe('ws-A');
    expect(mockedSend).toHaveBeenCalledWith(getWindow, 'input.findOwnerWorkspace', {
      ptyId: 'pty-3',
    });
  });

  it('T3: stale mirror (>STALE_TRUST_MS) is ignored even when it would agree', async () => {
    pushSnapshot();
    vi.advanceTimersByTime(STALE_TRUST_MS + 1);
    mockedSend.mockResolvedValue({ workspaceId: 'ws-A' });
    const owner = await resolvePtyOwnerWorkspace(getWindow, 'pty-1', { expected: 'ws-A' });
    expect(owner).toBe('ws-A');
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('T4: never-populated mirror (cold boot) round-trips', async () => {
    mockedSend.mockResolvedValue({ workspaceId: 'ws-A' });
    const owner = await resolvePtyOwnerWorkspace(getWindow, 'pty-1', { expected: 'ws-A' });
    expect(owner).toBe('ws-A');
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });
});

describe('assertWorkspaceOwnsPty', () => {
  it('undefined expected workspace skips the check entirely (internal callers)', async () => {
    await assertWorkspaceOwnsPty(getWindow, 'pty-1', undefined, 'input.send');
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('mirror-hit allow does not round-trip; round-trip deny still throws', async () => {
    pushSnapshot();
    await assertWorkspaceOwnsPty(getWindow, 'pty-1', 'ws-A', 'input.send');
    expect(mockedSend).not.toHaveBeenCalled();

    mockedSend.mockResolvedValue({ workspaceId: 'ws-B' });
    await expect(
      assertWorkspaceOwnsPty(getWindow, 'pty-3', 'ws-A', 'input.send'),
    ).rejects.toThrow(/not owned by workspace "ws-A"/);
  });

  it('a deny is NEVER produced by the mirror alone — the round-trip confirms it', async () => {
    pushSnapshot();
    // Mirror would deny (pty-3 ∈ ws-B), but the renderer says ws-A: allowed.
    mockedSend.mockResolvedValue({ workspaceId: 'ws-A' });
    await expect(
      assertWorkspaceOwnsPty(getWindow, 'pty-3', 'ws-A', 'input.send'),
    ).resolves.toBeUndefined();
  });
});

describe('resolvePtyOwnerWorkspace — resolve posture (no expected)', () => {
  it('T5: fresh mirror hit answers identity without a round-trip; miss round-trips', async () => {
    pushSnapshot();
    expect(await resolvePtyOwnerWorkspace(getWindow, 'pty-3')).toBe('ws-B');
    expect(mockedSend).not.toHaveBeenCalled();

    // Unknown pty: mirror miss must NOT be treated as authoritative "no owner"
    // (a just-spawned pty can race the push) — it falls through to the renderer.
    mockedSend.mockResolvedValue({ workspaceId: 'ws-C' });
    expect(await resolvePtyOwnerWorkspace(getWindow, 'pty-9')).toBe('ws-C');
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('round-trip null/absent owner resolves to null (fail-closed at call sites)', async () => {
    mockedSend.mockResolvedValue({ workspaceId: null });
    expect(await resolvePtyOwnerWorkspace(getWindow, 'pty-9')).toBeNull();
    mockedSend.mockResolvedValue(undefined);
    expect(await resolvePtyOwnerWorkspace(getWindow, 'pty-9')).toBeNull();
  });
});

describe('resolveRoleBindingForPty (T6)', () => {
  const binding = { agent: 'claude', model: 'haiku' };

  it('fresh mirror with a bindings map answers bound AND unbound locally', async () => {
    pushSnapshot({ roleBindings: { 'pty-1': binding } });
    const hit = await resolveRoleBindingForPty(getWindow, 'pty-1');
    expect(hit?.model).toBe('haiku');
    // Absent from a present map = authoritatively unbound — still no round-trip.
    expect(await resolveRoleBindingForPty(getWindow, 'pty-2')).toBeUndefined();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('old-renderer push (no roleBindings field) round-trips instead of guessing', async () => {
    pushSnapshot(); // no roleBindings key → peekRoleBindings() === null
    mockedSend.mockResolvedValue({ workspaceId: 'ws-A', roleBinding: binding });
    const resolved = await resolveRoleBindingForPty(getWindow, 'pty-1');
    expect(resolved?.model).toBe('haiku');
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('END-TO-END through the IPC parser: bindings survive parse→setSnapshot→resolve', async () => {
    // Regression for the 3-way-review Codex finding: the production push path
    // goes through parseWorkspaceMirrorPayload, which used to DROP the
    // roleBindings field — so a setSnapshot-only test proved nothing about
    // production. This test walks the real path.
    const { parseWorkspaceMirrorPayload } = await import(
      '../../ipc/handlers/workspaceMirror.handler'
    );
    const parsed = parseWorkspaceMirrorPayload({
      ts: Date.now(),
      entries: [{ id: 'ws-A', name: 'A', activePtyId: 'pty-1', ptyIds: ['pty-1'] }],
      fleets: [],
      roleBindings: { 'pty-1': binding },
    });
    expect(parsed).not.toBeNull();
    getWorkspaceMirror().setSnapshot(parsed!);
    const resolved = await resolveRoleBindingForPty(getWindow, 'pty-1');
    expect(resolved?.model).toBe('haiku');
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('stale mirror round-trips; malformed mirrored binding normalizes to undefined', async () => {
    pushSnapshot({ roleBindings: { 'pty-1': binding } });
    vi.advanceTimersByTime(STALE_TRUST_MS + 1);
    mockedSend.mockResolvedValue({ workspaceId: 'ws-A', roleBinding: binding });
    expect((await resolveRoleBindingForPty(getWindow, 'pty-1'))?.model).toBe('haiku');
    expect(mockedSend).toHaveBeenCalledTimes(1);

    mockedSend.mockClear();
    pushSnapshot({ roleBindings: { 'pty-1': { bogus: true } } });
    expect(await resolveRoleBindingForPty(getWindow, 'pty-1')).toBeUndefined();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
