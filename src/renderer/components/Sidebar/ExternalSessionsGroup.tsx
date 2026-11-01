import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import { selectExternalPlacement } from '../../stores/selectors/externalSessions';
import { IDLE_TICK_MS } from '../../utils/idleTime';
import ExternalSessionRow from './ExternalSessionRow';

/**
 * "Outside wmux": sessions started outside wmux whose folder no workspace
 * holds (placement B, owner-approved 2026-11-01), at the foot of the list
 * after Snoozed and Settled, with their header recipe. Open until the user
 * folds it — or, once folded, while one of them starts needing you; folded,
 * the header counts those in the attention colour (the only rendition then).
 * Empty → nothing is drawn.
 */
export default function ExternalSessionsGroup() {
  const t = useT();
  const sessions = useStore((s) => selectExternalPlacement(s).outside);
  const remembered = useStore((s) => s.externalSessionsGroupOpen);
  const setOpen = useStore((s) => s.setExternalSessionsGroupOpen);
  const listId = useId();
  const needYou = sessions.filter((s) => s.state === 'needs-you').length;
  const open = remembered ?? true;
  // A session that starts needing you unfolds the group again, as a fan-out
  // task needing you re-opens its roster.
  const prevNeedYouRef = useRef(needYou);
  useEffect(() => {
    if (needYou > prevNeedYouRef.current && remembered === false) setOpen(true);
    prevNeedYouRef.current = needYou;
  }, [needYou, remembered, setOpen]);
  const [now, setNow] = useState(() => Date.now());
  const shown = open && sessions.length > 0;
  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), IDLE_TICK_MS);
    return () => clearInterval(id);
  }, [shown]);
  if (sessions.length === 0) return null;
  const needText = needYou > 0
    ? t(needYou === 1 ? 'externalSessions.groupNeedYouOne' : 'externalSessions.groupNeedYou', { count: needYou })
    : undefined;
  return (
    <div className="pt-2 mt-1 border-t" style={{ borderColor: 'var(--stroke)' }} data-external-sessions-group>
      <button
        type="button"
        className={`flex w-full min-h-[24px] items-center gap-1.5 px-1 py-0.5 text-left text-[12px] font-medium text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
        // Group-label case and tracking come from the look (DESIGN.md).
        style={{ textTransform: 'var(--group-case)' as React.CSSProperties['textTransform'], letterSpacing: 'var(--group-track)' }}
        aria-expanded={open}
        aria-controls={listId}
        aria-label={[t('externalSessions.group', { count: sessions.length }), !open ? needText : undefined].filter(Boolean).join(', ')}
        onClick={() => setOpen(!open)}
      >
        <span
          aria-hidden="true"
          className="w-3 h-3 flex-none inline-flex items-center justify-center transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        >
          <IconChevron size={12} />
        </span>
        <span className="min-w-0 truncate">{t('externalSessions.group', { count: sessions.length })}</span>
        {!open && needText && (
          <span className="flex-none tabular-nums text-[var(--attention-text)]" data-external-group-needs-you>
            · {needText}
          </span>
        )}
      </button>
      <div id={listId} className="mt-0.5 space-y-px" hidden={!open}>
        {open && sessions.map((session) => <ExternalSessionRow key={session.id} session={session} now={now} />)}
      </div>
    </div>
  );
}
