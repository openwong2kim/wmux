import { describe, expect, it, vi } from 'vitest';
import { persistLocationEnrichment } from '../sessionLocationPersistence';

describe('persistLocationEnrichment', () => {
  it('retries once and reports failure when durability cannot be established', () => {
    const save = vi.fn(() => false);
    expect(persistLocationEnrichment(save)).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('stops after the first durable write', () => {
    const save = vi.fn(() => true);
    expect(persistLocationEnrichment(save)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
