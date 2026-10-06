// The report card in Moa's chat: when a task Moa delegated finishes, the chat
// shows its title, whether Moa checked the result itself, the agent's own
// report (folded), the changed files when known, and a jump to the agent. The card sits in the
// conversation at the moment the task finished: Moa inserts a synthetic meta
// event there, and draws it through ChatRowRendererContext.
//
// Data: the work link (the same record Fleet's tickets read). Its durable
// `result` when present, else the A2A task's completion evidence from main.
import { useEffect, useState } from 'react';
import type { WorkLink } from '../../../../shared/workLink';
import type { TurnEvent } from '../../../../shared/transcript/turnEvents';
import { resultFromWorkLink, type MoaTaskResult } from '../../../../shared/moaResult';
import Button from '../../ui/Button';
import { renderBrainMarkdown } from '../../Deck/BrainMarkdown';
import type { MoaReport } from './moaChatShape';

const RESULT_EVENT_PREFIX = 'moa-result:';
/** Changed files listed before "+N more". */
const FILES_SHOWN = 5;

export interface MoaTaskResultApi {
  taskResult: (args: { workspaceId: string; taskId: string }) => Promise<{ result: MoaTaskResult | null }>;
}

/** When each done link was first seen done, for links whose report carries
 *  no time of its own. updatedAt only grows, so the first sighting is the
 *  earliest it can say. */
const firstSeenDone = new Map<string, number>();

/**
 * When a done link finished: its stored result's time, else the first time
 * this renderer saw it done. Never `updatedAt` as it is now: main rewrites it
 * on links that are already done (a decision attached, a task state
 * recorded), which would move the result past the turn that closed the job.
 */
export function finishedAt(link: WorkLink): number {
  if (link.result?.at) return link.result.at;
  const seen = firstSeenDone.get(link.id);
  if (seen !== undefined) return seen;
  firstSeenDone.set(link.id, link.updatedAt);
  return link.updatedAt;
}

/** Delegated work that finished, as one synthetic event per task, at the
 *  moment it finished. Only tasks that finished within the loaded
 *  conversation, so an old result never lands in a fresh one. */
export function moaResultEvents(links: readonly WorkLink[], since: number | undefined): TurnEvent[] {
  if (since === undefined) return [];
  return links
    .filter((l) => (l.origin === 'moa' || l.origin === 'moa-auto') && l.state === 'done' && !!l.a2aTaskId)
    .map((l) => ({ link: l, at: finishedAt(l) }))
    .filter(({ at }) => at >= since)
    .map(({ link: l, at }) => ({ id: `${RESULT_EVENT_PREFIX}${l.id}`, kind: 'meta' as const, subtype: 'unknown' as const, label: l.title ?? '', ts: at }));
}

/** The transcript with the result events placed by time (after every event
 *  at or before the moment the task finished). */
export function withResultEvents<E extends { ts?: number }>(events: readonly E[], results: readonly E[]): E[] {
  if (results.length === 0) return events as E[];
  const out = [...events];
  for (const r of [...results].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    let at = out.length;
    while (at > 0 && (out[at - 1].ts ?? 0) > (r.ts ?? 0)) at -= 1;
    out.splice(at, 0, r);
  }
  return out;
}

/** The link a synthetic event stands for, or null for any other row. */
export function resultLinkId(eventId: string): string | null {
  return eventId.startsWith(RESULT_EVENT_PREFIX) ? eventId.slice(RESULT_EVENT_PREFIX.length) : null;
}

/** Real results only: a null may be a transient miss (daemon busy, task log
 *  unavailable), so it is asked again rather than remembered. */
const fetched = new Map<string, MoaTaskResult>();
/** Waits before asking again after an empty answer. */
export const RESULT_RETRY_MS = [3_000, 10_000, 30_000] as const;

