// Moa's own wmux tool calls drawn by what they did, not as tool rows: a
// hand-off proposed, a decision asked, work completed, tasks fanned out. The
// raw call stays one click away in <details>. These calls are lifted out of
// the transcript's tool rows before the chat groups them, so a pending
// decision or hand-off is never folded into (or hidden with) the activity;
// whether it still waits comes from the same store as Waiting on you.
import type { TurnEvent } from '../../../../shared/transcript/turnEvents';
import type { MoaPendingDecision } from '../../../../shared/moa';

const PURPOSE_PREFIX = 'moa-purpose:';

/** The wmux tools whose calls read as a purpose card. */
export const PURPOSE_TOOLS = {
  'mcp__wmux__moa_propose_handoff': 'handoff',
  'mcp__wmux__deck_ask_decision': 'decision',
  'mcp__wmux__deck_complete_work': 'complete',
  'mcp__wmux__fanout_start': 'fanout',
} as const;
type PurposeKind = (typeof PURPOSE_TOOLS)[keyof typeof PURPOSE_TOOLS];

export interface MoaPurpose {
  kind: PurposeKind;
  /** The call's arguments, parsed when they were recorded whole. */
  input: Record<string, unknown>;
  /** The call's raw arguments and reply, for the details fold. */
  rawInput?: string;
  rawResult?: string;
  ok?: boolean;
  /** The reply's id (a decision's id), when it gave one. */
  resultId?: string;
}

type ToolUse = Extract<TurnEvent, { kind: 'tool_use' }>;
type ToolResult = Extract<TurnEvent, { kind: 'tool_result' }>;

const parse = (s: string | undefined): Record<string, unknown> => {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const inlineOf = (v: unknown): string | undefined =>
  v && typeof v === 'object' && typeof (v as { inline?: unknown }).inline === 'string' ? (v as { inline: string }).inline : undefined;

/**
 * Replace each purpose call with a meta event the chat does not fold, and
 * collect what its card shows. The call's result row stays (with the rest of
 * the tool activity).
 */
export function liftPurposeEvents(events: readonly TurnEvent[]): { events: TurnEvent[]; purposes: Map<string, MoaPurpose> } {
  const purposes = new Map<string, MoaPurpose>();
  const results = new Map<string, ToolResult>();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.toolUseId, e);
  const out = events.map((e): TurnEvent => {
    if (e.kind !== 'tool_use') return e;
    const kind = (PURPOSE_TOOLS as Record<string, PurposeKind | undefined>)[(e as ToolUse).name];
    if (!kind) return e;
    const use = e as ToolUse;
    const rawInput = inlineOf(use.input);
    const result = results.get(use.toolUseId);
    const rawResult = inlineOf(result?.output);
    const reply = parse(rawResult);
    const id = `${PURPOSE_PREFIX}${e.id}`;
    purposes.set(id, {
      kind,
      input: parse(rawInput),
      ...(rawInput ? { rawInput } : {}),
      ...(rawResult ? { rawResult } : {}),
      ...(result ? { ok: result.ok && reply.ok !== false } : {}),
      ...(typeof reply.id === 'string' ? { resultId: reply.id } : {}),
    });
    return { id, kind: 'meta', subtype: 'unknown', label: kind, ...(e.ts !== undefined ? { ts: e.ts } : {}) };
  });
  return { events: out, purposes };
}

export const isPurposeEventId = (id: string): boolean => id.startsWith(PURPOSE_PREFIX);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Still waiting on the operator: the same list Waiting on you shows. */
export function purposeWaits(p: MoaPurpose, decisions: readonly MoaPendingDecision[]): boolean {
  // A call that did not go through raised nothing to wait on.
  if (p.ok === false) return false;
  if (p.kind === 'decision') return !!p.resultId && decisions.some((d) => d.decision.id === p.resultId);
  // By the id the proposal returned: a title can repeat across proposals.
  if (p.kind === 'handoff') return !!p.resultId && decisions.some((d) => d.handoff?.id === p.resultId);
  return false;
}

export function MoaPurposeCard({ purpose, waiting, t }: {
  purpose: MoaPurpose;
  /** Still in Waiting on you (docked above the composer). */
  waiting: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): React.ReactElement {
  const { kind, input } = purpose;
  const failed = purpose.ok === false;
  const title = kind === 'handoff' ? str(input.title) ?? str(input.body)?.split('\n')[0]
    : kind === 'decision' ? str(input.question)
    : kind === 'complete' ? str(input.summary)
    : undefined;
  const detail = kind === 'decision' ? str(input.context) : kind === 'complete' ? str(input.verification) : undefined;
  const tasks = kind === 'fanout' && Array.isArray(input.titles) ? (input.titles as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return (
    <div className="my-1.5 rounded-[10px] px-3 py-2 bg-[color-mix(in_srgb,var(--text-main)_5%,transparent)]" data-moa-purpose={kind}>
      <div className={`text-[11px] ${waiting ? 'text-[var(--accent-yellow)]' : 'text-[var(--text-sub)]'}`}>
        {t(`moa.purpose.${kind}`, { count: tasks.length })}
        {waiting && <> · <span data-moa-purpose-waiting>{t('moa.purpose.waiting')}</span></>}
        {failed && <> · <span className="text-[var(--accent-red)]" data-moa-purpose-failed>{t('moa.purpose.failed')}</span></>}
      </div>
      {title && <p className="m-0 mt-0.5 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words">{title}</p>}
      {detail && <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-sub)] break-words">{detail}</p>}
      {tasks.length > 0 && (
        <ul className="m-0 mt-1 p-0 list-none flex flex-wrap gap-1" data-moa-purpose-tasks>
          {tasks.map((task, i) => (
            <li key={`${i}:${task}`} className="rounded-[6px] px-1.5 py-0.5 text-[11px] bg-[var(--selection)] text-[var(--text-main)] break-words">{task}</li>
          ))}
        </ul>
      )}
      {(purpose.rawInput || purpose.rawResult) && (
        <details className="mt-1 text-[11px] text-[var(--text-sub)]" data-moa-purpose-raw>
          <summary className="cursor-pointer">{t('moa.purpose.raw')}</summary>
          {purpose.rawInput && <pre className="m-0 mt-1 font-mono whitespace-pre-wrap break-all">{purpose.rawInput}</pre>}
          {purpose.rawResult && <pre className="m-0 mt-1 font-mono whitespace-pre-wrap break-all">{purpose.rawResult}</pre>}
        </details>
      )}
    </div>
  );
}
