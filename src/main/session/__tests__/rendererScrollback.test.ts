// The attach flush snapshots as many rows as the renderer keeps. Main learns
// the renderer's setting from the session it loads and saves.
import { describe, it, expect, beforeEach } from 'vitest';
import { attachScrollback, noteRendererScrollback, resetRendererScrollback } from '../rendererScrollback';
import { SNAPSHOT_MAX_SCROLLBACK } from '../../../shared/terminal/attachSnapshot';

describe('renderer scrollback for attach', () => {
  beforeEach(() => resetRendererScrollback());

  it('asks for the lossless ceiling until a session says otherwise, then for the setting', () => {
    expect(attachScrollback()).toBe(SNAPSHOT_MAX_SCROLLBACK);
    noteRendererScrollback({ scrollbackLines: 10000 });
    expect(attachScrollback()).toBe(10000);
  });

  it('ignores a session without a usable value and keeps the last good one', () => {
    noteRendererScrollback({ scrollbackLines: 25000 });
    for (const bad of [undefined, null, {}, { scrollbackLines: 0 }, { scrollbackLines: -5 }, { scrollbackLines: Number.NaN }, { scrollbackLines: '9000' }]) {
      noteRendererScrollback(bad as never);
    }
    expect(attachScrollback()).toBe(25000);
  });
});
