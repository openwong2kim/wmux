// Pane usage-limit pause: the shared contract and its pure helpers.
//
// Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src/features/sessions/model/usageLimit.ts and
// src/features/providers/model/rateLimits.ts), MIT License, Copyright (c) 2026 Nick
//
// An agent pane that hit its provider's usage limit is HELD: nothing automatic
// (scheduled prompts, channel wakes, a2a deliveries) types into it until the
// window resets. The daemon owns the state (keyed by ptyId) because it owns the
// PTY, the hook ingest and the wake worker; main mirrors it for its delivery
// gate and the renderer for display. Sending a continue message after the reset
// is opt-in only — `autoResume` is never true unless someone set it.

export type UsageLimitProvider = 'claude' | 'codex';

/** One held pane. Plain data: crosses daemon → main → renderer unchanged. */
export interface PaneUsageLimit {
  ptyId: string;
  provider: UsageLimitProvider;
  /** Epoch ms the limit was seen. */
  detectedAt: number;
  /** Epoch ms the provider's window resets, once known. */
  resetsAt?: number;
  /** Where the limit came from: the agent's StopFailure hook or its screen output. */
  source: 'hook' | 'screen';
  /**
   * Send `USAGE_LIMIT_CONTINUE_PROMPT` once the window resets. Undefined means
   * nobody decided for this pane yet (the renderer applies the global setting);
   * the daemon treats anything but `true` as "do not resume".
   */
  autoResume?: boolean;
  /** The provider's own limit text, control-stripped and clipped. */
  message?: string;
}

/** Renderer → daemon edits. `resumeNow` sends the continue message immediately. */
export interface PaneUsageLimitPatch {
  autoResume?: boolean;
  /** Epoch ms; main fills a reset time the hook text did not carry. */
  resetsAt?: number;
  dismiss?: true;
  resumeNow?: true;
}

/** Providers can still refuse right at the reset; give them a moment. */
export const USAGE_LIMIT_RESUME_GRACE_MS = 30_000;
/** With no known reset time a pane is held this long at most, so it cannot wedge. */
export const USAGE_LIMIT_UNKNOWN_HOLD_MS = 5 * 60 * 60 * 1000;
/** The continue message sent after the reset (opt-in). */
export const USAGE_LIMIT_CONTINUE_PROMPT = 'Continue from where you left off.';
const MESSAGE_MAX = 280;

/** When the hold ends: the reset (plus grace), or the unknown-reset cap. */
export function usageLimitHoldEndsAt(limit: Pick<PaneUsageLimit, 'detectedAt' | 'resetsAt'>): number {
  return limit.resetsAt != null
    ? limit.resetsAt + USAGE_LIMIT_RESUME_GRACE_MS
    : limit.detectedAt + USAGE_LIMIT_UNKNOWN_HOLD_MS;
}

/** True while automatic input must wait. */
export function usageLimitHolds(limit: PaneUsageLimit | undefined | null, now: number): boolean {
  return !!limit && now < usageLimitHoldEndsAt(limit);
}

/** Armed, with a known reset that has passed: time to send the continue message. */
export function usageLimitResumeDue(limit: PaneUsageLimit | undefined | null, now: number): boolean {
  if (!limit || limit.autoResume !== true || limit.resetsAt == null) return false;
  return now >= limit.resetsAt + USAGE_LIMIT_RESUME_GRACE_MS;
}

