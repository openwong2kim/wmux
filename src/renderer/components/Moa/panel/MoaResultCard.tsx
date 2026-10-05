// A result card in Moa's chat: when a task Moa delegated finishes, the chat
// shows its title, the result summary, how many checks wmux verified, the
// changed files when known, and a jump to the agent. The card sits in the
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

const RESULT_EVENT_PREFIX = 'moa-result:';
/** Changed files listed before "+N more". */
const FILES_SHOWN = 5;

export interface MoaTaskResultApi {
  taskResult: (args: { workspaceId: string; taskId: string }) => Promise<{ result: MoaTaskResult | null }>;
}

/** Delegated work that finished, as one synthetic event per task, at the
 *  moment it finished. Only tasks that finished within the loaded
 *  conversation, so an old result never lands in a fresh one. */
export function moaResultEvents(links: readonly WorkLink[], since: number | undefined): TurnEvent[] {
  if (since === undefined) return [];
  return links
    .filter((l) => (l.origin === 'moa' || l.origin === 'moa-auto') && l.state === 'done' && !!l.a2aTaskId && l.updatedAt >= since)
    .map((l) => ({ id: `${RESULT_EVENT_PREFIX}${l.id}`, kind: 'meta' as const, subtype: 'unknown' as const, label: l.title ?? '', ts: l.updatedAt }));
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

const fetched = new Map<string, MoaTaskResult | null>();

function useTaskResult(link: WorkLink, api: MoaTaskResultApi | undefined): MoaTaskResult | null {
  const own = resultFromWorkLink(link);
  const hasOwn = own !== null;
  const taskId = link.a2aTaskId ?? '';
  const [result, setResult] = useState<MoaTaskResult | null>(() => own ?? fetched.get(taskId) ?? null);
  useEffect(() => {
    if (hasOwn || !taskId || !api || fetched.has(taskId)) return;
    let alive = true;
    void api.taskResult({ workspaceId: link.owner.workspaceId, taskId }).then((r) => {
      fetched.set(taskId, r?.result ?? null);
      if (alive) setResult(r?.result ?? null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [hasOwn, taskId, api, link.owner.workspaceId]);
  return own ?? result;
}

export function MoaResultCard({ link, workspaceName, api, onOpen, t }: {
  link: WorkLink;
  workspaceName?: string;
  api?: MoaTaskResultApi;
  onOpen?: (workspaceId: string, paneId?: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): React.ReactElement {
  const result = useTaskResult(link, api);
  const files = result?.files ?? [];
  return (
    <div className="my-2 rounded-[10px] px-3 py-2.5 bg-[color-mix(in_srgb,var(--text-main)_5%,transparent)]" data-moa-result-card={link.id}>
      <div className="text-[11px] text-[var(--text-sub)] truncate">
        {t('moa.result.done', { workspace: workspaceName || t('moa.panel.unknownWorkspace') })}
      </div>
      <p className="m-0 mt-0.5 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words">{link.title}</p>
      {result?.summary && (
        <p className="m-0 mt-1 text-[13px] leading-snug text-[var(--text-main)] break-words whitespace-pre-wrap" data-moa-result-summary>{result.summary}</p>
      )}
      {result && (
        <p className="m-0 mt-1 text-[11px] tabular-nums text-[var(--text-sub)]" data-moa-result-checks>
          {result.checks > 0 ? t('moa.result.checks', { verified: result.verified, total: result.checks }) : t('moa.result.noChecks')}
        </p>
      )}
      {files.length > 0 && (
        <ul className="m-0 mt-1 p-0 list-none font-mono text-[11px] text-[var(--text-sub)]" data-moa-result-files>
          {files.slice(0, FILES_SHOWN).map((f) => <li key={f} className="break-all">{f}</li>)}
          {files.length > FILES_SHOWN && <li>{t('moa.result.moreFiles', { count: files.length - FILES_SHOWN })}</li>}
        </ul>
      )}
      {onOpen && (
        <Button variant="secondary" size="sm" className="mt-2" data-moa-result-open onClick={() => onOpen(link.owner.workspaceId, link.owner.paneId)}>
          {t('moa.result.open')}
        </Button>
      )}
    </div>
  );
}
