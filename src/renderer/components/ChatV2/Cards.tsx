import { useEffect, useState } from 'react';
import type { Block } from '../../../shared/chatv2/session';
import { answersFromReply, type FormAnswers } from '../../../shared/chatv2/questions';
import { isOtherOption, type UserQuestionPrompt, type UserQuestionReply } from '../../../shared/chatv2/userQuestion';
import { answerArmedAt } from './viewState';
import { S } from './strings';

/** False until `requestedAt + CHATV2_ANSWER_ARM_MS`, so a card that pops up under the pointer is not answered by accident. */
export function useArmed(requestedAt: number): boolean {
  const armedAt = answerArmedAt(requestedAt);
  const [armed, setArmed] = useState(() => Date.now() >= armedAt);
  useEffect(() => {
    const wait = armedAt - Date.now();
    if (wait <= 0) { setArmed(true); return; }
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), wait);
    return () => clearTimeout(timer);
  }, [armedAt]);
  return armed;
}

type Answer = (requestId: string, decision: 'allow' | 'deny', answers?: FormAnswers) => Promise<boolean>;

export function ApprovalCard({ block, onAnswer }: { block: Block; onAnswer: Answer }) {
  const approval = block.approval!;
  const armed = useArmed(approval.requestedAt);
  const [sending, setSending] = useState(false);
  if (approval.decided) {
    const label = approval.decided === 'allow' ? S.allowed : approval.decided === 'deny' ? S.denied : S.cancelled;
    return <div className="wmux-chatv2-decided" data-decision={approval.decided}>{label}</div>;
  }
  const answer = async (decision: 'allow' | 'deny') => {
    setSending(true);
    try { await onAnswer(approval.requestId, decision); } finally { setSending(false); }
  };
  const disabled = !armed || sending;
  return (
    <div className="wmux-chatv2-card" role="group" aria-label={S.approvalTitle} data-chatv2-approval={approval.requestId}>
      <span className="wmux-chatv2-card-title">{S.approvalTitle}</span>
      <div className="wmux-chatv2-card-actions">
        <button type="button" className="wmux-chatv2-btn" data-variant="primary" disabled={disabled} onClick={() => void answer('allow')}>{S.allow}</button>
        <button type="button" className="wmux-chatv2-btn" disabled={disabled} onClick={() => void answer('deny')}>{S.deny}</button>
      </div>
    </div>
  );
}

export function QuestionCard({ prompt, onAnswer }: { prompt: UserQuestionPrompt; onAnswer: Answer }) {
  const armed = useArmed(prompt.requestedAt);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const reply: UserQuestionReply = { kind: 'answered', answers: picked, custom };
  const answers = answersFromReply(prompt.questions, reply) ?? [];
  const complete = prompt.questions.every((_, index) => answers[index] && (answers[index].keys.length > 0 || !!answers[index].other));
  const toggle = (questionId: string, optionId: string, multi: boolean) => {
    setPicked((prev) => {
      const current = prev[questionId] ?? [];
      const next = multi ? (current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId]) : [optionId];
      return { ...prev, [questionId]: next };
    });
  };
  const send = async (decision: 'allow' | 'deny') => {
    setSending(true);
    try { await onAnswer(prompt.requestId, decision, decision === 'allow' ? answers : undefined); } finally { setSending(false); }
  };
  const disabled = !armed || sending;
  return (
    <div className="wmux-chatv2-card" role="group" aria-label={prompt.title ?? prompt.questions[0]?.prompt} data-chatv2-question={prompt.requestId}>
      {prompt.questions.map((question) => (
        <fieldset key={question.id} className="wmux-chatv2-question">
          <legend>{question.header ? <span className="wmux-chatv2-card-title">{question.header}</span> : null}{question.prompt}</legend>
          {question.options.filter((option) => !isOtherOption(option)).map((option) => {
            const checked = (picked[question.id] ?? []).includes(option.id);
            return (
              <label key={option.id} className="wmux-chatv2-option">
                <input
                  type={question.multiSelect ? 'checkbox' : 'radio'}
                  name={`${prompt.requestId}:${question.id}`}
                  checked={checked}
                  onChange={() => toggle(question.id, option.id, question.multiSelect)}
                />
                <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>
              </label>
            );
          })}
          {question.allowCustom && (
            <input
              className="wmux-chatv2-input-line"
              aria-label={S.answerOther}
              placeholder={S.answerOther}
              value={custom[question.id] ?? ''}
              onChange={(event) => setCustom((prev) => ({ ...prev, [question.id]: event.target.value }))}
            />
          )}
        </fieldset>
      ))}
      <div className="wmux-chatv2-card-actions">
        <button type="button" className="wmux-chatv2-btn" data-variant="primary" disabled={disabled || !complete} onClick={() => void send('allow')}>{S.submit}</button>
        <button type="button" className="wmux-chatv2-btn" disabled={disabled} onClick={() => void send('deny')}>{S.skip}</button>
      </div>
    </div>
  );
}
