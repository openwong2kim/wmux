import { describe, expect, it, vi } from 'vitest';
import { resolvePtyCreateCwd } from '../resolvePtyCwd';

describe('resolvePtyCreateCwd', () => {
  it('prefers a valid persisted spawnCwd for a dead-session replacement', () => {
    const validate = vi.fn((cwd?: string) => cwd === 'D:\\spawn' ? 'D:\\spawn' : undefined);
    expect(resolvePtyCreateCwd('C:\\profile', {
      spawnCwd: 'D:\\spawn',
      cwd: 'D:\\live',
    }, validate)).toEqual({
      incomingCwd: 'D:\\spawn',
      safeCwd: 'D:\\spawn',
      source: 'recovery-spawnCwd',
    });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('falls back to the live cwd when spawnCwd no longer validates', () => {
    const validate = vi.fn((cwd?: string) => cwd === 'D:\\live' ? 'D:\\live' : undefined);
    expect(resolvePtyCreateCwd(undefined, {
      spawnCwd: 'D:\\missing',
      cwd: 'D:\\live',
    }, validate)).toEqual({
      incomingCwd: 'D:\\live',
      safeCwd: 'D:\\live',
      source: 'recovery-cwd',
    });
  });

  it('selects home fallback when no dead-session cwd validates', () => {
    expect(resolvePtyCreateCwd('C:\\profile', {
      spawnCwd: 'D:\\missing',
      cwd: 'E:\\missing',
    }, () => undefined)).toEqual({
      incomingCwd: 'D:\\missing',
      source: 'recovery-home',
    });
  });

  it('selects home fallback for a known recovery with no cwd metadata', () => {
    expect(resolvePtyCreateCwd('C:\\profile', {}, () => undefined)).toEqual({
      incomingCwd: undefined,
      source: 'recovery-home',
    });
  });

  it('preserves ordinary create behavior when no recovery exists', () => {
    expect(resolvePtyCreateCwd('C:\\profile', undefined, (cwd) => cwd)).toEqual({
      incomingCwd: 'C:\\profile',
      safeCwd: 'C:\\profile',
      source: 'requested',
    });
  });
});
