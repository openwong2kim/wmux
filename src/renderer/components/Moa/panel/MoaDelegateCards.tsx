// Moa's delegate in the panel — the owner's side.
//
//   MoaDelegateTicketRow  an escalated moa_ask ticket, in Waiting on you: a
//                         question (options, Moa's suggestion with one-click
//                         accept, Not needed) or a merge (PR, short head, the
//                         lane's objections in plain words, Approve / Decline).
//   MoaDelegateActivity   quiet, below: merge status rows, merges main could
//                         not confirm, and the per-rule auto toggles.
//
// Nothing here acts on its own: every press is one owner IPC call. A merge
// approval carries the head this card shows; if the PR moved since, main
// answers `stale` and the card says so instead of merging something unseen.
import { useState } from 'react';
import type { MergeEffect, MoaDecision, MoaResolveResult, MoaRuleView, MoaUnreceiptedMerge } from '../../../../shared/moaDecision';
import type { MoaAskOption } from '../../../../shared/moaAsk';
import { agentSlugToDisplay, isAgentSlug } from '../../../../shared/agentIdentity';
import Button from '../../ui/Button';
import Switch from '../../ui/Switch';
import { NEEDS_YOU_ROW, NEEDS_YOU_TEXT } from './MoaWaitingOnYou';
import type { MoaDelegateApi } from './moaDelegateData';

type T = (key: string, vars?: Record<string, string | number>) => string;

export type DelegateResolve = MoaDelegateApi['delegateResolve'];

/** The lane's refusal codes (moaMergeLane.ts) that have a plain line. A
 * `required-check-<bucket>` code reads as the generic failed-check line. */
export const LANE_REASONS = [
  'head-moved', 'checks-not-on-head', 'checks-truncated', 'no-required-checks', 'required-check-pending',
  'required-check', 'package-manifest', 'dependency-patch', 'build-config', 'changelog', 'ci-config',
  'release-script', 'packaging', 'license', 'files-truncated', 'no-files', 'windows-path',
  'labels-truncated', 'needs-windows-verify', 'no-author', 'external-author', 'cross-repository',
  'no-head-branch', 'branch-not-bound',
] as const;

/**
 * The lane's objections to a merge, as main wrote them: `why` carries
 * "(lane: <reason>, <reason>)" and the reason code is `lane-<first reason>`.
 * Display only; nothing here decides anything.
 */
export function laneReasonsOf(d: Pick<MoaDecision, 'reasonCode' | 'why' | 'lane'>): string[] {
  // The verdict main kept on the decision is the source; the text is for
  // records written before it was kept.
  if (d.lane) return d.lane.reasons;
  const m = /\(lane: ([^)]*)\)/.exec(d.why);
  if (m) return m[1].split(',').map((r) => r.trim()).filter(Boolean);
  return d.reasonCode.startsWith('lane-') ? [d.reasonCode.slice('lane-'.length)] : [];
}

/** A lane reason in plain words; an unknown code is shown as is. */
export function laneReasonText(reason: string, t: T): string {
  const known = (LANE_REASONS as readonly string[]).includes(reason)
    ? reason
    : reason.startsWith('required-check-') ? 'required-check' : null;
  return known ? t(`moa.delegate.lane.${known}`) : reason;
}

/** Effect reasons the merge executor writes that are not lane reasons. */
export const EFFECT_REASONS = [
  'closed', 'merged-other-head', 'attempts-exhausted', 'pr-mismatch', 'read-failed', 'restart-mid-merge',
  'write-failed', 'unknown-state', 'auto-paused', 'auto-mode-off', 'auto-daily-cap', 'blocked',
] as const;

/** Why a merge effect was refused or is unconfirmed, in plain words. The
 *  executor writes a lane reason (`head-moved`, or `<predicate>:<reason>`),
 *  `blocked-<code>` or one of EFFECT_REASONS; anything else is shown as is. */
