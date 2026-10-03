/**
 * One key space for a question across the transcript, the ApprovalRegistry
 * form and the reply. A driver builds its `question.asked` questions with:
 *   - `UserQuestion.id` = the form question id, `q0`, `q1`, … in order;
 *   - `UserQuestionOption.id` = the form option key, in the same order;
 *   - free text (`allowCustom`) as the form's `allowOther`, answered as
 *     `other` — never as an option. A custom/"Other" option is not listed.
 * The renderer turns its selection into registry answers with
 * `answersFromReply`; the driver turns registry answers back with
 * `replyFromAnswers`. The phone answers with the same keys.
 */
import {
  isCustomSelection,
  isOtherOption,
  type UserQuestion,
  type UserQuestionReply,
} from './userQuestion';

export interface FormQuestion {
  id: string;
  header?: string;
  text: string;
  multiSelect: boolean;
  allowOther: boolean;
  options: Array<{ key: string; label: string }>;
}

export type FormAnswers = Array<{ keys: string[]; other?: string }>;

export function formQuestionId(index: number): string {
  return `q${index}`;
}

/** The registry form questions for a transcript question set (ids `q0…`, option keys = option ids). */
export function formQuestions(questions: readonly UserQuestion[]): FormQuestion[] {
  return questions.map((question, index) => ({
    id: formQuestionId(index),
    ...(question.header ? { header: question.header } : {}),
    text: question.prompt,
    multiSelect: question.multiSelect,
    allowOther: question.allowCustom,
    options: question.options
      .filter((option) => !isOtherOption(option))
      .map((option) => ({ key: option.id, label: option.label })),
  }));
}

/** Registry answers (one entry per question, in order) for a renderer reply. Null = skipped. */
export function answersFromReply(questions: readonly UserQuestion[], reply: UserQuestionReply): FormAnswers | null {
  if (reply.kind === 'skipped') return null;
  return questions.map((question) => {
    const keys = (reply.answers[question.id] ?? []).filter((id) => !isCustomSelection(question, id));
    const other = reply.custom?.[question.id]?.trim();
    return { keys, ...(other && question.allowCustom ? { other } : {}) };
  });
}

/** The reply a driver writes back for registry answers. Unknown keys are dropped. */
export function replyFromAnswers(questions: readonly UserQuestion[], answers: FormAnswers | undefined): UserQuestionReply {
  if (!answers) return { kind: 'skipped' };
  const picked: Record<string, string[]> = {};
  const custom: Record<string, string> = {};
  questions.forEach((question, index) => {
    const answer = answers[index];
    if (!answer) return;
    const known = new Set(question.options.filter((o) => !isOtherOption(o)).map((o) => o.id));
    const keys = answer.keys.filter((key) => known.has(key));
    const chosen = question.multiSelect ? keys : keys.slice(0, 1);
    if (chosen.length) picked[question.id] = chosen;
    const other = answer.other?.trim();
    if (other && question.allowCustom) custom[question.id] = other;
  });
  if (!Object.keys(picked).length && !Object.keys(custom).length) return { kind: 'skipped' };
  return { kind: 'answered', answers: picked, ...(Object.keys(custom).length ? { custom } : {}) };
}
