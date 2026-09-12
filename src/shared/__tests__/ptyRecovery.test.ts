import { describe, expect, it } from 'vitest';
import { asRecoveryAgentSlug, createDeadPaneRecovery, mergeDeadPaneRecovery } from '../ptyRecovery';

describe('createDeadPaneRecovery', () => {
  it('preserves validated legacy distro arguments independently of current settings', () => {
    const args = ['-d', 'Saved Ubuntu'];
    const recovered = createDeadPaneRecovery({ args });
    expect(recovered.args).toEqual(args);
    expect(recovered.args).not.toBe(args);
    expect(createDeadPaneRecovery({ args: ['--exec', 'cmd.exe'] }).args).toBeUndefined();
  });

  it('retains a validated, independent WSL target for dead-pane replacement', () => {
    const wslTarget = { distribution: 'Ubuntu', user: 'user' };
    const recovery = createDeadPaneRecovery({ cwd: '/home/user/project', wslTarget });
    expect(recovery.wslTarget).toEqual(wslTarget);
    expect(recovery.wslTarget).not.toBe(wslTarget);
    expect(createDeadPaneRecovery({ wslTarget: { distribution: '--help', user: 'user' } }).wslTarget).toBeUndefined();
  });

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

  it('rejects unknown daemon agent values and falls back to a valid binding', () => {
    const resumeBinding = {
      agent: 'claude' as const,
      sessionId: 'conversation-1',
      cwd: 'D:\\repo',
      ts: 1,
    };
    expect(asRecoveryAgentSlug('bogus')).toBeUndefined();
    expect(createDeadPaneRecovery({ resumeAgent: 'bogus', resumeBinding })).toEqual({
      resumeAgent: 'claude',
      resumeBinding,
    });
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

  it('keeps an unconsumed offer when incoming optional fields are explicitly undefined', () => {
    const resumeBinding = {
      agent: 'claude',
      sessionId: 'conversation-1',
      cwd: 'D:\\repo',
      ts: 1,
    };
    expect(mergeDeadPaneRecovery(
      { resumeAgent: 'claude', resumeBinding },
      { cwd: 'D:\\live', resumeAgent: undefined, resumeBinding: undefined },
    )).toEqual({
      cwd: 'D:\\live',
      resumeAgent: 'claude',
      resumeBinding,
    });
  });
});