export function effectReasonText(reason: string, t: T): string {
  const r = reason.includes(':') ? reason.slice(reason.indexOf(':') + 1) : reason;
  const known = r.startsWith('blocked-') ? 'blocked' : r;
  if ((EFFECT_REASONS as readonly string[]).includes(known)) return t(`moa.delegate.effectReason.${known}`);
  return laneReasonText(r, t);
}

export const shortHead = (sha: string): string => sha.slice(0, 7);

/** Escalation codes main writes (moaAskService.ts) that have a plain line. */
export const ESCALATION_REASONS = [
  'shadow', 'suggested', 'auto-paused', 'auto-daily-cap', 'daily-cap', 'judge-failed', 'judge-refused',
  'no-policy-book', 'lane-read-failed', 'internal-error', 'restart-uncertain', 'auto-no-predicate',
  'auto-unknown-rule', 'auto-book-auto-off', 'auto-owner-toggle-off', 'auto-predicate-mismatch', 'book-always-escalate',
] as const;

/**
 * Why Moa sent a ticket to the owner, in the owner's language. Main's `why`
 * is written for the asking agent and in English, so the card never shows it:
 * a known code has its own line, an always-escalate category names its topic,
 * and anything else (a judge's own code) reads as the generic line.
 */
export function escalationReasonText(code: string, t: T): string {
  if ((ESCALATION_REASONS as readonly string[]).includes(code)) return t(`moa.delegate.reason.${code}`);
  if (code.startsWith('always-escalate-')) return t('moa.delegate.reason.always-escalate', { topic: code.slice('always-escalate-'.length) });
  return t('moa.delegate.reason.other');
}

/** What the owner sees of a ticket's asker: its workspace's name, else the agent. */
function eyebrow(d: MoaDecision, workspaceName: (id: string) => string | undefined, t: T): string {
  const ws = workspaceName(d.asker.workspaceId) || t('moa.panel.unknownWorkspace');
  return d.asker.agent ? `${ws} · ${d.asker.agent}` : ws;
}

type Notice = 'stale' | 'error' | null;

export function MoaDelegateTicketRow({
  decision: d,
  resolve,
  onDone,
  workspaceName,
  t,
}: {
  decision: MoaDecision;
  resolve: DelegateResolve;
  /** The row leaves (answered here, or settled elsewhere a moment before). */
  onDone: () => void;
  workspaceName: (id: string) => string | undefined;
  t: T;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const send = async (answer: Parameters<DelegateResolve>[0]['answer']) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    let r: MoaResolveResult;
    try {
      r = await resolve({ decisionId: d.id, answer });
    } catch {
      r = { ok: false, code: 'invalid', message: 'error' };
    }
    if (r.ok || r.code === 'not-open' || r.code === 'unknown') {
      onDone();
      return;
    }
    setBusy(false);
    setNotice(r.code === 'stale' ? 'stale' : 'error');
  };
  const titleId = `moa-delegate-${d.id}`;
  const body = d.body;
  const judge = d.judge;
  return (
    <li data-moa-delegate-ticket={d.id} data-kind={body.type} className={NEEDS_YOU_ROW}>
      <div className={`text-[11px] ${NEEDS_YOU_TEXT} truncate`}>{eyebrow(d, workspaceName, t)}</div>
      {body.type === 'question' ? (
        <QuestionBody
          titleId={titleId}
          question={body.question}
          options={body.options}
          context={body.context}
          suggested={judge?.verdict === 'answer' ? judge.choiceKey : undefined}
          suggestion={judge && judge.verdict !== 'escalate' ? { ruleId: judge.ruleId, why: judge.why } : null}
          decision={d}
          busy={busy}
          onChoose={(choiceKey) => void send({ type: 'choice', choiceKey })}
          t={t}
        />
      ) : (
        <MergeBody
          titleId={titleId}
          decision={d}
          prNumber={body.prNumber}
          expectHead={body.expectHead}
          context={body.context}
          suggestGo={judge?.verdict === 'go' ? { ruleId: judge.ruleId, why: judge.why } : null}
          busy={busy}
          onAnswer={(approve) => void send({ type: 'merge', approve, expectHead: body.expectHead })}
          t={t}
        />
      )}
      {d.reasonCode === 'restart-uncertain' || (d.receipt === 'uncertain' && d.status === 'pending') ? (
        <p className="m-0 mt-1 text-[11px] text-[var(--text-sub)]" data-moa-delegate-restart>{t('moa.delegate.restartUncertain')}</p>
      ) : null}
      <Button variant="ghost" size="sm" disabled={busy} className="mt-1.5" data-moa-delegate-dismiss
        onClick={() => void send({ type: 'dismiss' })}>
        {t('moa.panel.dismiss')}
      </Button>
      {notice && (
        <p role="alert" data-moa-delegate-notice={notice}
          className={`m-0 mt-1.5 text-[11px] ${notice === 'error' ? 'text-[var(--accent-red)]' : 'text-[var(--text-sub)]'}`}>
          {t(notice === 'stale' ? 'moa.delegate.stale' : 'moa.delegate.answerFailed')}
        </p>
      )}
    </li>
  );
}

