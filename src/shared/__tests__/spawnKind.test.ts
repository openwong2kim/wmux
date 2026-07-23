import { describe, expect, it } from 'vitest';
import { resolveEnvPolicy } from '../spawnKind';

// ★ This file is the core regression guard for execution-context policy: the
// default for misclassification must be "gated", not "human shell" (fail-closed).
// Even if a new spawn path omits its stamp, credentials leak is blocked, not opened.
describe('resolveEnvPolicy — fail-closed execution-context classification', () => {
  it('only user-shell stamp is passthrough', () => {
    expect(resolveEnvPolicy({ spawnKind: 'user-shell' })).toBe('passthrough');
  });

  it('agent/exec stamps are gated', () => {
    expect(resolveEnvPolicy({ spawnKind: 'agent' })).toBe('gated');
    expect(resolveEnvPolicy({ spawnKind: 'exec' })).toBe('gated');
  });

  it('unstamped spawn (path omitted stamp) is fail-closed gated', () => {
    expect(resolveEnvPolicy({})).toBe('gated');
    expect(resolveEnvPolicy({ spawnKind: undefined })).toBe('gated');
  });

  it('exec/supervision gates even with user-shell stamp (automation beats stamp)', () => {
    // Supervised exec leaf is wmux-driven automation — gate even with a wrong user-shell stamp.
    expect(resolveEnvPolicy({ spawnKind: 'user-shell', hasExec: true })).toBe('gated');
    expect(resolveEnvPolicy({ spawnKind: 'user-shell', hasSupervision: true })).toBe('gated');
  });

  it('unknown spawnKind values gated (only exact "user-shell" literal passthrough)', () => {
    expect(resolveEnvPolicy({ spawnKind: 'nonsense' as never })).toBe('gated');
  });
});
