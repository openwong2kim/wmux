import { describe, expect, it } from 'vitest';
import { answersFromReply, formQuestions, replyFromAnswers } from '../questions';
import type { UserQuestion } from '../userQuestion';

const questions: UserQuestion[] = [
  {
    id: 'q0',
    header: 'File',
    prompt: 'Which file?',
    multiSelect: false,
    allowCustom: true,
    options: [
      { id: '1', label: 'a.ts' },
      { id: '2', label: 'b.ts' },
      { id: '__custom__', label: 'Other' },
    ],
  },
  { id: 'q1', prompt: 'Which checks?', multiSelect: true, allowCustom: false, options: [{ id: '1', label: 'lint' }, { id: '2', label: 'test' }] },
];

describe('question key space', () => {
  it('maps transcript questions to form questions with the same ids, keys and order', () => {
    expect(formQuestions(questions)).toEqual([
      { id: 'q0', header: 'File', text: 'Which file?', multiSelect: false, allowOther: true, options: [{ key: '1', label: 'a.ts' }, { key: '2', label: 'b.ts' }] },
      { id: 'q1', text: 'Which checks?', multiSelect: true, allowOther: false, options: [{ key: '1', label: 'lint' }, { key: '2', label: 'test' }] },
    ]);
  });

  it('round-trips a renderer reply through registry answers', () => {
    const reply = { kind: 'answered' as const, answers: { q0: ['__custom__'], q1: ['1', '2'] }, custom: { q0: 'c.ts' } };
    const answers = answersFromReply(questions, reply);
    expect(answers).toEqual([{ keys: [], other: 'c.ts' }, { keys: ['1', '2'] }]);
    expect(replyFromAnswers(questions, answers!)).toEqual({ kind: 'answered', answers: { q1: ['1', '2'] }, custom: { q0: 'c.ts' } });
  });

  it('drops unknown keys and extra picks, and skips when nothing is left', () => {
    expect(replyFromAnswers(questions, [{ keys: ['1', '2'] }, { keys: ['9'] }])).toEqual({ kind: 'answered', answers: { q0: ['1'] } });
    expect(replyFromAnswers(questions, [{ keys: ['9'] }])).toEqual({ kind: 'skipped' });
    expect(replyFromAnswers(questions, undefined)).toEqual({ kind: 'skipped' });
    expect(answersFromReply(questions, { kind: 'skipped' })).toBeNull();
  });
});