/** Characters of the agent's own note the card shows. */
export const AGENT_NOTE_MAX = 280;

/** Clip agent text to `max` characters (whitespace runs folded). */
export function clipAgentText(text: string, max = AGENT_NOTE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The asker's own `context`, set apart from everything wmux checked: its own
 * label, a plain left rule (no fill, no colour: colour carries state), muted
 * text, clipped. Nothing in it was verified, and the card never presents it
 * next to Approve as if it were.
 */
function AgentNote({ text, t }: { text: string; t: T }) {
  return (
    <div className="mt-1.5 border-l-2 border-[var(--line)] pl-2" data-moa-delegate-agent-note>
      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-sub)]">{t('moa.delegate.agentNote')}</div>
      <p className="m-0 text-[11px] italic leading-snug text-[var(--text-sub)] break-words line-clamp-3">{clipAgentText(text)}</p>
    </div>
  );
}

/** Why it came to the owner (mapped from the code), and Moa's own reason
 *  when the judge gave one. Lane reasons have their own block. */
function EscalationReason({ decision: d, t }: { decision: MoaDecision; t: T }) {
  const code = d.reasonCode.startsWith('lane-') ? null : d.reasonCode;
  const judgeWhy = d.judge && d.judge.verdict === 'escalate' ? d.judge.why : '';
  if (!code && !judgeWhy) return null;
  return (
    <div className="mt-1 text-[11px] leading-snug text-[var(--text-sub)] break-words" data-moa-delegate-why>
      {code && <p className="m-0" data-moa-delegate-reason={code}>{escalationReasonText(code, t)}</p>}
      {judgeWhy && (
        <p className="m-0" data-moa-delegate-judge-why>
          <span className="text-[var(--text-main)]">{t('moa.delegate.moaReason')}</span> {judgeWhy}
        </p>
      )}
    </div>
  );
}

function Suggestion({ label, ruleId, why, t }: { label: string; ruleId?: string; why: string; t: T }) {
  return (
    <div className="mt-1.5 text-[11px] leading-snug text-[var(--text-sub)] break-words" data-moa-delegate-suggestion>
      <span className="text-[var(--text-main)]">{t('moa.delegate.suggests', { answer: label })}</span>
      {ruleId && <span className="font-mono"> · {ruleId}</span>}
      {why && <span> · {why}</span>}
    </div>
  );
}

