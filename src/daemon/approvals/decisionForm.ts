// Bounds for a `DecisionForm` a producer hands the registry. The form is
// agent-authored, persisted, and served to phones, so it gets the same limits
// the `/answer` body parser applies to what comes back: a form a phone could
// never answer within those limits is refused rather than stored.

import { boundRecordText } from './terminalPrompt';
import type { DecisionForm } from './types';

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
      const options: Array<{ key: string; label: string }> = [];
      for (const o of q.options) {
        const label = boundRecordText(o?.label, LABEL_MAX);
        if (typeof o?.key !== 'string' || !OPTION_KEY.test(o.key) || keys.has(o.key) || !label) return null;
        keys.add(o.key);
        options.push({ key: o.key, label });
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
