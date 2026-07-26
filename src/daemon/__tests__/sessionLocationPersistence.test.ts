import { describe, expect, it, vi } from 'vitest';
import { persistLocationEnrichment } from '../sessionLocationPersistence';

describe('persistLocationEnrichment', () => {
  it('retries once and reports failure when durability cannot be established', () => {
    const save = vi.fn(() => false);
    const rollback = vi.fn();
    expect(persistLocationEnrichment(save, rollback)).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('stops after the first durable write', () => {
    const save = vi.fn(() => true);
    const rollback = vi.fn();
    expect(persistLocationEnrichment(save, rollback)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });
});
