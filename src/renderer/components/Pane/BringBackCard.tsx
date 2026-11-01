// The bring-back card: a tab whose work went on in another agent at (or close
// to) its usage limit, once that limit has reset. Opened from the usage chip
// of either tab. The usage-limit card's popover (placePopover; Escape, an
// outside click or a resize closes it):
//   - who is back, when the limit reset and since when the other agent had it;
//   - what the other agent did: the note wmux writes from that agent's own
//     transcript (utils/handoffNote.ts, bringBackNoteText) with its length;
//   - "Close the <agent> tab after" (off);
//   - Stay in <agent> (ghost: the offer goes, the work stays there) and Bring
//     back to <agent> (primary): the note is typed into the source tab, never
//     sent, and that tab is shown.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { getLocale } from '../../i18n';
import { agentRow } from '../../../shared/agentIdentity';
import { formatResetClock } from '../../../shared/usageLimit';
import { bringBack, bringBackAt, bringBackNote, type BringBackPair } from '../../utils/continueInAgent';
import { bringBackNoteText } from '../../utils/handoffNote';
import { placePopover } from '../AgentToolbar/placePopover';
import Popover, { PopoverSection } from '../ui/Popover';
import Checkbox from '../ui/Checkbox';
import Button from '../ui/Button';
import HandoffNotePreview from './HandoffNotePreview';

export const BRING_BACK_CARD_WIDTH = 320;

export default function BringBackCard({ pair, anchor, triggerRef, onClose }: {
  pair: BringBackPair;
  anchor: { top: number; left: number; right: number; bottom: number };
  triggerRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(260);
  const [note, setNote] = useState<string | null>(null);
  const [closeOther, setCloseOther] = useState(false);
  const sourceSlug = useStore((s) => s.surfaceAgent[pair.source.ptyId]?.slug);
  const otherSlug = useStore((s) => s.surfaceAgent[pair.other.ptyId]?.slug);
  const source = (sourceSlug && agentRow(sourceSlug)?.display) || sourceSlug || pair.source.title || t('surface.terminal');
  const other = (otherSlug && agentRow(otherSlug)?.display) || otherSlug || pair.other.title || t('surface.terminal');

  // Read once on open, so the note previewed is the one typed in. The pair is
  // rebuilt on every render; its two tabs are what matter.
  const pairRef = useRef(pair);
  pairRef.current = pair;
  const otherRef = useRef(other);
  otherRef.current = other;
  const otherPtyId = pair.other.ptyId;
  const sourceId = pair.source.id;
  useEffect(() => {
    let live = true;
    // Unreadable facts still give a note (who and where), so the button never stays off.
    void bringBackNote(pairRef.current).then((n) => { if (live) setNote(n); }, () => { if (live) setNote(bringBackNoteText(otherRef.current, null)); });
    return () => { live = false; };
  }, [otherPtyId, sourceId]);
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight;
    if (h && h !== height) setHeight(h);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || triggerRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, triggerRef]);

  const now = Date.now();
  const locale = getLocale();
  const resetAt = bringBackAt(pair, useStore.getState());
  const pos = placePopover(anchor, { width: BRING_BACK_CARD_WIDTH, height });
  const title = t('usageLimit.backCardTitle', { agent: source });

  return createPortal(
    <Popover
      ref={cardRef}
      padded
      aria-label={title}
      data-bring-back-card
      className="fixed"
      style={{ top: pos.top, left: pos.left, width: BRING_BACK_CARD_WIDTH, zIndex: 'var(--z-popover-top)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <PopoverSection title={title}>
        <p className="text-[12px] text-[var(--text-sub)] tabular-nums" data-bring-back-status>
          {t('usageLimit.backStatus', {
            clock: formatResetClock(resetAt, now, locale),
            agent: other,
            since: formatResetClock(pair.source.handoff.at, now, locale),
          })}
        </p>
      </PopoverSection>
      <PopoverSection title={t('usageLimit.backWhat', { agent: other })} data-testid="bring-back-note">
        {note === null ? (
          <p className="text-[12px] text-[var(--text-muted)]">{t('usageLimit.backReading', { agent: other })}</p>
        ) : (
          <HandoffNotePreview note={note} />
        )}
        <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
          <Checkbox checked={closeOther} onCheckedChange={setCloseOther} data-bring-back-action="close-other" />
          {t('usageLimit.backCloseOther', { agent: other })}
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { useStore.getState().clearSurfaceHandoff(pair.source.id); onClose(); }}
            data-bring-back-action="stay"
          >
            {t('usageLimit.backStay', { agent: other })}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!note}
            onClick={() => {
              if (!note) return;
              void bringBack(pair, note, { closeOther }).catch((err: unknown) => { console.warn('[handoff] bring back failed', err); });
              onClose();
            }}
            data-bring-back-action="bring-back"
          >
            {t('usageLimit.backBring', { agent: source })}
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-[var(--text-muted)]">{t('usageLimit.backFooter', { agent: source })}</p>
      </PopoverSection>
    </Popover>,
    document.body,
  );
}