function QuestionBody({ titleId, question, options, context, suggested, suggestion, decision, busy, onChoose, t }: {
  titleId: string;
  question: string;
  options: MoaAskOption[];
  context?: string;
  suggested?: string;
  suggestion: { ruleId?: string; why: string } | null;
  decision: MoaDecision;
  busy: boolean;
  onChoose: (key: string) => void;
  t: T;
}) {
  const pick = suggested ? options.find((o) => o.key === suggested) : undefined;
  return (
    <>
      <p id={titleId} className="m-0 mt-0.5 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words">{question}</p>
      {pick && suggestion && (
        <>
          <Suggestion label={pick.label} ruleId={suggestion.ruleId} why={suggestion.why} t={t} />
          <Button variant="secondary" size="sm" disabled={busy} className="mt-1.5" data-moa-delegate-accept
            onClick={() => onChoose(pick.key)}>
            {t('moa.delegate.accept')}
          </Button>
        </>
      )}
      {!(pick && suggestion) && <EscalationReason decision={decision} t={t} />}
      <div role="group" aria-labelledby={titleId} className="flex flex-col gap-1.5 mt-2">
        {options.map((o) => (
          <Button key={o.key} variant="secondary" size="sm" disabled={busy} data-moa-delegate-option={o.key}
            title={o.description} onClick={() => onChoose(o.key)}
            className="w-full !h-auto !justify-start !whitespace-normal !py-1.5 text-left break-words">
            {o.label}
          </Button>
        ))}
      </div>
      {context && <AgentNote text={context} t={t} />}
    </>
  );
}

function MergeBody({ titleId, decision, prNumber, expectHead, context, suggestGo, busy, onAnswer, t }: {
  titleId: string;
  decision: MoaDecision;
  prNumber: number;
  expectHead: string;
  context?: string;
  suggestGo: { ruleId?: string; why: string } | null;
  busy: boolean;
  onAnswer: (approve: boolean) => void;
  t: T;
}) {
  const failures = laneReasonsOf(decision);
  return (
    <>
      <p id={titleId} className="m-0 mt-0.5 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words">
        {t('moa.delegate.mergeTitle', { pr: prNumber })}{' '}
        <code className="font-mono text-[12px] text-[var(--text-sub)]" data-moa-delegate-head>{shortHead(expectHead)}</code>
      </p>
      {failures.length > 0 ? (
        <div className="mt-1" data-moa-delegate-lane-block>
          <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-sub)]">{t('moa.delegate.checkedByWmux')}</div>
          <ul className="m-0 pl-4 text-[11px] leading-snug text-[var(--text-main)]" data-moa-delegate-lane>
            {failures.map((r) => <li key={r} data-lane-failure={r}>{laneReasonText(r, t)}</li>)}
          </ul>
        </div>
      ) : decision.lane?.ok ? (
        <div className="mt-1" data-moa-delegate-lane-block>
          <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-sub)]">{t('moa.delegate.checkedByWmux')}</div>
          <p className="m-0 text-[11px] leading-snug text-[var(--text-main)]" data-moa-delegate-lane-ok>{t('moa.delegate.laneOk')}</p>
        </div>
      ) : null}
      {suggestGo
        ? <Suggestion label={t('moa.delegate.approve')} ruleId={suggestGo.ruleId} why={suggestGo.why} t={t} />
        : <EscalationReason decision={decision} t={t} />}
      <div role="group" aria-labelledby={titleId} className="flex flex-wrap items-center gap-1.5 mt-2">
        <Button variant="secondary" size="sm" disabled={busy} data-moa-delegate-approve onClick={() => onAnswer(true)}>
          {t('moa.delegate.approve')}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} data-moa-delegate-decline onClick={() => onAnswer(false)}>
          {t('moa.delegate.decline')}
        </Button>
      </div>
      {context && <AgentNote text={context} t={t} />}
    </>
  );
}

/** An asker's agent slug as the owner reads it ("Claude Code"). */
export function agentLabel(slug: string, t: T): string {
  if (isAgentSlug(slug)) return agentSlugToDisplay(slug);
  return slug || t('moa.delegate.delivery.theAgent');
}

/** Delivery failure reasons with a plain line; others read as the generic one. */
const DELIVERY_REASONS = ['pane-gone', 'restart', 'timeout', 'agent_changed', 'write_failed'] as const;

