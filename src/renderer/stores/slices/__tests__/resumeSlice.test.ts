import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';

// X6 Feature ② — resume-hint slice. Mirrors supervisionSlice.test structure.
describe('resumeSlice', () => {
  beforeEach(() => {
    useStore.setState((state) => {
      state.pendingDeadPaneRecoveryBySurfaceId = {};
      state.deadPaneRecoveryOfferByPtyId = {};
    });
    useStore.getState().hydrateResume({});
    useStore.getState().hydrateResumeBindings({});
    // clear readiness by re-hydrating is not enough (separate map) — mark fresh
    // ptys ready explicitly per test.
  });

  const binding = (sessionId: string, cwd = 'D:\\wmux') => ({
    agent: 'claude' as const,
    sessionId,
    cwd,
    permissionMode: 'bypassPermissions' as const,
    ts: 1,
  });

  it('starts empty', () => {
    expect(useStore.getState().resumeHintByPtyId).toEqual({});
  });

  describe('setResumeHint / clearResumeHint', () => {
    it('sets a hint for a pty', () => {
      useStore.getState().setResumeHint('pty-a', 'claude');
      expect(useStore.getState().resumeHintByPtyId['pty-a']).toBe('claude');
    });

    it('clears one pty without touching others', () => {
      useStore.getState().setResumeHint('pty-a', 'claude');
      useStore.getState().setResumeHint('pty-b', 'codex');
      useStore.getState().clearResumeHint('pty-a');
      expect(useStore.getState().resumeHintByPtyId['pty-a']).toBeUndefined();
      expect(useStore.getState().resumeHintByPtyId['pty-b']).toBe('codex');
    });

    it('clearing a missing pty is a no-op', () => {
      expect(() => useStore.getState().clearResumeHint('nope')).not.toThrow();
    });
  });

  describe('hydrateResume (replace semantics)', () => {
    it('replaces the whole map, dropping stale entries', () => {
      useStore.getState().setResumeHint('pty-old', 'claude');
      useStore.getState().hydrateResume({ 'pty-new': 'claude' });
      expect(useStore.getState().resumeHintByPtyId).toEqual({ 'pty-new': 'claude' });
    });

    it('empty snapshot clears everything', () => {
      useStore.getState().setResumeHint('pty-a', 'claude');
      useStore.getState().hydrateResume({});
      expect(useStore.getState().resumeHintByPtyId).toEqual({});
    });
  });

  describe('X6 ③ — resume binding (id + permission mode)', () => {
    it('starts empty', () => {
      expect(useStore.getState().resumeBindingByPtyId).toEqual({});
    });

    it('hydrateResumeBindings replaces the whole map', () => {
      useStore.getState().hydrateResumeBindings({ 'pty-a': binding('s-1') });
      expect(useStore.getState().resumeBindingByPtyId['pty-a']?.sessionId).toBe('s-1');
      useStore.getState().hydrateResumeBindings({ 'pty-b': binding('s-2') });
      expect(useStore.getState().resumeBindingByPtyId['pty-a']).toBeUndefined();
      expect(useStore.getState().resumeBindingByPtyId['pty-b']?.sessionId).toBe('s-2');
    });

    it('clearResumeHint clears the binding together with the hint (pill is one unit)', () => {
      useStore.getState().setResumeHint('pty-a', 'claude');
      useStore.getState().hydrateResumeBindings({ 'pty-a': binding('s-1'), 'pty-b': binding('s-2') });
      useStore.getState().clearResumeHint('pty-a');
      expect(useStore.getState().resumeHintByPtyId['pty-a']).toBeUndefined();
      expect(useStore.getState().resumeBindingByPtyId['pty-a']).toBeUndefined();
      // untouched sibling
      expect(useStore.getState().resumeBindingByPtyId['pty-b']?.sessionId).toBe('s-2');
    });
  });

  describe('markPtyReady (EI6 click gate)', () => {
    it('marks a pty ready (idempotent)', () => {
      useStore.getState().markPtyReady('pty-a');
      expect(useStore.getState().ptyReadyByPtyId['pty-a']).toBe(true);
      useStore.getState().markPtyReady('pty-a');
      expect(useStore.getState().ptyReadyByPtyId['pty-a']).toBe(true);
    });

    it('a pty with a hint but not yet ready is gated (pill should not show)', () => {
      useStore.getState().setResumeHint('pty-z', 'claude');
      // readiness map is independent — pty-z not marked ready
      expect(useStore.getState().ptyReadyByPtyId['pty-z']).toBeUndefined();
    });

    it('a repeat call is a store no-op (hot-path early return, no subscriber fire)', () => {
      useStore.getState().markPtyReady('pty-hot');
      const fired: number[] = [];
      const unsub = useStore.subscribe(() => fired.push(1));
      useStore.getState().markPtyReady('pty-hot'); // already ready → bails before set()
      unsub();
      expect(fired).toHaveLength(0);
      expect(useStore.getState().ptyReadyByPtyId['pty-hot']).toBe(true);
    });
  });

  describe('dead-pane replacement hand-off (#650)', () => {
    it('moves a staged binding to the replacement pty', () => {
      const resumeBinding = binding('dead-conversation');
      useStore.getState().stageDeadPaneRecovery('surface-a', {
        spawnCwd: 'D:\\wmux',
        resumeAgent: 'claude',
        resumeBinding,
      });

      useStore.getState().completeDeadPaneRecovery('surface-a', 'pty-new');

      expect(useStore.getState().pendingDeadPaneRecoveryBySurfaceId['surface-a']).toBeUndefined();
      expect(useStore.getState().resumeHintByPtyId['pty-new']).toBe('claude');
      expect(useStore.getState().resumeBindingByPtyId['pty-new']).toEqual(resumeBinding);
    });

    it('survives normal daemon hydration until the offer is dismissed', () => {
      useStore.getState().stageDeadPaneRecovery('surface-a', {
        resumeBinding: binding('dead-conversation'),
      });
      useStore.getState().completeDeadPaneRecovery('surface-a', 'pty-new');

      useStore.getState().hydrateResume({});
      useStore.getState().hydrateResumeBindings({});
      expect(useStore.getState().resumeHintByPtyId['pty-new']).toBe('claude');
      expect(useStore.getState().resumeBindingByPtyId['pty-new']?.sessionId).toBe('dead-conversation');

      useStore.getState().clearResumeHint('pty-new');
      useStore.getState().hydrateResume({});
      useStore.getState().hydrateResumeBindings({});
      expect(useStore.getState().resumeHintByPtyId['pty-new']).toBeUndefined();
      expect(useStore.getState().resumeBindingByPtyId['pty-new']).toBeUndefined();
    });

    it('consumes cwd-only recovery without inventing a resume offer', () => {
      useStore.getState().stageDeadPaneRecovery('surface-a', { spawnCwd: 'D:\\wmux' });
      useStore.getState().completeDeadPaneRecovery('surface-a', 'pty-new');
      expect(useStore.getState().pendingDeadPaneRecoveryBySurfaceId['surface-a']).toBeUndefined();
      expect(useStore.getState().deadPaneRecoveryOfferByPtyId['pty-new']).toBeUndefined();
      expect(useStore.getState().resumeHintByPtyId['pty-new']).toBeUndefined();
    });

    it('carries an unconsumed offer across a second replacement', () => {
      useStore.getState().stageDeadPaneRecovery('surface-a', {
        spawnCwd: 'D:\\first',
        resumeBinding: binding('dead-conversation'),
      });
      useStore.getState().completeDeadPaneRecovery('surface-a', 'pty-first');

      useStore.getState().stageDeadPaneRecovery(
        'surface-a',
        { spawnCwd: 'D:\\second' },
        'pty-first',
      );
      useStore.getState().completeDeadPaneRecovery('surface-a', 'pty-second');

      expect(useStore.getState().deadPaneRecoveryOfferByPtyId['pty-first']).toBeUndefined();
      expect(useStore.getState().resumeHintByPtyId['pty-first']).toBeUndefined();
      expect(useStore.getState().resumeHintByPtyId['pty-second']).toBe('claude');
      expect(useStore.getState().resumeBindingByPtyId['pty-second']?.sessionId).toBe('dead-conversation');
      expect(useStore.getState().deadPaneRecoveryOfferByPtyId['pty-second']?.spawnCwd).toBe('D:\\second');
    });
  });
});

