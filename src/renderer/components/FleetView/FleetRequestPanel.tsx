// The top of a Needs you row's detail: what the agent asks (in full) and the
// prompt's choices, or the last error it printed — then the ways to act
// without leaving Fleet. The terminal output sits below it. Agent text is
// untrusted: rendered as text only.
import type { PromptChoice } from './nowDoing';

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface FleetRequestPanelProps {
  kind: 'input' | 'check';
  /** input: the agent's question; check: the last error line, if any. */
  text?: string;
  /** Shown for a `check` with no `text`: the row's status sentence. An
   *  `input` with no `text` shows no ask at all. */
  fallback: string;
  choices: readonly PromptChoice[];
  /** An Approvals row waits on this agent's workspace. */
  onOpenApproval?: () => void;
  /** Message is available (never on a permission prompt). */
  onReply?: () => void;
  onJump: () => void;
  t: T;
}

export default function FleetRequestPanel({ kind, text, fallback, choices, onOpenApproval, onReply, onJump, t }: FleetRequestPanelProps) {
  const heading = kind === 'input' ? t('fleet.request.asks') : t('fleet.request.lastError');
  // "The agent asks" only over a real question. With none (a permission
  // prompt), the prompt's choices and the actions are the whole block; the
  // row above already says it needs you.
  const showAsk = kind === 'check' || !!text;
  return (
    <section className="wmux-fleet-request" data-fleet-request={kind} aria-label={showAsk ? heading : undefined}>
      {showAsk && <h3>{heading}</h3>}
      {showAsk && (
        <p className={`wmux-fleet-request-text${kind === 'check' && text ? ' is-evidence' : ''}`} data-fleet-request-text>
          {text ?? fallback}
        </p>
      )}
      {choices.length > 0 && (
        <ol className="wmux-fleet-request-choices" data-fleet-request-choices aria-label={t('fleet.request.choices')}>
          {choices.map((choice) => (
            <li key={choice.number} data-current={choice.current || undefined}>
              <span aria-hidden="true">{choice.number}.</span> {choice.label}
            </li>
          ))}
        </ol>
      )}
      <div className="wmux-fleet-ticket-actions">
        {onOpenApproval && (
          <button type="button" onClick={onOpenApproval} data-fleet-request-approval>{t('fleet.request.openApproval')}</button>
        )}
        {onReply && <button type="button" onClick={onReply} data-fleet-request-reply>{t('fleet.request.reply')}</button>}
        <button type="button" onClick={onJump} data-fleet-request-jump>{t('fleet.request.jump')}</button>
      </div>
    </section>
  );
}
