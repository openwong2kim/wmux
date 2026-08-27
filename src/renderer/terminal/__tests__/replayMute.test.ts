import { describe, it, expect } from 'vitest';
import {
  createReplayMute,
  isReplayMuted,
  beginReplayWrite,
  resetReplayMute,
} from '../replayMute';

/**
 * #998/#1014. Replay provenance is source-labelled, so only historical writes
 * acquire the mute. Their callbacks release it; a missing callback fails shut.
 */
describe('replayMute', () => {
  it('starts open', () => {
    expect(isReplayMuted(createReplayMute())).toBe(false);
  });

  it('mutes until the xterm write completion releases it', () => {
    const m = createReplayMute();
    const release = beginReplayWrite(m);
    expect(isReplayMuted(m)).toBe(true);
    release();
    expect(isReplayMuted(m)).toBe(false);
  });

  it('nests: the bridge reopens only after the last write settles', () => {
    const m = createReplayMute();
    const a = beginReplayWrite(m);
    const b = beginReplayWrite(m);
    a();
    expect(isReplayMuted(m)).toBe(true);
    b();
    expect(isReplayMuted(m)).toBe(false);
  });

  it('fails closed if xterm strands an earlier replay callback', () => {
    const m = createReplayMute();
    beginReplayWrite(m); // deliberately never released
    const later = beginReplayWrite(m);
    later();
    expect(isReplayMuted(m)).toBe(true);
  });

  it('is idempotent — a double release cannot unmute another write', () => {
    const m = createReplayMute();
    const a = beginReplayWrite(m);
    const b = beginReplayWrite(m);
    a();
    a();
    expect(isReplayMuted(m)).toBe(true);
    b();
    expect(isReplayMuted(m)).toBe(false);
  });

  it('ignores a release from a previous terminal generation', () => {
    const m = createReplayMute();
    const stale = beginReplayWrite(m);
    resetReplayMute(m);
    const fresh = beginReplayWrite(m);
    stale();
    expect(isReplayMuted(m)).toBe(true);
    fresh();
    expect(isReplayMuted(m)).toBe(false);
  });

  it('teardown drops all writes from the disposed terminal', () => {
    const m = createReplayMute();
    beginReplayWrite(m);
    beginReplayWrite(m);
    resetReplayMute(m);
    expect(isReplayMuted(m)).toBe(false);
  });
});
