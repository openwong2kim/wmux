// A hand-off Moa proposed, as a "Waiting on you" row. Moa never pastes work
// into another workspace's agent: it proposes, and only this card (a human
// click) delivers. The body is untrusted agent text, shown as plain text only.
// Hand off sends no body (main delivers the one it stored); Edit sends the
// operator's own text. Same needs-you grammar as the other rows.
import { useEffect, useRef, useState } from 'react';
import type { MoaPendingDecision } from '../../../../shared/moa';
import {
  handoffBodyRefusal,
  type MoaHandoffCardInfo,
  type MoaHandoffResolveRequest,
  type MoaHandoffResolveResult,
} from '../../../../shared/moaHandoff';
import Button from '../../ui/Button';
import { NEEDS_YOU_ROW } from './MoaWaitingOnYou';

type T = (key: string, vars?: Record<string, string | number>) => string;

export type HandoffResolve = (req: MoaHandoffResolveRequest) => Promise<MoaHandoffResolveResult>;

export const defaultHandoffResolve: HandoffResolve = async (req) => {
  const fn = window.electronAPI?.deck?.moa?.handoffResolve;
  if (!fn) return { ok: false, code: 'error' };
  return fn(req);
};

/** How long a "delivered: false" note stays on screen before the row leaves. */
export const HANDOFF_NOTE_MS = 4000;

export function MoaHandoffCard({
  item,
  handoff,
  resolve = defaultHandoffResolve,
  onDone,
  t,
}: {
  item: MoaPendingDecision;
  handoff: MoaHandoffCardInfo;
  resolve?: HandoffResolve;
  /** The card is answered (or was answered elsewhere): the row leaves. */
  onDone: () => void;
  t: T;
}): React.ReactElement {
  const { decision } = item;
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(handoff.body);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);

  const send = async (action: 'handoff' | 'cancel', body?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const req: MoaHandoffResolveRequest = { workspaceId: item.workspaceId, id: decision.id, action };
    // Hand off without Edit sends no body key at all: main delivers its own.
    if (body !== undefined) req.body = body;
    let r: MoaHandoffResolveResult;
    try {
      r = await resolve(req);
    } catch {
      r = { ok: false, code: 'error' };
    }
    if (r.ok) {
      if (!r.delivered && r.note) {
        // Main also raises its own notice card; show the note briefly here.
        setNote(r.note);
        noteTimer.current = setTimeout(onDone, HANDOFF_NOTE_MS);
        return;
      }
      onDone();
      return;
    }
    // Answered elsewhere: the row is stale, not failed.
    if (r.code === 'not_pending') { onDone(); return; }
    setBusy(false);
    setError(
      r.code === 'body_empty' || r.code === 'body_too_long'
        ? t(`moa.handoff.refusal.${r.code}`)
        : r.message || t('moa.handoff.failed'),
    );
  };

  const saveAndHandOff = () => {
    const refusal = handoffBodyRefusal(draft);
    if (refusal) { setError(t(`moa.handoff.refusal.${refusal}`)); return; }
    void send('handoff', draft);
  };

  const target = t('moa.handoff.target', {
    agent: handoff.agentName,
    workspace: item.workspaceName || t('moa.panel.unknownWorkspace'),
  });
  const titleId = `moa-handoff-${decision.id}`;
  return (
    <li data-moa-decision={decision.id} data-moa-handoff data-workspace-id={item.workspaceId} className={NEEDS_YOU_ROW}>
      {/* The attention-orange dot marks the state; the words keep the text colour. */}
      <div className="flex items-center gap-1 text-[12px] text-[var(--text-main)] min-w-0">
        <span aria-hidden="true" className="shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--attention)]" />
        <span className="truncate">{t('moa.handoff.eyebrow')}</span>
      </div>
      <p id={titleId} className="m-0 mt-0.5 text-[13px] font-medium leading-snug text-[var(--text-main)] break-words" data-moa-handoff-target>
        {target}
      </p>
      {editing ? (
        <textarea
          data-moa-handoff-edit
          aria-labelledby={titleId}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          rows={6}
          className="mt-1.5 w-full max-h-[200px] resize-y rounded-md border border-[var(--line)] focus:border-[var(--line-strong)] bg-[var(--bg-base)] px-2 py-1.5 text-[12px] leading-snug text-[var(--text-main)] outline-none"
        />
      ) : (
        <div
          data-moa-handoff-body
          className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-[var(--text-sub)]"
        >
          {handoff.body}
        </div>
      )}
      {handoff.askReason && (
        <p className="m-0 mt-1 text-[13px] leading-snug text-[var(--text-sub)]" data-moa-handoff-reason={handoff.askReason}>
          {t(`moa.handoff.reason.${handoff.askReason}`)}
        </p>
      )}
      {handoff.foldsNewlines && (
        <p className="m-0 mt-1 text-[13px] leading-snug text-[var(--text-sub)]" data-moa-handoff-folds>
          {t('moa.handoff.foldsNewlines')}
        </p>
      )}
      {handoff.willQueue && (
        <p className="m-0 mt-1 text-[13px] leading-snug text-[var(--text-sub)]" data-moa-handoff-queue>
          {t('moa.handoff.willQueue', { agent: handoff.agentName })}
        </p>
      )}
      {note ? (
        <p role="status" className="m-0 mt-1.5 text-[13px] text-[var(--text-sub)]" data-moa-handoff-note>{note}</p>
      ) : (
        <div role="group" aria-labelledby={titleId} className="flex flex-wrap gap-1.5 mt-2">
          {editing ? (
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={saveAndHandOff} data-moa-handoff-save>
                {t('moa.handoff.saveAndHandOff')}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setEditing(false); setDraft(handoff.body); setError(null); }} data-moa-handoff-discard>
                {t('moa.handoff.discardEdit')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void send('handoff')} data-moa-handoff-go>
                {t('moa.handoff.handOff')}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)} data-moa-handoff-edit-open>
                {t('moa.handoff.edit')}
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send('cancel')} data-moa-handoff-cancel>
            {t('moa.handoff.cancel')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 mt-1.5 text-[13px] text-[var(--accent-red)]" data-moa-handoff-error>{error}</p>
      )}
    </li>
  );
}
