import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeSurfaceStore, getChromeSurfacesPath } from '../ChromeSurfaceStore';
import { surfaceOpeners } from '../SurfaceOpeners';

/**
 * The opener of a browser surface is memory only.
 *
 * A surface that outlives the app must come back ownerless: the connection
 * that opened it is gone, and a persisted owner would leave the tab
 * permanently undefaultable for every agent — reachable only by naming its id.
 * Ownerless is what lets the next caller adopt it.
 */
describe('SurfaceOpeners', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-surface-openers-'));
    surfaceOpeners.clear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never reaches the persisted chrome surface file', async () => {
    const store = new ChromeSurfaceStore(dir);
    const now = Date.now();
    surfaceOpeners.note('chrome-1', 'opener-abcd');

    await store.saveNow('default', [
      { surfaceId: 'chrome-1', targetId: 'tgt-1', url: 'https://a.test/', createdAt: now, lastSeenAt: now },
    ]);

    const raw = readFileSync(getChromeSurfacesPath(dir), 'utf8');
    expect(raw).toContain('chrome-1');
    expect(raw).not.toContain('opener');
    // And a restart reads the record back with no owner, so it is adoptable.
    expect(new ChromeSurfaceStore(dir).listForProfile('default')[0]).not.toHaveProperty('openerKey');
  });

  it('remembers the last opener of a surface and forgets a closed one', () => {
    surfaceOpeners.note('surf-1', 'opener-a');
    expect(surfaceOpeners.get('surf-1')).toBe('opener-a');
    // Adoption re-states ownership rather than keeping the first writer.
    surfaceOpeners.note('surf-1', 'opener-b');
    expect(surfaceOpeners.get('surf-1')).toBe('opener-b');

    surfaceOpeners.forget('surf-1');
    expect(surfaceOpeners.get('surf-1')).toBeUndefined();
  });

  it('ignores an empty surface id or opener key', () => {
    surfaceOpeners.note('', 'opener-a');
    surfaceOpeners.note('surf-1', '');
    expect(surfaceOpeners.get('')).toBeUndefined();
    expect(surfaceOpeners.get('surf-1')).toBeUndefined();
  });

  it('bounds itself, dropping the least recently opened surface', () => {
    for (let i = 0; i < 600; i++) surfaceOpeners.note(`surf-${i}`, 'opener-a');
    expect(surfaceOpeners.get('surf-0')).toBeUndefined();
    expect(surfaceOpeners.get('surf-599')).toBe('opener-a');
  });

  it('keeps a surface that is still being asked about', () => {
    // Eviction is the dangerous direction: a LIVE surface whose entry is
    // dropped reads as unclaimed, and the next connection with nothing of its
    // own adopts it — the tab-sharing defect, one level down. Being asked
    // about is proof of life, so a read moves the entry to the young end.
    surfaceOpeners.note('surf-live', 'opener-a');
    for (let i = 0; i < 600; i++) {
      surfaceOpeners.note(`surf-${i}`, 'opener-b');
      expect(surfaceOpeners.get('surf-live')).toBe('opener-a');
    }
    expect(surfaceOpeners.get('surf-live')).toBe('opener-a');
  });
});
