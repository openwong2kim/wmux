// Moa Fleet fast path — answer a short, read-only Fleet question locally.
//
// A closed allowlist of whole-message phrasings (English and Korean) decides
// whether a desktop composer message is a plain "who needs me / what finished /
// fleet status" question. When it is, and the operator turned the setting on,
// the answer is rendered from the same local Fleet board the Fleet overlay
// shows, without starting a Moa turn. Everything else — unfamiliar phrasing,
// mixed requests, actions, names, dates, a stale or malformed board, a lookup
// error — returns null and the message goes to Moa unchanged.
//
// Nothing here talks to the network. The question and the board never leave
// the machine.
//
// The answer leaves here as data, not prose: the renderer words it in the
// operator's UI language (shared/fleetLocalAnswer.ts).

import { FLEET_ANSWER_MAX_ROWS, type FleetAnswerReason, type FleetAnswerRow, type FleetIntent, type FleetLocalAnswer } from '../../shared/fleetLocalAnswer';

export type { FleetIntent, FleetLocalAnswer } from '../../shared/fleetLocalAnswer';

/** Board lookup budget. A miss falls back to Moa, so keep it short. */
export const FLEET_BOARD_TIMEOUT_MS = 400;

/** Whole-message allowlist. Deliberately excludes names, free-form context,
 *  mixed instructions and dates: anything outside it is Moa's to answer. */
export function fleetIntentCandidate(text: string): FleetIntent | null {
  if (text.length > 160) return null;
  const q = text.trim().toLowerCase().replace(/[?!.]+$/, '').replace(/\s+/g, ' ').trim();
  if (/^(?:(?:which|what) (?:tasks|agents) (?:need me|need my (?:input|attention))|who needs me|what needs my attention|show (?:me )?(?:tasks|agents) (?:that )?need(?:ing)? (?:me|my (?:input|attention))|나를 필요로 하는 작업|내가 봐야 할 작업|내 확인이 필요한 작업|뭐가 나를 필요로 해)$/.test(q)) return 'needs_you';
  if (/^(?:what(?:(?:'s| is) (?:finished|done|complete)| (?:has )?(?:finished|completed))|which (?:tasks|agents) (?:are |have )?(?:finished|done|complete|completed)|show (?:me )?(?:finished|completed) tasks|끝난 작업|완료된 작업|뭐가 끝났어)$/.test(q)) return 'finished';
  if (/^(?:(?:fleet|task|tasks|agent|agents) status|status|show (?:me )?(?:the )?fleet status|how (?:is|are) (?:the )?(?:fleet|tasks|agents)(?: doing)?|작업 상태|전체 작업 상태|현재 작업 상태|에이전트 상태)$/.test(q)) return 'status';
  return null;
}

/**
 * Answer an allowlisted question from the local board, or null to fall back
 * to Moa. `readBoard` is the renderer's `fleet.triage` selector; it may throw
 * or time out, and both mean "ask Moa". A cancelled signal discards a late
 * board instead of rendering it.
 */
export async function answerFleetQuestion(
  text: string,
  readBoard: () => Promise<unknown>,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<{ fleet: FleetLocalAnswer } | null> {
  const intent = fleetIntentCandidate(text);
  if (!intent || signal.aborted) return null;
  const requestedAt = now();
  let board: unknown;
  try {
    board = await readBoard();
  } catch {
    return null;
  }
  if (signal.aborted) return null;
  const fleet = buildFleetAnswer(board, intent, now(), requestedAt);
  return fleet ? { fleet } : null;
}

interface BoardRow { title: string; workspaceName: string; reason: string }
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function validRows(rows: unknown): rows is BoardRow[] {
  return Array.isArray(rows) && rows.length <= 80 && rows.every((row) => isObject(row)
    && typeof row.title === 'string' && row.title.length <= 4096
    && typeof row.workspaceName === 'string' && row.workspaceName.length <= 4096
    && typeof row.reason === 'string' && ['input', 'error', 'unconfirmed', 'supervisionStopped', 'complete', 'running', 'idle'].includes(row.reason));
}
// Strip untrusted display controls rather than interpreting terminal labels.
// Empty when nothing displayable is left: the renderer words "untitled".
// eslint-disable-next-line no-control-regex
const label = (s: string) => s.replace(/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff[\]()*_`<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** Reports the Fleet board only: never certifies task success or runs an
 *  action. Null for a board that is malformed, scoped or not fresh. */
export function buildFleetAnswer(raw: unknown, intent: FleetIntent, now: number, requestedAt: number): FleetLocalAnswer | null {
  if (!isObject(raw) || raw.scope !== 'fleet' || typeof raw.generatedAt !== 'number' || !Number.isFinite(raw.generatedAt)
    || raw.generatedAt > now + 1000 || now - raw.generatedAt > 2000 || raw.generatedAt < requestedAt - 1000
    || !validRows(raw.needsYou) || !validRows(raw.finished) || !validRows(raw.running)
    || !isObject(raw.idle) || !Number.isSafeInteger(raw.idle.count) || (raw.idle.count as number) < 0) return null;
  if (raw.needsYou.some((r) => !['input', 'error', 'unconfirmed', 'supervisionStopped'].includes(r.reason))
    || raw.finished.some((r) => r.reason !== 'complete') || raw.running.some((r) => r.reason !== 'running')) return null;
  const omitted = raw.omitted === undefined ? {} : raw.omitted;
  if (!isObject(omitted) || Object.keys(omitted).some((k) => !['needsYou', 'finished', 'running', 'idle'].includes(k) || !Number.isSafeInteger(omitted[k]) || (omitted[k] as number) < 0)) return null;
  const count = (key: 'needsYou' | 'finished' | 'running', rows: BoardRow[]) => rows.length + ((omitted[key] as number | undefined) ?? 0);
  const rows = intent === 'needs_you' ? raw.needsYou : intent === 'finished' ? raw.finished : [...raw.needsYou, ...raw.finished];
  const listed = rows.slice(0, FLEET_ANSWER_MAX_ROWS).map((r): FleetAnswerRow => ({
    title: label(r.title),
    workspaceName: label(r.workspaceName),
    // Validated above: Needs you rows carry a Needs you reason, finished rows `complete`.
    reason: r.reason as FleetAnswerReason,
  }));
  return {
    intent,
    counts: {
      needsYou: count('needsYou', raw.needsYou),
      finished: count('finished', raw.finished),
      running: count('running', raw.running),
      idle: raw.idle.count as number,
    },
    rows: listed,
    limited: rows.length > FLEET_ANSWER_MAX_ROWS || Object.values(omitted).some((n) => (n as number) > 0),
  };
}
