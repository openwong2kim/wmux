import { useEffect, useRef, useState } from 'react';
import type { Block } from '../../../shared/chatv2/session';
import { answersFromReply, type FormAnswers } from '../../../shared/chatv2/questions';
import { isOtherOption, type UserQuestionPrompt, type UserQuestionReply } from '../../../shared/chatv2/userQuestion';
import { CHATV2_ANSWER_ARM_MS } from '../../../shared/chatv2/limits';
import { S } from './strings';
import { toolFamily } from './rows';
import { relativeToCwd } from './format';
import { IconCheck, IconX } from '../icons';

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

/**
 * A command that can destroy data or history: it gets the red wording, and
 * Deny becomes the focused default. A plain pattern list; it never blocks.
 */
const DESTRUCTIVE = /\brm\s+(?:-\w*[rf]|--recursive|--force)|\bgit\s+(?:push\b.*\s(?:-f|--force)\b|reset\s+--hard|clean\s+-\w*f|branch\s+-D)|\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b|\bmkfs\b|\bdd\s+if=|\bchmod\s+-R\b|\bsudo\b|\bkill(?:all)?\s+-9\b|>\s*\/dev\/(?:sd|disk)/i;

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE.test(command);
}

/** What an approval asks, in words, and the command or path it is about. */
export function approvalAsk(block: Block, cwd: string): { title: string; subject: string; destructive: boolean } {
  const tool = block.tool;
  const family = toolFamily(block);
  // A command is shown exactly as it will run; only a file path is shortened to the chat's directory.
  const command = tool?.preview?.command ?? (family === 'command' ? tool?.title : undefined);
  const subject = command ? command.trim() : relativeToCwd((tool?.preview?.path ?? tool?.title ?? block.text ?? '').trim(), cwd);
  const destructive = family === 'command' && isDestructiveCommand(subject);
  const title = family === 'command' ? S.approveCommand : family === 'edit' ? S.approveEdit : S.approveTool(tool?.title?.split(/\s/)[0] || S.approveToolFallback);
  return { title, subject, destructive };
}

/** The answer a decided approval leaves in the transcript, under its tool row: muted, like every receipt. */
export function ApprovalCard({ block }: { block: Block; onAnswer?: Answer }) {
  const decided = block.approval?.decided;
  if (!decided) return null;
  const label = decided === 'allow' ? S.allowed : decided === 'deny' ? S.denied : S.cancelled;
  return (
    <div className="wmux-chatv2-decided" data-decision={decided}>
      {decided !== 'cancelled' && <span aria-hidden>{decided === 'allow' ? <IconCheck size={12} /> : <IconX size={12} />}</span>}
      {label}
    </div>
  );
}

/** Where a keystroke is text being typed: a text field or an editable region. */
function inTextField(element: Element | null): boolean {
  return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || (element instanceof HTMLElement && element.isContentEditable);
}

/** The platform's command key, as the hint names it. */
const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318' : 'Ctrl+';

/**
 * The approval that waits, pinned over the composer so it is on screen
 * wherever the reader scrolled. It says what is asked and shows the command
 * itself; a destructive command reads red and defaults to Deny.
 *
 * Focus moves to the default answer only in the active pane, and only when
 * focus is already in this chat and not in a text field: never out of the
 * composer (empty or not, so the next Space or Enter cannot answer the card)
 * and never from nowhere (a background pane's card would take it). From the
 * card, the composer or the transcript, Esc denies and Cmd/Ctrl+Enter allows,
 * so the card can be answered from the composer; neither key answers while a
 * draft is typed there (Cmd/Ctrl+Enter is its send). A destructive call has
 * no allow key: it takes a click, or Enter on the Allow button. An answer
 * given from inside the card hands focus to the composer, so it never drops
 * out of the chat and the next card can be answered from the keyboard too.
 */