/** "4h 42m", "1d 4h", "12m", "now". */
export function formatResetDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMins = Math.floor(ms / 60_000);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/** "3:16 PM" today, "Sep 26, 3:16 PM" on a later day (viewer's locale and zone). */
export function formatResetClock(resetsAt: number, now: number, locale?: string): string {
  const reset = new Date(resetsAt);
  const sameDay = reset.toDateString() === new Date(now).toDateString();
  return reset.toLocaleString(locale, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A usage window as wmux's readers report it (UsageSnapshot / statusline / Codex buckets). */
export interface UsageWindowReading {
  /** 0–100 (may overshoot). */
  pct: number;
  /** Epoch ms; null/undefined when the source did not say. */
  resetsAt?: number | null;
}

/** The latest reset among exhausted (>= 100%) windows: that is when the pane can work again. */
export function exhaustedWindowResetAt(windows: ReadonlyArray<UsageWindowReading | null | undefined>): number | null {
  let latest: number | null = null;
  for (const w of windows) {
    if (!w || w.pct < 100 || w.resetsAt == null) continue;
    latest = Math.max(latest ?? 0, w.resetsAt);
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Text detection
// ---------------------------------------------------------------------------

/**
 * Claude Code's limit text (StopFailure `last_assistant_message`, or the TUI
 * row): "You've hit your limit · resets 3pm (Asia/Seoul)", "You've hit your
 * weekly limit · resets Oct 7, 9am", "5-hour limit reached ∙ resets 3pm",
 * "Claude usage limit reached. Your limit will reset at 3pm (America/New_York).",
 * and the old "Claude AI usage limit reached|1717000000".
 */
const CLAUDE_LIMIT_TEXT = /\bhit your (?:[\w-]+ )?limit\b|\busage limit reached\b|\b[\w-]+ limit reached\s*[·∙•]\s*resets?\b/i;
/** Codex's limit row: "You've hit your usage limit. … try again at 3:05 PM." */
const CODEX_LIMIT_HEAD = /^\s*(?:[■•▌>⚠]\s*)?You['’]ve hit your usage limit\b/i;

/** Strip control characters, collapse whitespace, clip. */
export function clipLimitMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > MESSAGE_MAX ? `${flat.slice(0, MESSAGE_MAX - 1)}…` : flat;
}

/** True when Claude's text says a usage cap (not a transient 429) ended the turn. */
export function isClaudeUsageLimitText(text: string): boolean {
  return CLAUDE_LIMIT_TEXT.test(text);
}

/** True when a cleaned Codex output line opens its usage-limit message. Anchored at the row start. */
export function isCodexUsageLimitLine(line: string): boolean {
  return CODEX_LIMIT_HEAD.test(line);
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** Minutes the zone is ahead of UTC at `epochMs` (Intl, no tz database of our own). */
function zoneOffsetMinutes(epochMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(epochMs));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    const offset = Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
    return Number.isFinite(offset) ? offset : null;
  } catch {
    return null; // unknown zone name
  }
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number }

/** Wall-clock fields of `epochMs` in `timeZone` (or the process's local zone). */
function wallClockAt(epochMs: number, timeZone: string | null): WallClock {
  if (timeZone) {
    const off = zoneOffsetMinutes(epochMs, timeZone);
    if (off != null) {
      const d = new Date(epochMs + off * 60_000);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
    }
  }
  const d = new Date(epochMs);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
}

/** Epoch ms of a wall-clock time in `timeZone` (or local). Re-checks the offset once for DST edges. */
function epochOfWallClock(w: WallClock, timeZone: string | null): number {
  const guess = Date.UTC(w.year, w.month, w.day, w.hour, w.minute);
  if (timeZone && zoneOffsetMinutes(guess, timeZone) != null) {
    let epoch = guess - (zoneOffsetMinutes(guess, timeZone) as number) * 60_000;
    const settled = zoneOffsetMinutes(epoch, timeZone);
    if (settled != null) epoch = guess - settled * 60_000;
    return epoch;
  }
  return new Date(w.year, w.month, w.day, w.hour, w.minute).getTime();
}

/**
 * The reset instant a provider's limit text names, or null. Understands
 * "resets 3pm (Asia/Seoul)", "resets Oct 7, 9:30am", "reset at 3pm",
 * "try again at 3:05 PM", "try again at Oct 5th, 2026 3:05 PM",
 * "try again in 2 hours 13 minutes", and the old "|<epoch seconds>" suffix.
 * A time with no date is the next such time after `now` in the named zone
 * (the viewer's local zone when none is named or the name is unknown).
 */
export function parseUsageLimitReset(text: string, now: number): number | null {
  const epoch = /\|\s*(\d{10})\b/.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;

  const rel = /\b(?:try again|resets?)\s+in\s+(\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b(?:\s*(?:,|and)?\s*\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b)*)/i.exec(text);
  if (rel) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      ms += unit.startsWith('d') ? n * 86_400_000 : unit.startsWith('h') ? n * 3_600_000 : n * 60_000;
    }
    return ms > 0 ? now + ms : null;
  }

  const abs = /\b(?:resets?(?:\s+at)?|reset at|try again at)\s+(?:(?:on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i.exec(text);
  if (!abs) return null;
  const [, monthName, dayStr, yearStr, hourStr, minStr, ampm, zone] = abs;
  if (Number(hourStr) < 1 || Number(hourStr) > 12) return null;
  let hour = Number(hourStr) % 12;
  if (ampm.toLowerCase() === 'p') hour += 12;
  const minute = minStr ? Number(minStr) : 0;
  if (hour > 23 || minute > 59) return null;
  const timeZone = zone && zoneOffsetMinutes(now, zone) != null ? zone : null;
  const today = wallClockAt(now, timeZone);

  if (monthName) {
    const month = MONTHS[monthName.slice(0, 4).toLowerCase()] ?? MONTHS[monthName.slice(0, 3).toLowerCase()];
    const day = Number(dayStr);
    if (month == null || day < 1 || day > 31) return null;
    let year = yearStr ? Number(yearStr) : today.year;
    let at = epochOfWallClock({ year, month, day, hour, minute }, timeZone);
    // No year given and the date already passed this year: it means next year.
    if (!yearStr && at < now - 86_400_000) {
      year += 1;
      at = epochOfWallClock({ year, month, day, hour, minute }, timeZone);
    }
    return at;
  }
  let at = epochOfWallClock({ ...today, hour, minute }, timeZone);
  // A bare time already behind us is tomorrow's (a minute of slack for a reset
  // that is happening right now).
  if (at <= now - 60_000) {
    const next = new Date(Date.UTC(today.year, today.month, today.day + 1));
    at = epochOfWallClock({ year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate(), hour, minute }, timeZone);
  }
  return at;
}

/**
 * Claude Code `StopFailure` payload → a usage limit, or null. `error` must be
 * `rate_limit` (Claude reports a subscription cap with that code) AND the text
 * Claude showed must name a usage limit: a persistent plain 429 also ends a
 * turn with `rate_limit`, and holding a pane for it would be wrong.
 */
export function claudeUsageLimitFromStopFailure(
  payload: Record<string, unknown> | undefined,
  now: number,
): { resetsAt?: number; message?: string } | null {
  if (!payload || payload.error !== 'rate_limit') return null;
  const text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
  if (!isClaudeUsageLimitText(text)) return null;
  const resetsAt = parseUsageLimitReset(text, now);
  const message = clipLimitMessage(text);
  return { ...(resetsAt != null ? { resetsAt } : {}), ...(message ? { message } : {}) };
}

/**
 * Codex screen rows. Codex wraps its limit message across rows, so the
 * "try again at …" clause can land a row or two after the head. Feed cleaned
 * lines in order; `feed` returns a detection when the head appears and an
 * update when a following row supplies the reset time.
 */
export class CodexUsageLimitLineScanner {
  private pending: { text: string; rowsLeft: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  feed(line: string): { resetsAt?: number; message?: string } | null {
    if (isCodexUsageLimitLine(line)) {
      const resetsAt = parseUsageLimitReset(line, this.now());
      this.pending = resetsAt == null ? { text: line, rowsLeft: 3 } : null;
      const message = clipLimitMessage(line);
      return { ...(resetsAt != null ? { resetsAt } : {}), ...(message ? { message } : {}) };
    }
    if (!this.pending) return null;
    const text = `${this.pending.text} ${line}`;
    const resetsAt = parseUsageLimitReset(text, this.now());
    if (resetsAt != null) {
      this.pending = null;
      const message = clipLimitMessage(text);
      return { resetsAt, ...(message ? { message } : {}) };
    }
    this.pending = --this.pending.rowsLeft > 0 ? { ...this.pending, text } : null;
    return null;
  }
}
