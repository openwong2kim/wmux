import { describe, it, expect } from 'vitest';
import {
  STAR_PROMPT_COOLDOWN_MS,
  STAR_PROMPT_FIRST_THRESHOLD,
  STAR_PROMPT_MAX_THRESHOLD,
  STAR_PROMPT_MIN_AGE_MS,
  completeStarPrompt,
  dismissStarPrompt,
  ghHttpStatus,
  initialStarPromptState,
  normalizeStarPromptState,
  recordStarPromptAgentSession,
  starPromptEligible,
  starPutSucceeded,
  starredCheckFromGh,
  type StarPromptState,
} from '../starPrompt';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

/** Old enough, enough sessions, no deferral, not completed. */
function ready(over: Partial<StarPromptState> = {}): StarPromptState {
  return {
    firstSeenAt: T0,
    agentSessionsSinceBaseline: STAR_PROMPT_FIRST_THRESHOLD,
    nextThreshold: STAR_PROMPT_FIRST_THRESHOLD,
    deferredUntil: null,
    completed: false,
    ...over,
  };
}

describe('initialStarPromptState', () => {
  it('starts the wait now, at a threshold of 20 and nothing deferred', () => {
    expect(initialStarPromptState(T0)).toEqual({
      firstSeenAt: T0,
      agentSessionsSinceBaseline: 0,
      nextThreshold: 20,
      deferredUntil: null,
      completed: false,
    });
  });
});

describe('starPromptEligible', () => {
  const later = T0 + STAR_PROMPT_MIN_AGE_MS;

  it('shows once three days have passed and the threshold is reached', () => {
    expect(starPromptEligible(ready(), later)).toBe(true);
  });

  it('never shows once completed', () => {
    expect(starPromptEligible(ready({ completed: true }), later + 100 * DAY)).toBe(false);
  });

  it('waits three days from firstSeenAt, however many sessions there are', () => {
    expect(starPromptEligible(ready({ agentSessionsSinceBaseline: 500 }), later - 1)).toBe(false);
  });

  it('waits for the threshold', () => {
    expect(starPromptEligible(ready({ agentSessionsSinceBaseline: STAR_PROMPT_FIRST_THRESHOLD - 1 }), later)).toBe(false);
  });

  it('stays away until deferredUntil, then comes back', () => {
    const s = ready({ deferredUntil: later + DAY });
    expect(starPromptEligible(s, later + DAY - 1)).toBe(false);
    expect(starPromptEligible(s, later + DAY)).toBe(true);
  });
});

describe('dismissStarPrompt ("Not now")', () => {
  it('doubles the threshold, restarts the count and adds a three-day cooldown', () => {
    const now = T0 + 10 * DAY;
    const next = dismissStarPrompt(ready({ agentSessionsSinceBaseline: 33 }), now);
    expect(next).toEqual({
      firstSeenAt: T0,
      agentSessionsSinceBaseline: 0,
      nextThreshold: 40,
      deferredUntil: now + STAR_PROMPT_COOLDOWN_MS,
      completed: false,
    });
    expect(starPromptEligible(next, now)).toBe(false);
  });

  it('keeps doubling on every dismiss: 20, 40, 80, 160', () => {
    let s = ready();
    const seen: number[] = [s.nextThreshold];
    for (let i = 0; i < 3; i++) {
      s = dismissStarPrompt(s, T0 + 10 * DAY);
      seen.push(s.nextThreshold);
    }
    expect(seen).toEqual([20, 40, 80, 160]);
  });

  it('needs the cooldown AND the doubled count before it shows again', () => {
    const now = T0 + 10 * DAY;
    let s = dismissStarPrompt(ready(), now);
    const afterCooldown = now + STAR_PROMPT_COOLDOWN_MS;
    // Cooldown over, but no sessions yet.
    expect(starPromptEligible(s, afterCooldown)).toBe(false);
    for (let i = 0; i < 40; i++) s = recordStarPromptAgentSession(s);
    // Enough sessions, but still inside the cooldown.
    expect(starPromptEligible(s, afterCooldown - 1)).toBe(false);
    expect(starPromptEligible(s, afterCooldown)).toBe(true);
  });

  it('stops doubling at the cap', () => {
    const s = dismissStarPrompt(ready({ nextThreshold: STAR_PROMPT_MAX_THRESHOLD }), T0);
    expect(s.nextThreshold).toBe(STAR_PROMPT_MAX_THRESHOLD);
  });
});

