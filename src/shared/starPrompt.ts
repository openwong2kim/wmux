/**
 * "Enjoying wmux? · Star on GitHub": when the sidebar's foot may ask, and how
 * a "Not now" pushes the next ask away (owner-approved 2026-10-21, DESIGN.md ›
 * Sidebar).
 *
 * All of it is local state persisted in SessionData; nothing here is
 * telemetry. The prompt waits for real use: at least three days since wmux
 * first ran this feature, and a number of new agent sessions started since the
 * last baseline. Each "Not now" doubles that number, restarts the count and
 * adds a three-day cooldown, so a user who keeps declining is asked less and
 * less often. Starring (by any path) ends it for good.
 */

export const STAR_REPO = 'openwong2kim/wmux';
export const STAR_REPO_URL = `https://github.com/${STAR_REPO}`;

/** New agent sessions before the first ask. */
export const STAR_PROMPT_FIRST_THRESHOLD = 20;
/** Minimum time between the feature first running and the first ask. */
export const STAR_PROMPT_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** How long a "Not now" keeps the row away, whatever the count. */
export const STAR_PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
/** Doubling stops here: past it the row would never come back in practice,
 *  and the number stays a sane integer in session.json. */
export const STAR_PROMPT_MAX_THRESHOLD = 1 << 20;

export interface StarPromptState {
  /** When this feature first ran on this install (epoch ms). */
  firstSeenAt: number;
  /** New agent sessions since the last baseline (start, or the last "Not now"). */
  agentSessionsSinceBaseline: number;
  /** Sessions needed before the row may show. */
  nextThreshold: number;
  /** A "Not now" keeps the row away until then (epoch ms), or null. */
  deferredUntil: number | null;
  /** Starred (verified via gh, or the repository page was opened): never ask again. */
  completed: boolean;
}

export function initialStarPromptState(now: number): StarPromptState {
  return {
    firstSeenAt: now,
    agentSessionsSinceBaseline: 0,
    nextThreshold: STAR_PROMPT_FIRST_THRESHOLD,
    deferredUntil: null,
    completed: false,
  };
}

function finiteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * The state read back from a saved session. A session from before this
 * feature (or a damaged field) starts fresh at `now`, so every existing user
 * waits the full three days from the upgrade.
 */
export function normalizeStarPromptState(raw: unknown, now: number): StarPromptState {
  const fresh = initialStarPromptState(now);
  if (!raw || typeof raw !== 'object') return fresh;
  const r = raw as Partial<Record<keyof StarPromptState, unknown>>;
  return {
    firstSeenAt: finiteNonNegative(r.firstSeenAt) ? r.firstSeenAt : fresh.firstSeenAt,
    agentSessionsSinceBaseline: finiteNonNegative(r.agentSessionsSinceBaseline)
      ? Math.floor(r.agentSessionsSinceBaseline)
      : 0,
    nextThreshold: finiteNonNegative(r.nextThreshold) && r.nextThreshold >= 1
      ? Math.min(Math.floor(r.nextThreshold), STAR_PROMPT_MAX_THRESHOLD)
      : STAR_PROMPT_FIRST_THRESHOLD,
    deferredUntil: finiteNonNegative(r.deferredUntil) ? r.deferredUntil : null,
    completed: r.completed === true,
  };
}

/** May the sidebar's foot show the star row right now? */
export function starPromptEligible(s: StarPromptState, now: number): boolean {
  if (s.completed) return false;
  if (now < s.firstSeenAt + STAR_PROMPT_MIN_AGE_MS) return false;
  if (s.deferredUntil !== null && now < s.deferredUntil) return false;
  return s.agentSessionsSinceBaseline >= s.nextThreshold;
}

/** "Not now": twice as many sessions next time, counted from zero, and three days of quiet. */
export function dismissStarPrompt(s: StarPromptState, now: number): StarPromptState {
  return {
    ...s,
    nextThreshold: Math.min(s.nextThreshold * 2, STAR_PROMPT_MAX_THRESHOLD),
    agentSessionsSinceBaseline: 0,
    deferredUntil: now + STAR_PROMPT_COOLDOWN_MS,
  };
}

/** One new agent session started. Nothing is counted once the prompt is done. */
export function recordStarPromptAgentSession(s: StarPromptState): StarPromptState {
  if (s.completed) return s;
  // Counting past the threshold is pointless; the cap keeps the number small.
  if (s.agentSessionsSinceBaseline >= s.nextThreshold) return s;
  return { ...s, agentSessionsSinceBaseline: s.agentSessionsSinceBaseline + 1 };
}

export function completeStarPrompt(s: StarPromptState): StarPromptState {
  return s.completed ? s : { ...s, completed: true };
}

// ─── Main-process answers (gh) ──────────────────────────────────────────────

/**
 * Is the repository starred by the gh account?
 *  - `starred` / `not-starred`: GitHub answered 204 / 404.
 *  - `unknown`: gh is missing or signed out, or the call failed or timed out.
 */
export type StarredCheck = 'starred' | 'not-starred' | 'unknown';

/**
 * What the star action did:
 *  - `starred`: gh starred it (204), so the row may say thank you.
 *  - `opened`: the repository page was opened in the browser (no gh, or gh failed).
 *  - `failed`: neither worked; the prompt stays as it was.
 */
export type StarActionResult = 'starred' | 'opened' | 'failed';

/** What a finished `gh api --include …` run left behind. */
export interface GhApiOutcome {
  /** True when gh exited 0 (it does so only for a 2xx answer). */
  ok: boolean;
  stdout?: string;
  stderr?: string;
}

/** The HTTP status gh reported: the `--include` status line, else gh's own "(HTTP 404)" error. */
export function ghHttpStatus(o: GhApiOutcome): number | null {
  const line = /^HTTP\/[\d.]+\s+(\d{3})\b/m.exec(o.stdout ?? '');
  if (line) return Number(line[1]);
  const err = /\(HTTP (\d{3})\)/.exec(o.stderr ?? '');
  return err ? Number(err[1]) : null;
}

/** `GET /user/starred/{owner}/{repo}`: 204 is starred, 404 is not, anything else unknown. */
export function starredCheckFromGh(o: GhApiOutcome): StarredCheck {
  const status = ghHttpStatus(o);
  if (status === 204 || (o.ok && status === null)) return 'starred';
  if (status === 404) return 'not-starred';
  return 'unknown';
}

/** `PUT /user/starred/{owner}/{repo}` succeeded only on a 204 (or a bare gh success). */
export function starPutSucceeded(o: GhApiOutcome): boolean {
  if (!o.ok) return false;
  const status = ghHttpStatus(o);
  return status === null || status === 204;
}