function useTaskResult(link: WorkLink, api: MoaTaskResultApi | undefined): MoaTaskResult | null {
  const own = resultFromWorkLink(link);
  const hasOwn = own !== null;
  const taskId = link.a2aTaskId ?? '';
  const [result, setResult] = useState<MoaTaskResult | null>(() => own ?? fetched.get(taskId) ?? null);
  useEffect(() => {
    if (hasOwn || !taskId || !api || fetched.has(taskId)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (attempt: number) => {
      void api.taskResult({ workspaceId: link.owner.workspaceId, taskId }).then((r) => {
        if (!alive) return;
        if (r?.result) {
          fetched.set(taskId, r.result);
          setResult(r.result);
        } else if (attempt < RESULT_RETRY_MS.length) {
          timer = setTimeout(() => ask(attempt + 1), RESULT_RETRY_MS[attempt]);
        }
      }).catch(() => {
        if (alive && attempt < RESULT_RETRY_MS.length) timer = setTimeout(() => ask(attempt + 1), RESULT_RETRY_MS[attempt]);
      });
    };
    ask(0);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // A newer link (a task event moved it) asks again from the start.
  }, [hasOwn, taskId, api, link.owner.workspaceId, link.updatedAt]);
  return own ?? result;
}

/** The agent's display name from its slug ('claude' → 'Claude'). */
const agentName = (slug: string | undefined): string | undefined =>
  slug ? (slug === 'claude' ? 'Claude Code' : slug.charAt(0).toUpperCase() + slug.slice(1)) : undefined;

/** One finished delegation inside a report: what the agent said it did
 *  (its own words, folded), the files it named, and the jump to it. */
function AgentReport({ link, workspace, many, api, onOpen, t }: {
  link: WorkLink;
  workspace: string;
  /** One of several delegations in the report: it names its task and its jump. */
  many: boolean;
  api?: MoaTaskResultApi;
  onOpen?: (workspaceId: string, paneId?: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): React.ReactElement {
  const result = useTaskResult(link, api);
  const files = result?.files ?? [];
  return (
    <div className="mt-1.5" data-moa-result-card={link.id}>
      {many && (
        <p className="m-0 mt-1 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words" data-moa-result-title>
          {link.title || t('moa.panel.untitledTask')}
        </p>
      )}
      {result?.summary && (
        <details className="text-[13px] text-[var(--text-main)]" data-moa-result-details>
          <summary className="cursor-pointer text-[var(--text-sub)]">{t('moa.report.agentReport')}</summary>
          {/* Agent text, rendered as markdown (the renderer emits no raw HTML). */}
          <div className="wmux-moa-report-md mt-1 break-words" data-moa-result-summary>{renderBrainMarkdown(result.summary)}</div>
        </details>
      )}
      {files.length > 0 && (
        <ul className="m-0 mt-1 p-0 list-none font-mono text-[12px] text-[var(--text-sub)]" data-moa-result-files>
          {files.slice(0, FILES_SHOWN).map((f) => <li key={f} className="break-all">{f}</li>)}
          {files.length > FILES_SHOWN && <li>{t('moa.result.moreFiles', { count: files.length - FILES_SHOWN })}</li>}
        </ul>
      )}
      {onOpen && (
        <Button variant="secondary" size="sm" className="mt-2" data-moa-result-open onClick={() => onOpen(link.owner.workspaceId, link.owner.paneId)}>
          {many ? t('moa.report.openIn', { agent: agentName(link.agent) ?? t('moa.report.agent'), workspace }) : t('moa.panel.openPane')}
        </Button>
      )}
    </div>
  );
}

/**
 * The one final report of a job: Moa's own reply (or its summary), what Moa
 * checked itself, and each finished delegation's report. Without a report
 * (a delegation finished but Moa has not closed the work) it is that
 * delegation's card alone, saying Moa has not checked it.
 */
export function MoaReportCard({ report, links, workspaceName, api, onOpen, t }: {
  report?: MoaReport;
  links: readonly WorkLink[];
  workspaceName: (workspaceId: string) => string | undefined;
  api?: MoaTaskResultApi;
  onOpen?: (workspaceId: string, paneId?: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): React.ReactElement {
  const one = links.length === 1 ? links[0] : undefined;
  const title = one?.title || report?.summary;
  const plain = !report?.reply && report?.summary && report.summary !== title ? report.summary : undefined;
  return (
    <div className="my-2 rounded-[10px] px-3 py-2.5 bg-[color-mix(in_srgb,var(--text-main)_5%,transparent)]" data-moa-report>
      <div className="text-[11px] text-[var(--text-sub)] truncate">
        {one ? t('moa.result.done', { workspace: workspaceName(one.owner.workspaceId) || t('moa.panel.closedWorkspace') }) : t('moa.report.done')}
      </div>
      {title && <p className="m-0 mt-0.5 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words" data-moa-report-title>{title}</p>}
      {report?.reply && <div className="wmux-moa-report-md mt-1 text-[13px] text-[var(--text-main)] break-words" data-moa-report-reply>{renderBrainMarkdown(report.reply)}</div>}
      {plain && <p className="m-0 mt-1 text-[13px] leading-snug text-[var(--text-main)] break-words">{plain}</p>}
      <p className="m-0 mt-1 text-[13px] leading-snug text-[var(--text-sub)] break-words" data-moa-report-checked={report?.verification ? 'moa' : 'agent'}>
        {report?.verification ? t('moa.report.checked', { text: report.verification }) : t('moa.report.notChecked')}
      </p>
      {links.map((link) => (
        <AgentReport key={link.id} link={link} many={links.length > 1} api={api} onOpen={onOpen} t={t}
          workspace={workspaceName(link.owner.workspaceId) || t('moa.panel.closedWorkspace')} />
      ))}
    </div>
  );
}