describe('recordStarPromptAgentSession', () => {
  it('counts one session', () => {
    const s = initialStarPromptState(T0);
    expect(recordStarPromptAgentSession(s).agentSessionsSinceBaseline).toBe(1);
  });

  it('stops counting at the threshold (same object back)', () => {
    const s = ready();
    expect(recordStarPromptAgentSession(s)).toBe(s);
  });

  it('counts nothing once completed', () => {
    const s = { ...initialStarPromptState(T0), completed: true };
    expect(recordStarPromptAgentSession(s)).toBe(s);
  });
});

describe('completeStarPrompt', () => {
  it('marks it done, and returns the same object when already done', () => {
    const done = completeStarPrompt(ready());
    expect(done.completed).toBe(true);
    expect(completeStarPrompt(done)).toBe(done);
  });
});

describe('normalizeStarPromptState', () => {
  it('starts fresh at load time for a session from before the feature', () => {
    expect(normalizeStarPromptState(undefined, T0)).toEqual(initialStarPromptState(T0));
    expect(normalizeStarPromptState(null, T0)).toEqual(initialStarPromptState(T0));
    expect(normalizeStarPromptState('nope', T0)).toEqual(initialStarPromptState(T0));
  });

  it('keeps a saved state as it was', () => {
    const saved = ready({ deferredUntil: T0 + DAY, nextThreshold: 80, agentSessionsSinceBaseline: 7 });
    expect(normalizeStarPromptState(saved, T0 + 5 * DAY)).toEqual(saved);
  });

  it('repairs damaged fields one by one', () => {
    const s = normalizeStarPromptState({
      firstSeenAt: 'x',
      agentSessionsSinceBaseline: -3,
      nextThreshold: 0,
      deferredUntil: Number.NaN,
      completed: 'yes',
    }, T0);
    expect(s).toEqual(initialStarPromptState(T0));
  });

  it('caps a huge threshold', () => {
    expect(normalizeStarPromptState({ nextThreshold: 1e15 }, T0).nextThreshold).toBe(STAR_PROMPT_MAX_THRESHOLD);
  });
});

describe('gh answers', () => {
  it('reads the status from the --include line, else from gh\'s error', () => {
    expect(ghHttpStatus({ ok: true, stdout: 'HTTP/2.0 204 No Content\r\nDate: x\r\n\r\n' })).toBe(204);
    expect(ghHttpStatus({ ok: false, stdout: 'HTTP/1.1 404 Not Found\n' })).toBe(404);
    expect(ghHttpStatus({ ok: false, stderr: 'gh: Not Found (HTTP 404)' })).toBe(404);
    expect(ghHttpStatus({ ok: false, stderr: 'error connecting to api.github.com' })).toBeNull();
  });

  it('maps the starred check: 204 starred, 404 not starred, anything else unknown', () => {
    expect(starredCheckFromGh({ ok: true, stdout: 'HTTP/2.0 204 No Content\n' })).toBe('starred');
    expect(starredCheckFromGh({ ok: true, stdout: '' })).toBe('starred');
    expect(starredCheckFromGh({ ok: false, stdout: 'HTTP/2.0 404 Not Found\n{"message":"Not Found"}' })).toBe('not-starred');
    expect(starredCheckFromGh({ ok: false, stderr: 'gh: Not Found (HTTP 404)' })).toBe('not-starred');
    expect(starredCheckFromGh({ ok: false, stdout: 'HTTP/2.0 401 Unauthorized\n' })).toBe('unknown');
    expect(starredCheckFromGh({ ok: false, stdout: '', stderr: 'timeout' })).toBe('unknown');
  });

  it('counts a star as done only on 204 (or a bare gh success)', () => {
    expect(starPutSucceeded({ ok: true, stdout: 'HTTP/2.0 204 No Content\n' })).toBe(true);
    expect(starPutSucceeded({ ok: true, stdout: '' })).toBe(true);
    expect(starPutSucceeded({ ok: true, stdout: 'HTTP/2.0 200 OK\n' })).toBe(false);
    expect(starPutSucceeded({ ok: false, stdout: 'HTTP/2.0 404 Not Found\n' })).toBe(false);
    expect(starPutSucceeded({ ok: false, stderr: 'gh: Resource not accessible (HTTP 403)' })).toBe(false);
  });
});
