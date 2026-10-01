import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MODEL_OPTIONS,
  claudeModelLabel,
  sanitizeClaudeEffort,
} from '../claudeModels';

describe('claudeModels', () => {
  it('offers the 5.5 models by full id', () => {
    const ids = CLAUDE_MODEL_OPTIONS.map((o) => o.value);
    expect(ids).toContain('claude-opus-5-5');
    expect(ids).toContain('claude-sonnet-5-5');
    expect(ids[0]).toBe('');
  });

  it('labels a known id and echoes an unknown one', () => {
    expect(claudeModelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(claudeModelLabel('claude-future-9')).toBe('claude-future-9');
  });

  it('keeps only known effort levels', () => {
    expect(sanitizeClaudeEffort('max')).toBe('max');
    expect(sanitizeClaudeEffort('ultra')).toBe('');
    expect(sanitizeClaudeEffort(undefined)).toBe('');
    expect(sanitizeClaudeEffort(3)).toBe('');
  });
});