export function PinnedApproval({ block, cwd, active, onAnswer }: { block: Block; cwd: string; active: boolean; onAnswer: Answer }) {
  const approval = block.approval!;
  const armed = useArmed(approval.requestId);
  const [sending, setSending] = useState(false);
  const [answered, setAnswered] = useState(false);
  const allowRef = useRef<HTMLButtonElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const ask = approvalAsk(block, cwd);
  const cardRef = useRef<HTMLDivElement>(null);
  const disabled = !armed || sending;
  const answer = async (decision: 'allow' | 'deny') => {
    // Taken before the answer goes: the decided session can remove this card before the answer resolves.
    const chat = cardRef.current?.closest('.wmux-chatv2');
    const fromCard = !!cardRef.current?.contains(document.activeElement);
    setSending(true);
    try {
      if (!(await onAnswer(approval.requestId, decision))) return;
      // The focused button is gone (or dropped focus to the body while disabled for the
      // send): focus stays in this chat, on its composer. Focus the reader moved elsewhere stays.
      const focused = document.activeElement;
      const dropped = !focused || focused === document.body || !focused.isConnected || !!cardRef.current?.contains(focused);
      if (chat?.isConnected && dropped && (fromCard || active)) chat.querySelector<HTMLTextAreaElement>('.wmux-chatv2-textarea:not(:disabled)')?.focus();
      setAnswered(true);
    } finally { setSending(false); }
  };
  useEffect(() => {
    if (!armed || !active) return;
    const focused = document.activeElement;
    const chat = cardRef.current?.closest('.wmux-chatv2');
    if (!chat || !focused || !chat.contains(focused) || inTextField(focused)) return;
    (ask.destructive ? denyRef : allowRef).current?.focus();
  }, [armed, active, approval.requestId]);
  // The keys work from anywhere in this chat, the composer included: taken before the composer sees them.
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    // 229: a key the IME holds (Safari and some IMEs leave isComposing unset).
    if (disabled || answered || event.isComposing || event.keyCode === 229) return;
    const target = event.target instanceof Element ? event.target : null;
    // From the card, the composer or the transcript only: Esc in the find box closes find.
    if (!target?.closest('[data-chatv2-approval], .wmux-chatv2-composer, .wmux-chatv2-viewport')) return;
    // An open composer menu (⋯ or /), or focus in a menu, a list or the chip row, owns its keys: Esc closes it.
    if (target.closest('[role="menu"], [role="listbox"], .wmux-chatv2-chips, [data-chatv2-folded-chips]')
      || cardRef.current?.closest('.wmux-chatv2')?.querySelector('.wmux-chatv2-composer [aria-expanded="true"]')) return;
    // A draft (typed text, or a file staged in the composer) keeps both keys: Esc and Cmd/Ctrl+Enter are the composer's own there.
    const typing = inTextField(target) && (((target as HTMLInputElement).value ?? target?.textContent ?? '').trim() !== ''
      || !!target?.closest('.wmux-chatv2-composer')?.querySelector('[data-attachment]'));
    if (typing) return;
    const allow = !ask.destructive && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
    const deny = event.key === 'Escape';
    if (!allow && !deny) return;
    event.preventDefault();
    event.stopPropagation();
    void answer(allow ? 'allow' : 'deny');
  };
  useEffect(() => {
    const chat = cardRef.current?.closest('.wmux-chatv2');
    if (!chat) return;
    const listener = (event: Event) => keys.current(event as KeyboardEvent);
    chat.addEventListener('keydown', listener, true);
    return () => chat.removeEventListener('keydown', listener, true);
  }, []);
  if (answered || approval.decided) return null;
  return (
    <div ref={cardRef} className="wmux-chatv2-card" data-pinned role="group" aria-label={ask.title} data-chatv2-approval={approval.requestId} data-destructive={ask.destructive || undefined}>
      <span className="wmux-chatv2-card-title">{ask.title}</span>
      {ask.subject && <pre className="wmux-chatv2-card-subject">{ask.subject}</pre>}
      {ask.destructive && <span className="wmux-chatv2-card-warning">{S.approveDestructive}</span>}
      <div className="wmux-chatv2-card-actions">
        <button ref={allowRef} type="button" className="wmux-chatv2-btn" data-variant={ask.destructive ? 'destructive' : 'primary'} disabled={disabled} onClick={() => void answer('allow')}>{S.allow}</button>
        <button ref={denyRef} type="button" className="wmux-chatv2-btn" disabled={disabled} onClick={() => void answer('deny')}>{S.deny}</button>
        <span className="wmux-chatv2-card-hint">{ask.destructive ? S.approveDenyKeyHint : S.approveKeysHint(MOD_KEY)}</span>
      </div>
    </div>
  );
}

export function QuestionCard({ prompt, onAnswer, enter }: { prompt: UserQuestionPrompt; onAnswer: Answer; enter?: boolean }) {
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
    <div className="wmux-chatv2-card" role="group" aria-label={prompt.title ?? prompt.questions[0]?.prompt} data-chatv2-question={prompt.requestId} data-enter={enter || undefined}>
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

/**
 * What a turn error says, in words: the API's status and message when the
 * text carries them ("API Error: 529 {…}"), else the text itself. The raw text
 * stays one click away.
 */
export function readableError(raw: string): string {
  const text = raw.trim();
  const api = /^API Error:\s*(\d{3})\b\s*([\s\S]*)$/i.exec(text);
  if (!api) return text;
  const status = Number(api[1]);
  let message = '';
  try {
    const body = JSON.parse(api[2]) as { error?: { message?: unknown }; message?: unknown };
    const m = body.error?.message ?? body.message;
    if (typeof m === 'string') message = m;
  } catch { message = api[2].trim(); }
  if (status === 529) return S.errorOverloaded;
  if (status === 429) return S.errorRateLimited;
  if (status === 401 || status === 403) return S.errorAuth;
  if (status >= 500) return S.errorServer(status);
  return message ? `${message} (${status})` : S.errorStatus(status);
}

/** A turn that ended on an error: what happened in words, the raw text behind Details, and Retry for the last one. */
export function ErrorCard({ text, onRetry, enter }: { text: string; onRetry?: () => Promise<boolean>; enter?: boolean }) {
  const readable = readableError(text);
  // One retry per click: the card goes when the new turn starts; a send that did not go offers it again.
  const [retried, setRetried] = useState(false);
  const retry = () => {
    setRetried(true);
    void onRetry?.().then((sent) => { if (!sent) setRetried(false); }, () => setRetried(false));
  };
  return (
    <div className="wmux-chatv2-error" role="alert" data-chatv2-error data-enter={enter || undefined}>
      <span className="wmux-chatv2-glyph" data-state="failed" aria-hidden><IconX size={12} /></span>
      <div className="wmux-chatv2-error-body">
        <span>{readable}</span>
        {readable !== text.trim() && (
          <details className="wmux-chatv2-error-raw">
            <summary>{S.errorDetails}</summary>
            <pre>{text}</pre>
          </details>
        )}
      </div>
      {onRetry && <button type="button" className="wmux-chatv2-btn" data-chatv2-retry disabled={retried} onClick={retry}>{S.retry}</button>}
    </div>
  );
}
