// ─── Moa's weekly retro — one section on Moa's briefing (P3c) ───────────────
//
// Main builds the card once a week from the track record (counts and ids, no
// task text) and hands it over only while Moa is on, and only for Moa's own
// workspace. This presents it: a one-line headline with [Open details] and
// [Dismiss]; the details expand in place. No panel of its own, no control
// beyond those two. Nothing to show ⇒ nothing rendered.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { formatDuration, type RetroCard } from '../../../shared/trackRecord';
import Button from '../ui/Button';

type T = (key: string, vars?: Record<string, string | number>) => string;

interface RetroApi {
  getRetro: (workspaceId: string) => Promise<{ card: RetroCard | null }>;
  dismissRetro: () => Promise<{ ok: boolean }>;
  onChanged: (cb: () => void) => () => void;
}

function defaultApi(): RetroApi | undefined {
  return (window.electronAPI as unknown as { trackRecord?: RetroApi } | undefined)?.trackRecord;
}

/** `{name}`-style fill that tolerates a missing translation. */
function fill(t: T, key: string, fallback: string, vars: Record<string, string | number> = {}): string {
  const raw = t(key, vars);
  const text = raw && raw !== key ? raw : fallback;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function retroHeadline(card: RetroCard, t: T): string {
  const { total, prevTotal } = card.interruptions;
  if (total === 0) return fill(t, 'moa.retro.headlineNone', 'Nothing had to wait on you last week.');
  if (total === 1) return fill(t, 'moa.retro.headlineOne', 'You were asked once last week ({prev} the week before).', { prev: prevTotal });
  return fill(t, 'moa.retro.headline', 'You were asked {count} times last week ({prev} the week before).', { count: total, prev: prevTotal });
}

export function MoaRetroCard({ workspaceId, t, api }: { workspaceId?: string; t: T; api?: RetroApi }): React.ReactElement | null {
  const resolved = api ?? defaultApi();
  const workspaces = useStore((s) => s.workspaces);
  const [card, setCard] = useState<RetroCard | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    if (!resolved || !workspaceId) {
      setCard(null);
      return;
    }
    resolved.getRetro(workspaceId).then((r) => setCard(r?.card ?? null)).catch(() => setCard(null));
  }, [resolved, workspaceId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => resolved?.onChanged(refresh), [resolved, refresh]);

  if (!card || !resolved) return null;

  const nameOf = (id: string): string => workspaces.find((w) => w.id === id)?.name ?? (id === '-' ? '?' : id.slice(0, 12));
  const evidence = 'text-[11px] font-mono text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] leading-relaxed';
  const heading = 'text-[12px] text-[var(--text-main)] mt-2';

  const dismiss = (): void => {
    setCard(null);
    void resolved.dismissRetro().catch(() => refresh());
  };

  return (
    <div data-moa-retro className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-mono uppercase tracking-wider text-[color-mix(in_srgb,var(--text-main)_45%,transparent)] shrink-0">
          {fill(t, 'moa.retro.eyebrow', 'Weekly retro')}
        </span>
        <span className="text-[13px] text-[var(--text-main)] leading-relaxed flex-1 min-w-0">{retroHeadline(card, t)}</span>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <Button variant="secondary" size="sm" aria-expanded={open} onClick={() => setOpen(!open)} data-moa-retro-open>
          {open ? fill(t, 'moa.retro.close', 'Hide details') : fill(t, 'moa.retro.open', 'Open details')}
        </Button>
        <Button variant="ghost" size="sm" onClick={dismiss} data-moa-retro-dismiss>
          {fill(t, 'moa.retro.dismiss', 'Dismiss')}
        </Button>
      </div>
      {open && (
        <div data-moa-retro-details className="mt-2 space-y-1">
          <div className="text-[12px] text-[var(--text-main)]">
            {fill(t, 'moa.retro.interruptions', '{decisions} decisions and {approvals} approvals reached you; {lane} approvals were pressed by rule.', {
              decisions: card.interruptions.decisions,
              approvals: card.interruptions.approvals,
              lane: card.approvalsLane,
            })}
          </div>
          <div className="text-[12px] text-[var(--text-main)]">
            {fill(t, 'moa.retro.delegations', '{count} delegations handed out, {done} done.', { count: card.delegations, done: card.done })}
          </div>
          {(card.missedStalls ?? []).length > 0 && (
            <>
              <div className={heading}>{fill(t, 'moa.retro.missedTitle', 'Missed stalls')}</div>
              {card.missedStalls.map((m) => (
                <div key={`m-${m.ref}`} className={evidence}>
                  {fill(t, m.state === 'blocked' ? 'moa.retro.missedBlocked' : 'moa.retro.missedNeedsYou',
                    m.state === 'blocked' ? '{name} · {agent} · blocked for {duration} ({ref})' : '{name} · {agent} · waited {duration} for you ({ref})',
                    { name: nameOf(m.workspaceId), agent: m.agent, duration: formatDuration(m.ms), ref: m.ref })}
                </div>
              ))}
            </>
          )}
          {(card.repeated ?? []).length > 0 && (
            <>
              <div className={heading}>{fill(t, 'moa.retro.repeatedTitle', 'Repeated questions')}</div>
              {card.repeated.map((r) => (
                <div key={`r-${r.workspaceId}-${r.lastAt}`} className={evidence}>
                  {fill(t, 'moa.retro.repeated', 'A similar question came up {count} times in {name}', { count: r.count, name: nameOf(r.workspaceId) })}
                </div>
              ))}
            </>
          )}
          {(card.slowest ?? []).length > 0 && (
            <>
              <div className={heading}>{fill(t, 'moa.retro.slowestTitle', 'Slowest delegations')}</div>
              {card.slowest.map((s) => (
                <div key={`s-${s.ref}`} className={evidence}>
                  {fill(t, 'moa.retro.slowest', '{name} · {agent} · {duration} to done ({ref})', {
                    name: nameOf(s.workspaceId), agent: s.agent, duration: formatDuration(s.ms), ref: s.ref,
                  })}
                </div>
              ))}
            </>
          )}
          {(card.suggestions ?? []).map((s) => (
            <div key={s} data-moa-retro-suggestion={s} className="text-[12px] text-[var(--text-main)] mt-2">
              {s === 'precedent' && fill(t, 'moa.retro.suggestPrecedent', 'Save the answer as a precedent so Moa can answer it next time.')}
              {s === 'stalls' && fill(t, 'moa.retro.suggestStalls', 'Some work sat for hours with nobody reacting. Keep Moa’s bubbles on so needs-you reaches you as it happens.')}
              {s === 'approvals' && fill(t, 'moa.retro.suggestApprovals', 'Most approvals came to you. Settings › Moa › Press small approvals can take the small ones.')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
