import { describe, it, expect } from 'vitest';
import { CRITICAL_PATTERNS, hasCriticalRisk } from '../criticalPatterns';

describe('hasCriticalRisk', () => {
  it('matches the destructive actions the PTY scanner already knows', () => {
    expect(hasCriticalRisk('sudo rm -rf /var/tmp/build')).toBe(true);
    expect(hasCriticalRisk('git push --force origin main')).toBe(true);
    expect(hasCriticalRisk('DROP TABLE sessions;')).toBe(true);
    expect(hasCriticalRisk('terraform destroy -auto-approve')).toBe(true);
  });

  it('scans every argument, so a danger can live in an option label', () => {
    expect(hasCriticalRisk('How should I clean up?', 'Leave it', 'rm -rf node_modules/')).toBe(true);
  });

  it('ignores the softer review tier — this answers one yes/no question', () => {
    // `kubectl delete` and `DELETE FROM` are riskLevel 'review', not 'critical'.
    expect(hasCriticalRisk('kubectl delete pod web-1')).toBe(false);
    expect(hasCriticalRisk('DELETE FROM users WHERE id = 1')).toBe(false);
  });

  it('is quiet on ordinary text and on nothing at all', () => {
    expect(hasCriticalRisk('Which approach should I take?')).toBe(false);
    expect(hasCriticalRisk(undefined, null, '')).toBe(false);
  });

  it('carries no `g` flag, so repeated calls cannot desync on lastIndex', () => {
    expect(CRITICAL_PATTERNS.every((p) => !p.regex.global)).toBe(true);
    expect(hasCriticalRisk('npm publish')).toBe(true);
    expect(hasCriticalRisk('npm publish')).toBe(true);
  });
});
