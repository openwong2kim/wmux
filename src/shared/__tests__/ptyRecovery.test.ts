import { describe, expect, it } from 'vitest';
import { createDeadPaneRecovery, mergeDeadPaneRecovery } from '../ptyRecovery';

describe('createDeadPaneRecovery', () => {
  it('preserves both cwd candidates for main-side validation', () => {
    expect(createDeadPaneRecovery({ spawnCwd: 'D:\\spawn', cwd: 'D:\\live' })).toEqual({
      spawnCwd: 'D:\\spawn',
      cwd: 'D:\\live',
    });
  });

  it('drops blank cwd candidates without losing recovery intent', () => {
    expect(createDeadPaneRecovery({ spawnCwd: '  ', cwd: '' })).toEqual({});
  });

  it('derives the resume agent from a surviving binding', () => {
    const resumeBinding = {
      agent: 'claude' as const,
      sessionId: 'conversation-1',
      cwd: 'D:\\repo',
      ts: 1,
    };
    expect(createDeadPaneRecovery({ resumeBinding })).toEqual({
      resumeAgent: 'claude',
      resumeBinding,
    });
  });

  it('keeps an explicit resume agent when no exact binding survives', () => {
    expect(createDeadPaneRecovery({ resumeAgent: 'codex' })).toEqual({ resumeAgent: 'codex' });
  });
});

describe('mergeDeadPaneRecovery', () => {
  it('keeps an unconsumed resume offer while taking newer cwd metadata', () => {
    const resumeBinding = {
      agent: 'claude',
      sessionId: 'conversation-1',
      cwd: 'D:\\repo',
      ts: 1,
    };
    expect(mergeDeadPaneRecovery(
      { spawnCwd: 'D:\\old', resumeAgent: 'claude', resumeBinding },
      { spawnCwd: 'D:\\new', cwd: 'D:\\live' },
    )).toEqual({
      spawnCwd: 'D:\\new',
      cwd: 'D:\\live',
      resumeAgent: 'claude',
      resumeBinding,
    });
  });
});
