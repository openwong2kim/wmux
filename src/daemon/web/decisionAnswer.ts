// `POST /api/approvals/:id/answer` body validation (decision-v2). Pure, so the
// whole 400 matrix is a table test. Unknown fields are refused rather than
// ignored: a field this daemon does not understand may be one the client
// thinks changes the answer.

import type { DecisionAnswer, DecisionTextRefusal } from '../approvals/types';

/** Most UTF-16 units a phone-typed answer text may have. */
export const DECISION_TEXT_MAX_UNITS = 2000;
const MAX_ANSWERS = 16;
const MAX_KEYS_PER_ANSWER = 32;

export type DecisionAnswerError = 'invalid-body' | 'invalid-text' | 'invalid-prompt-fingerprint';

export type DecisionAnswerParse =
  | { ok: true; answer: DecisionAnswer }
  | { ok: false; error: DecisionAnswerError; textRefusal?: DecisionTextRefusal };

const BODY_FIELDS: ReadonlySet<string> = new Set(['formFingerprint', 'clientAnswerId', 'action', 'answers', 'text']);
const ANSWER_FIELDS: ReadonlySet<string> = new Set(['questionId', 'keys', 'other']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Text typed on the phone that will be pasted into a dialog field. Every C0
 * control (newline included: it submits a dialog field early), DEL, every C1
 * control and U+2028/U+2029 are refused, as are whitespace-only and over-long
 * texts.
 */
export function isValidDecisionText(value: unknown): value is string {
  return decisionTextRefusal(value) === null;
}

/** Why `isValidDecisionText` refuses `value`, or null when it accepts it. */
export function decisionTextRefusal(value: unknown): DecisionTextRefusal | null {
  if (typeof value !== 'string') return 'unsafe-text';
  // C0, DEL, C1 (U+009B is a one-byte CSI to many terminals) and the
  // Unicode line/paragraph separators, which some fields take as a newline.
  // eslint-disable-next-line no-control-regex -- refusing them is the point
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) || value.trim().length === 0) return 'unsafe-text';
  return value.length > DECISION_TEXT_MAX_UNITS ? 'too-wide' : null;
}

export function parseDecisionAnswerBody(body: unknown): DecisionAnswerParse {
  if (!isPlainObject(body)) return { ok: false, error: 'invalid-body' };
  for (const key of Object.keys(body)) {
    if (!BODY_FIELDS.has(key)) return { ok: false, error: 'invalid-body' };
  }
  const { formFingerprint, clientAnswerId, action, answers, text } = body;
  if (typeof formFingerprint !== 'string' || !/^[0-9a-f]{32}$/.test(formFingerprint)) {
    return { ok: false, error: 'invalid-prompt-fingerprint' };
  }
  if (typeof clientAnswerId !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(clientAnswerId)) {
    return { ok: false, error: 'invalid-body' };
  }
  if (action !== undefined && (typeof action !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(action))) {
    return { ok: false, error: 'invalid-body' };
  }
  if (action === undefined && answers === undefined) return { ok: false, error: 'invalid-body' };
  if (text !== undefined && !isValidDecisionText(text)) return { ok: false, error: 'invalid-text', textRefusal: decisionTextRefusal(text)! };

  let parsedAnswers: DecisionAnswer['answers'];
  if (answers !== undefined) {
    if (!Array.isArray(answers) || answers.length === 0 || answers.length > MAX_ANSWERS) {
      return { ok: false, error: 'invalid-body' };
    }
    parsedAnswers = [];
    const seen = new Set<string>();
    for (const raw of answers) {
      if (!isPlainObject(raw)) return { ok: false, error: 'invalid-body' };
      for (const key of Object.keys(raw)) {
        if (!ANSWER_FIELDS.has(key)) return { ok: false, error: 'invalid-body' };
      }
      const { questionId, keys, other } = raw;
      if (typeof questionId !== 'string' || !/^q\d{1,2}$/.test(questionId) || seen.has(questionId)) {
        return { ok: false, error: 'invalid-body' };
      }
      seen.add(questionId);
      if (!Array.isArray(keys) || keys.length > MAX_KEYS_PER_ANSWER
        || !keys.every((k) => typeof k === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(k))
        || new Set(keys).size !== keys.length) {
        return { ok: false, error: 'invalid-body' };
      }
      if (other !== undefined && !isValidDecisionText(other)) return { ok: false, error: 'invalid-text', textRefusal: decisionTextRefusal(other)! };
      if (keys.length === 0 && other === undefined) return { ok: false, error: 'invalid-body' };
      parsedAnswers.push({ questionId, keys: [...keys] as string[], ...(other !== undefined ? { other } : {}) });
    }
  }

  return {
    ok: true,
    answer: {
      formFingerprint,
      clientAnswerId,
      ...(action !== undefined ? { action } : {}),
      ...(parsedAnswers ? { answers: parsedAnswers } : {}),
      ...(text !== undefined ? { text } : {}),
    },
  };
}
