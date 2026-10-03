import { useEffect, useState } from 'react';
import type { Block } from '../../../shared/chatv2/session';
import { answersFromReply, type FormAnswers } from '../../../shared/chatv2/questions';
import { isOtherOption, type UserQuestionPrompt, type UserQuestionReply } from '../../../shared/chatv2/userQuestion';
import { CHATV2_ANSWER_ARM_MS } from '../../../shared/chatv2/limits';
import { S } from './strings';

// When this renderer first saw each request, by request id. The arm counts
// from here, not from the daemon's stamp, so a clock skew between the two can
// never arm a card early. Bounded: the oldest entries go first.
const firstSeen = new Map<string, number>();
const FIRST_SEEN_MAX = 256;

export function seenAt(requestId: string, now = Date.now()): number {
  let at = firstSeen.get(requestId);
  if (at === undefined) {
    at = now;
    firstSeen.set(requestId, at);
    if (firstSeen.size > FIRST_SEEN_MAX) firstSeen.delete(firstSeen.keys().next().value as string);
  }
  return at;
}

/**
 * False until `CHATV2_ANSWER_ARM_MS` after this renderer first showed the
 * request, so a card that pops up under the pointer is not answered by
 * accident (and never before the registry's own arm).
 */
export function useArmed(requestId: string): boolean {
  const armedAt = seenAt(requestId) + CHATV2_ANSWER_ARM_MS;
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
  const armed = useArmed(approval.requestId);
  const [sending, setSending] = useState(false);
  // Answered here and accepted: shown as decided until the resolved push lands.
  const [answered, setAnswered] = useState<'allow' | 'deny' | null>(null);
  const decided = approval.decided ?? answered;
  if (decided) {
    const label = decided === 'allow' ? S.allowed : decided === 'deny' ? S.denied : S.cancelled;
    return <div className="wmux-chatv2-decided" data-decision={decided}>{label}</div>;
  }
  const answer = async (decision: 'allow' | 'deny') => {
    setSending(true);
    try { if (await onAnswer(approval.requestId, decision)) setAnswered(decision); } finally { setSending(false); }
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
  const armed = useArmed(prompt.requestId);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [answered, setAnswered] = useState(false);
  const reply: UserQuestionReply = { kind: 'answered', answers: picked, custom };
  const answers = answersFromReply(prompt.questions, reply) ?? [];
  const complete = prompt.questions.every((_, index) => answers[index] && (answers[index].keys.length > 0 || !!answers[index].other));
  const toggle = (questionId: string, optionId: string, multi: boolean) => {
    // Single choice: an option and a free-text answer exclude each other.
    if (!multi) setCustom((prev) => ({ ...prev, [questionId]: '' }));
    setPicked((prev) => {
      const current = prev[questionId] ?? [];
      const next = multi ? (current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId]) : [optionId];
      return { ...prev, [questionId]: next };
    });
  };
  const send = async (decision: 'allow' | 'deny') => {
    setSending(true);
    try { if (await onAnswer(prompt.requestId, decision, decision === 'allow' ? answers : undefined)) setAnswered(true); } finally { setSending(false); }
  };
  const disabled = !armed || sending || answered;
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
              onChange={(event) => {
                const value = event.target.value;
                setCustom((prev) => ({ ...prev, [question.id]: value }));
                if (!question.multiSelect && value) setPicked((prev) => ({ ...prev, [question.id]: [] }));
              }}
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
