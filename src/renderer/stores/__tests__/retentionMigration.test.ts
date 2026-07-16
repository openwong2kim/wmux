// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  retentionMigrationDone,
  markRetentionMigrationDone,
  __clearRetentionMigrationForTests,
} from '../retentionMigration';

// P0-1 (app-weight plan): the migration ledger lives in localStorage — NOT in
// session.json — so an old build's session rewrite cannot erase it (the
// downgrade→OFF→re-upgrade "ping-pong" the DX review flagged).
describe('retentionMigration ledger', () => {
  beforeEach(() => __clearRetentionMigrationForTests());
  afterEach(() => vi.restoreAllMocks());

  it('starts not-done on a fresh profile', () => {
    expect(retentionMigrationDone()).toBe(false);
  });

  it('is done after marking, and stays done', () => {
    markRetentionMigrationDone();
    expect(retentionMigrationDone()).toBe(true);
    markRetentionMigrationDone(); // idempotent
    expect(retentionMigrationDone()).toBe(true);
  });

  it('fails CLOSED (claims done) when localStorage is unavailable — never flips a user setting without a durable record', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(retentionMigrationDone()).toBe(true);
  });

  it('marking survives a storage write failure without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => markRetentionMigrationDone()).not.toThrow();
  });
});