/** What the owner answered, in a few words. */
function answerText(d: MoaDecision, t: T): string {
  if (d.status === 'refused') return t('moa.delegate.answer.dismissed');
  if (d.answer && 'choiceKey' in d.answer) {
    const key = d.answer.choiceKey;
    const opt = d.body.type === 'question' ? d.body.options.find((o) => o.key === key) : undefined;
    return opt?.label ?? key;
  }
  return t(d.answer && 'actionVerdict' in d.answer && d.answer.actionVerdict === 'go' ? 'moa.delegate.answer.go' : 'moa.delegate.answer.no-go');
}

/** One answer's way back to the asker: "Delivered to Claude Code". */
export function MoaDelegateDeliveryRow({ decision: d, t }: { decision: MoaDecision; t: T }): React.ReactElement | null {
  const delivery = d.delivery;
  if (!delivery) return null;
  const agent = agentLabel(delivery.agent, t);
  const what = d.body.type === 'question' ? d.body.question : t('moa.delegate.effectLine', { pr: d.body.prNumber });
  const reason = delivery.state === 'failed' && delivery.reason
    ? t(`moa.delegate.deliveryReason.${(DELIVERY_REASONS as readonly string[]).includes(delivery.reason) ? delivery.reason : 'other'}`)
    : null;
  return (
    <li data-moa-delegate-delivery={d.id} data-state={delivery.state}
      className="flex flex-col gap-0.5 rounded-md border border-[var(--line)] px-2 py-1.5 text-[12px] text-[var(--text-sub)]">
      <div className="truncate">{what}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">{answerText(d, t)}</span>
        <span className={`shrink-0 ${delivery.state === 'failed' ? 'text-[var(--accent-red)]' : delivery.state === 'delivered' ? 'text-[var(--text-main)]' : ''}`}>
          {t(`moa.delegate.delivery.${delivery.state}`, { agent })}
        </span>
      </div>
      {reason && <p className="m-0 text-[11px] leading-snug break-words" data-moa-delegate-delivery-reason>{reason}</p>}
    </li>
  );
}

const EFFECT_STATUS_KEY: Record<MergeEffect['status'], string> = {
  pending: 'moa.delegate.effect.pending',
  inFlight: 'moa.delegate.effect.running',
  done: 'moa.delegate.effect.merged',
  refused: 'moa.delegate.effect.refused',
  uncertain: 'moa.delegate.effect.uncertain',
};