// The OSC 133 back-at-prompt settle. `commandRunning` is the tier-1 signal in
// `isPaneAgentBusy`, and a shell that has printed its own prompt again cannot
// be mid-turn — so the same snapshot that stores it withdraws the pane's hook
// turn latch. This is the settle path that fires on panes the daemon's process
// tracker never attributed, where `agent.processExit` never arrives at all.
describe('hydrateCommandRunning — a shell back at its prompt closes the turn', () => {
  beforeEach(() => {
    useStore.setState((state) => {
      state.surfaceTurnOpenAt = {};
      state.surfaceActivityAt = {};
    });
    useStore.getState().hydrateCommandRunning({});
  });

  it('clears the latch on the true → false transition', () => {
    useStore.getState().hydrateCommandRunning({ 'pty-a': true });
    useStore.getState().markSurfaceTurnOpen('pty-a');
    expect(useStore.getState().surfaceTurnOpenAt['pty-a']).toBeGreaterThan(0);

    useStore.getState().hydrateCommandRunning({ 'pty-a': false });
    expect(useStore.getState().surfaceTurnOpenAt['pty-a']).toBeUndefined();
    expect(useStore.getState().commandRunningByPtyId['pty-a']).toBe(false);
  });

  it('leaves the latch alone for a pty the daemon reports nothing about', () => {
    // No shell integration → no value in the snapshot. Reading that silence as
    // "at a prompt" would settle every hook-governed pane on such a machine.
    useStore.getState().markSurfaceTurnOpen('pty-b');
    useStore.getState().hydrateCommandRunning({ 'pty-other': false });
    expect(useStore.getState().surfaceTurnOpenAt['pty-b']).toBeGreaterThan(0);
    expect(useStore.getState().commandRunningByPtyId['pty-b']).toBeUndefined();
  });

  it('is a no-op on a pane that never opened a turn', () => {
    useStore.getState().hydrateCommandRunning({ 'pty-c': false });
    expect(useStore.getState().surfaceTurnOpenAt['pty-c']).toBeUndefined();
    expect(useStore.getState().commandRunningByPtyId['pty-c']).toBe(false);
  });

  it('keeps surfaceActivityAt — the latch is the claim, the stamp is evidence', () => {
    useStore.getState().markSurfaceRunning('pty-d');
    useStore.getState().markSurfaceTurnOpen('pty-d');
    const stamp = useStore.getState().surfaceActivityAt['pty-d'];

    useStore.getState().hydrateCommandRunning({ 'pty-d': false });
    expect(useStore.getState().surfaceTurnOpenAt['pty-d']).toBeUndefined();
    expect(useStore.getState().surfaceActivityAt['pty-d']).toBe(stamp);
  });
});
