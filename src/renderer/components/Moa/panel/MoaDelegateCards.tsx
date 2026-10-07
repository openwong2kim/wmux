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
import type { MergeEffect, MoaDecision, MoaResolveResult, MoaRuleView } from '../../../../shared/moaDecision';
import type { MoaAskOption } from '../../../../shared/moaAsk';
import Button from '../../ui/Button';
import Switch from '../../ui/Switch';
import { NEEDS_YOU_ROW, NEEDS_YOU_TEXT } from './MoaWaitingOnYou';
import type { MoaDelegateApi } from './moaDelegateData';

type T = (key: string, vars?: Record<string, string | number>) => string;

export type DelegateResolve = MoaDelegateApi['delegateResolve'];

/** The lane predicates, in moaMergeLane.ts's order: each has a plain line. */
export const LANE_PREDICATE_IDS = [
  'head-unchanged',
  'required-checks-green',
  'not-release-pr',
  'not-windows-path',
  'no-needs-windows-verify-label',
  'author-trusted',
  'pr-branch-bound-to-asker',
] as const;

/** The lane objections a decision names (in its reason code or why). */
export function laneFailuresOf(d: Pick<MoaDecision, 'reasonCode' | 'why'>): string[] {
  const text = `${d.reasonCode} ${d.why}`;
  return LANE_PREDICATE_IDS.filter((p) => new RegExp(`(^|[^a-z-])${p}([^a-z-]|$)`).test(text));
}

export const shortHead = (sha: string): string => sha.slice(0, 7);

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

function Suggestion({ label, ruleId, why, t }: { label: string; ruleId?: string; why: string; t: T }) {
  return (
    <div className="mt-1.5 text-[11px] leading-snug text-[var(--text-sub)] break-words" data-moa-delegate-suggestion>
      <span className="text-[var(--text-main)]">{t('moa.delegate.suggests', { answer: label })}</span>
      {ruleId && <span className="font-mono"> · {ruleId}</span>}
      {why && <span> · {why}</span>}
    </div>
  );
}

function QuestionBody({ titleId, question, options, context, suggested, suggestion, busy, onChoose, t }: {
  titleId: string;
  question: string;
  options: MoaAskOption[];
  context?: string;
  suggested?: string;
  suggestion: { ruleId?: string; why: string } | null;
  busy: boolean;
  onChoose: (key: string) => void;
  t: T;
}) {
  const pick = suggested ? options.find((o) => o.key === suggested) : undefined;
  return (
    <>
      <p id={titleId} className="m-0 mt-0.5 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words">{question}</p>
      {context && <p className="m-0 mt-0.5 text-[11px] leading-snug text-[var(--text-sub)] break-words">{context}</p>}
      {pick && suggestion && (
        <>
          <Suggestion label={pick.label} ruleId={suggestion.ruleId} why={suggestion.why} t={t} />
          <Button variant="secondary" size="sm" disabled={busy} className="mt-1.5" data-moa-delegate-accept
            onClick={() => onChoose(pick.key)}>
            {t('moa.delegate.accept')}
          </Button>
        </>
      )}
      <div role="group" aria-labelledby={titleId} className="flex flex-col gap-1.5 mt-2">
        {options.map((o) => (
          <Button key={o.key} variant="secondary" size="sm" disabled={busy} data-moa-delegate-option={o.key}
            title={o.description} onClick={() => onChoose(o.key)}
            className="w-full !h-auto !justify-start !whitespace-normal !py-1.5 text-left break-words">
            {o.label}
          </Button>
        ))}
      </div>
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
  const failures = laneFailuresOf(decision);
  return (
    <>
      <p id={titleId} className="m-0 mt-0.5 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words">
        {t('moa.delegate.mergeTitle', { pr: prNumber })}{' '}
        <code className="font-mono text-[12px] text-[var(--text-sub)]" data-moa-delegate-head>{shortHead(expectHead)}</code>
      </p>
      {context && <p className="m-0 mt-0.5 text-[11px] leading-snug text-[var(--text-sub)] break-words">{context}</p>}
      {failures.length > 0 ? (
        <ul className="m-0 mt-1 pl-4 text-[11px] leading-snug text-[var(--text-sub)]" data-moa-delegate-lane>
          {failures.map((p) => <li key={p} data-lane-failure={p}>{t(`moa.delegate.lane.${p}`)}</li>)}
        </ul>
      ) : decision.why ? (
        <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--text-sub)] break-words" data-moa-delegate-why>{decision.why}</p>
      ) : null}
      {suggestGo && <Suggestion label={t('moa.delegate.approve')} ruleId={suggestGo.ruleId} why={suggestGo.why} t={t} />}
      <div role="group" aria-labelledby={titleId} className="flex flex-wrap items-center gap-1.5 mt-2">
        <Button variant="secondary" size="sm" disabled={busy} data-moa-delegate-approve onClick={() => onAnswer(true)}>
          {t('moa.delegate.approve')}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} data-moa-delegate-decline onClick={() => onAnswer(false)}>
          {t('moa.delegate.decline')}
        </Button>
      </div>
    </>
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
  unreceipted,
  rules,
  autoSet,
  onChanged,
  t,
}: {
  effects: readonly MergeEffect[];
  unreceipted: readonly MergeEffect[];
  rules: readonly MoaRuleView[];
  autoSet: MoaDelegateApi['delegateAutoSet'];
  /** Re-read main's list after a toggle (main is the truth). */
  onChanged?: () => void;
  t: T;
}): React.ReactElement | null {
  if (effects.length === 0 && unreceipted.length === 0 && rules.length === 0) return null;
  return (
    <section data-moa-delegate-activity aria-label={t('moa.delegate.title')} className="px-3 pt-2 pb-1 flex flex-col gap-1">
      {(effects.length > 0 || unreceipted.length > 0) && (
        <ul className="m-0 p-0 list-none flex flex-col gap-1">
          {effects.map((e) => (
            <li key={e.id} data-moa-delegate-effect={e.id} data-status={e.status}
              className="flex items-baseline gap-1.5 rounded-md border border-[var(--line)] px-2 py-1.5 text-[12px] text-[var(--text-sub)]">
              <span className="min-w-0 flex-1 truncate">
                {t('moa.delegate.effectLine', { pr: e.prNumber })}{' '}
                <code className="font-mono text-[11px]">{shortHead(e.expectHead)}</code>
              </span>
              <span className={`shrink-0 ${e.status === 'refused' ? 'text-[var(--accent-red)]' : e.status === 'done' ? 'text-[var(--text-main)]' : ''}`}
                title={e.reason}>
                {t(EFFECT_STATUS_KEY[e.status])}
              </span>
            </li>
          ))}
          {unreceipted.map((e) => (
            <li key={e.id} data-moa-delegate-unreceipted={e.id}
              className="rounded-md border border-[var(--line)] px-2 py-1.5 text-[12px] text-[var(--text-sub)] break-words">
              {t('moa.delegate.unreceipted', { pr: e.prNumber, head: shortHead(e.expectHead) })}
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
              <Switch checked={on} aria-labelledby={labelId} disabled={r.ruleId in pending}
                onCheckedChange={(next) => void toggle(r.ruleId, next)} data-moa-delegate-rule-toggle={r.ruleId} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
