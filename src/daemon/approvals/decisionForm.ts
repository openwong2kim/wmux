// Bounds for a `DecisionForm` a producer hands the registry. The form is
// agent-authored, persisted, and served to phones, so it gets the same limits
// the `/answer` body parser applies to what comes back: a form a phone could
// never answer within those limits is refused rather than stored.

import { boundRecordText } from './terminalPrompt';
import type { ApprovalDecision, DecisionAnswer, DecisionForm } from './types';

export const DECISION_FORM_MAX_QUESTIONS = 16;
export const DECISION_FORM_MAX_OPTIONS = 32;
export const DECISION_FORM_MAX_ACTIONS = 8;
const TEXT_MAX = 500;
const LABEL_MAX = 200;

/** Keys and ids use the same alphabets the answer parser accepts. */
const OPTION_KEY = /^[A-Za-z0-9_-]{1,16}$/;
const ACTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const QUESTION_ID = /^q\d{1,2}$/;

/**
 * A bounded, cleaned copy of `form` (text stripped of control characters and
 * capped), or null when its shape is out of bounds: too many questions,
 * options or actions, a malformed or repeated id/key, or an empty label.
 */
export function boundDecisionForm(form: DecisionForm): DecisionForm | null {
  if (form.v !== 1 || !['permission', 'plan', 'questions'].includes(form.kind)) return null;
  if (!Array.isArray(form.actions) || form.actions.length > DECISION_FORM_MAX_ACTIONS) return null;
  const actionIds = new Set<string>();
  const actions: DecisionForm['actions'] = [];
  for (const a of form.actions) {
    const label = boundRecordText(a?.label, LABEL_MAX);
    if (typeof a?.id !== 'string' || !ACTION_ID.test(a.id) || actionIds.has(a.id) || !label) return null;
    actionIds.add(a.id);
    actions.push({ id: a.id, label, ...(a.needsText ? { needsText: true as const } : {}) });
  }
  let questions: DecisionForm['questions'];
  if (form.questions !== undefined) {
    if (!Array.isArray(form.questions) || form.questions.length > DECISION_FORM_MAX_QUESTIONS) return null;
    questions = [];
    const questionIds = new Set<string>();
    for (const q of form.questions) {
      const text = boundRecordText(q?.text, TEXT_MAX);
      if (typeof q?.id !== 'string' || !QUESTION_ID.test(q.id) || questionIds.has(q.id) || !text) return null;
      if (!Array.isArray(q.options) || q.options.length > DECISION_FORM_MAX_OPTIONS) return null;
      questionIds.add(q.id);
      const keys = new Set<string>();
      const options: Array<{ key: string; label: string; description?: string }> = [];
      for (const o of q.options) {
        const label = boundRecordText(o?.label, LABEL_MAX);
        if (typeof o?.key !== 'string' || !OPTION_KEY.test(o.key) || keys.has(o.key) || !label) return null;
        keys.add(o.key);
        const description = o.description !== undefined ? boundRecordText(o.description, TEXT_MAX) : undefined;
        options.push({ key: o.key, label, ...(description ? { description } : {}) });
      }
      const header = boundRecordText(q.header, LABEL_MAX);
      questions.push({
        id: q.id,
        ...(header ? { header } : {}),
        text,
        multiSelect: q.multiSelect === true,
        allowOther: q.allowOther === true,
        options,
      });
    }
  }
  return { v: 1, kind: form.kind, ...(questions ? { questions } : {}), actions };
}

/**
 * A `decision-v2` answer to an agent-native form, as the decision and — for an
 * answered questions form — one entry per question in form order: the chosen
 * option keys and the typed answer. Null when it does not fit the form:
 * an unknown action or key, a question left out or answered twice over a
 * single select, a typed answer where none is allowed, or feedback text (no
 * native form asks for it). Permission: `approve` / `deny`. Questions:
 * `deny` (dismiss), or `answers` with no action or `submit`.
 */
export function nativeV2Answer(
  form: DecisionForm,
  answer: DecisionAnswer,
): { decision: ApprovalDecision; answers?: Array<{ keys: string[]; other?: string }> } | null {
  if (answer.text !== undefined) return null;
  if (form.kind === 'permission') {
    if (answer.answers !== undefined) return null;
    return answer.action === 'approve' ? { decision: 'approve' } : answer.action === 'deny' ? { decision: 'deny' } : null;
  }
  if (form.kind !== 'questions') return null;
  if (answer.action === 'deny') return answer.answers === undefined ? { decision: 'deny' } : null;
  if (answer.action !== undefined && answer.action !== 'submit') return null;
  const questions = form.questions ?? [];
  const given = answer.answers ?? [];
  if (questions.length === 0 || given.length !== questions.length) return null;
  const answers: Array<{ keys: string[]; other?: string }> = [];
  for (const question of questions) {
    const a = given.find((entry) => entry.questionId === question.id);
    if (!a) return null;
    if (a.other !== undefined && (!question.allowOther || !a.other.trim())) return null;
    if (!a.keys.every((key) => question.options.some((o) => o.key === key))) return null;
    const picked = a.keys.length + (a.other !== undefined ? 1 : 0);
    if (picked === 0 || (!question.multiSelect && picked > 1)) return null;
    answers.push({ keys: [...a.keys], ...(a.other !== undefined ? { other: a.other } : {}) });
  }
  return { decision: 'approve', answers };
}