export function MoaDelegateActivity({
  effects,
  deliveries = [],
  unreceipted,
  rules,
  autoSet,
  onChanged,
  t,
}: {
  effects: readonly MergeEffect[];
  /** Answers on their way back to the asker (selectDeliveryRows). */
  deliveries?: readonly MoaDecision[];
  /** The lane audit: PRs merged lately with no lane receipt (display only). */
  unreceipted: readonly MoaUnreceiptedMerge[];
  rules: readonly MoaRuleView[];
  autoSet: MoaDelegateApi['delegateAutoSet'];
  /** Re-read main's list after a toggle (main is the truth). */
  onChanged?: () => void;
  t: T;
}): React.ReactElement | null {
  if (effects.length === 0 && deliveries.length === 0 && unreceipted.length === 0 && rules.length === 0) return null;
  return (
    <section data-moa-delegate-activity aria-label={t('moa.delegate.title')} className="px-3 pt-2 pb-1 flex flex-col gap-1">
      {(effects.length > 0 || deliveries.length > 0 || unreceipted.length > 0) && (
        <ul className="m-0 p-0 list-none flex flex-col gap-1">
          {deliveries.map((d) => <MoaDelegateDeliveryRow key={d.id} decision={d} t={t} />)}
          {effects.map((e) => (
            <li key={e.id} data-moa-delegate-effect={e.id} data-status={e.status}
              className="flex flex-col gap-0.5 rounded-md border border-[var(--line)] px-2 py-1.5 text-[12px] text-[var(--text-sub)]">
              <div className="flex items-baseline gap-1.5">
                <span className="min-w-0 flex-1 truncate">
                  {t('moa.delegate.effectLine', { pr: e.prNumber })}{' '}
                  <code className="font-mono text-[11px]">{shortHead(e.expectHead)}</code>
                </span>
                <span className={`shrink-0 ${e.status === 'refused' ? 'text-[var(--accent-red)]' : e.status === 'done' ? 'text-[var(--text-main)]' : ''}`}>
                  {t(EFFECT_STATUS_KEY[e.status])}
                </span>
              </div>
              {e.reason && (e.status === 'refused' || e.status === 'uncertain') && (
                <p className="m-0 text-[11px] leading-snug break-words" data-moa-delegate-effect-reason>{effectReasonText(e.reason, t)}</p>
              )}
            </li>
          ))}
          {unreceipted.map((m) => (
            <li key={`${m.repoKey}#${m.prNumber}`} data-moa-delegate-unreceipted={`${m.repoKey}#${m.prNumber}`}
              className="rounded-md border border-[var(--line)] px-2 py-1.5 text-[12px] text-[var(--text-sub)] break-words">
              {t('moa.delegate.unreceipted', { pr: m.prNumber, title: m.title })}
            </li>
          ))}
        </ul>
      )}
      {rules.length > 0 && <AutoRules rules={rules} autoSet={autoSet} onChanged={onChanged} t={t} />}
    </section>
  );
}

function AutoRules({ rules, autoSet, onChanged, t }: {
  rules: readonly MoaRuleView[];
  autoSet: MoaDelegateApi['delegateAutoSet'];
  onChanged?: () => void;
  t: T;
}) {
  // The owner's press shows at once; main's answer (its stored list) wins.
  const [pending, setPending] = useState<Readonly<Record<string, boolean>>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const toggle = async (ruleId: string, auto: boolean) => {
    setPending((p) => ({ ...p, [ruleId]: auto }));
    setFailed(null);
    let ok = false;
    try { ok = (await autoSet({ ruleId, auto })).ok; } catch { ok = false; }
    setPending((p) => { const n = { ...p }; delete n[ruleId]; return n; });
    if (!ok) setFailed(ruleId);
    onChanged?.();
  };
  return (
    <div data-moa-delegate-rules className="flex flex-col gap-1 pt-1">
      <h3 className="m-0 text-[12px] font-medium text-[var(--text-main)]">{t('moa.delegate.rulesTitle')}</h3>
      <ul className="m-0 p-0 list-none flex flex-col gap-1">
        {rules.map((r) => {
          const on = pending[r.ruleId] ?? r.autoOn;
          const labelId = `moa-delegate-rule-${r.ruleId}`;
          return (
            <li key={r.ruleId} data-moa-delegate-rule={r.ruleId} className="flex items-start gap-2 text-[12px] text-[var(--text-sub)]">
              <div className="min-w-0 flex-1">
                <div id={labelId} className="break-words">
                  <span className="font-mono text-[var(--text-main)]">{r.ruleId}</span> {r.text}
                </div>
                {r.agreement.compared > 0 && (
                  <div className="text-[11px] tabular-nums" data-moa-delegate-agreement>
                    {t('moa.delegate.agreement', { agreed: r.agreement.agreed, compared: r.agreement.compared })}
                  </div>
                )}
                {failed === r.ruleId && (
                  <p role="alert" className="m-0 text-[11px] text-[var(--accent-red)]">{t('moa.delegate.toggleFailed')}</p>
                )}
              </div>
              <Switch checked={on} aria-label={t('moa.delegate.ruleToggle', { rule: r.ruleId })} aria-describedby={labelId} disabled={r.ruleId in pending}
                onCheckedChange={(next) => void toggle(r.ruleId, next)} data-moa-delegate-rule-toggle={r.ruleId} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
