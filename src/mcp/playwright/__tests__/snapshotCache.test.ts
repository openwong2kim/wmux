import { beforeEach, describe, expect, it } from 'vitest';
import {
  getSnapshotBaseline,
  invalidateSnapshotBaseline,
  setSnapshotBaseline,
  snapshotSurfaceKey,
} from '../snapshotCache';

// Baseline store for browser_snapshot auto-diff. The URL guard is the 3-model
// review consensus: a diff across different page URLs is never valid, whatever
// lifecycle events were missed.

const key = snapshotSurfaceKey('ws-1', 'surf-1');

beforeEach(() => {
  invalidateSnapshotBaseline('ws-1', 'surf-1');
});

describe('snapshot baseline URL guard', () => {
  it('returns the baseline when attrs and url match', () => {
    setSnapshotBaseline(key, 'ai||', 'tree', 'https://a.test/');
    expect(getSnapshotBaseline(key, 'ai||', 'https://a.test/')?.text).toBe('tree');
  });

  it('drops the baseline on url mismatch', () => {
    setSnapshotBaseline(key, 'ai||', 'tree', 'https://a.test/');
    expect(getSnapshotBaseline(key, 'ai||', 'https://b.test/')).toBeNull();
    // And it is gone for good, not merely hidden.
    expect(getSnapshotBaseline(key, 'ai||', 'https://a.test/')).toBeNull();
  });

  it('drops the baseline on attrs mismatch', () => {
    setSnapshotBaseline(key, 'ai||', 'tree', 'https://a.test/');
    expect(getSnapshotBaseline(key, 'ai|main|', 'https://a.test/')).toBeNull();
  });

  it('keeps legacy behavior when neither side knows a url', () => {
    setSnapshotBaseline(key, 'ai||', 'tree');
    expect(getSnapshotBaseline(key, 'ai||')?.text).toBe('tree');
  });
});
