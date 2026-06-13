import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';

// X6 Feature ② — resume-hint slice. Mirrors supervisionSlice.test structure.
describe('resumeSlice', () => {
  beforeEach(() => {
    useStore.getState().hydrateResume({});
    // clear readiness by re-hydrating is not enough (separate map) — mark fresh
    // ptys ready explicitly per test.
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
  });
});
