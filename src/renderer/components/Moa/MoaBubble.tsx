import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../hooks/useT';
import { TITLEBAR_HEIGHT } from '../Titlebar/Titlebar';
import Button from '../ui/Button';
import type { MoaBubble as MoaBubbleData } from './moaNotice';

export interface MoaBubbleProps {
  bubble: MoaBubbleData;
  /** The titlebar icon the bubble hangs from. */
  anchor: HTMLElement | null;
  reduceMotion: boolean;
  onOpen: () => void;
  /** Later, Escape: collapse to the dot. */
  onLater: () => void;
  /** True while the pointer or focus is inside, so the bubble does not
   *  collapse under the operator. */
  onHold: (hold: boolean) => void;
}

/** Gap between the bubble's right edge and the window's. */
const EDGE = 8;

/**
 * Moa's short notice, hung under its titlebar icon while the right panel is
 * closed: a "Moa · needs you" (or "Moa · done") head, one line, and Open /
 * Later. It never takes focus; the text reaches assistive tech through the
 * titlebar button's polite live region. Escape anywhere collapses it like
 * Later, without consuming the key.
 */
export default function MoaBubble({ bubble, anchor, reduceMotion, onOpen, onLater, onHold }: MoaBubbleProps) {
  const t = useT();
  const [place, setPlace] = useState({ right: EDGE, arrow: 14 });

  useLayoutEffect(() => {
    const measure = () => {
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const fromRight = Math.max(0, window.innerWidth - r.right);
      const right = Math.max(EDGE, fromRight - 4);
      // The arrow points at the icon's centre.
      setPlace({ right, arrow: Math.max(8, fromRight - right + r.width / 2 - 5) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onLater();
    };
    // Capture, and no preventDefault: a terminal that stops propagation still
    // gets its Escape, and the bubble still hears it.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onLater]);

  const waiting = bubble.kind === 'decision';
  const tone = waiting ? 'var(--accent-yellow)' : 'var(--accent-green)';
  const head = waiting ? t('moa.bubble.needsYou') : t('moa.bubble.done');
  const style: CSSProperties = {
    position: 'fixed',
    top: TITLEBAR_HEIGHT + 6,
    right: place.right,
    width: 'max-content',
    maxWidth: 300,
    padding: '10px 12px',
    zIndex: 'var(--z-overlay)' as unknown as number,
    WebkitAppRegion: 'no-drag',
  } as CSSProperties;

  return createPortal(
    <div
      role="group"
      aria-label={head}
      className="ui-popover moa-bubble flex flex-col gap-2 font-sans"
      style={style}
      data-moa-bubble={bubble.kind}
      data-motion={reduceMotion ? 'reduced' : 'full'}
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
      onFocus={() => onHold(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHold(false);
      }}
    >
      <span
        aria-hidden="true"
        className="absolute"
        style={{
          top: -6,
          right: place.arrow,
          width: 10,
          height: 10,
          background: 'var(--bg-base)',
          borderLeft: '1px solid var(--surface-hairline)',
          borderTop: '1px solid var(--surface-hairline)',
          transform: 'rotate(45deg)',
        }}
      />
      <span className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: tone }}>
        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full" style={{ background: tone }} />
        {head}
      </span>
      <span className="text-[13px] leading-[19px] text-[var(--text-main)] line-clamp-2 break-words" data-moa-bubble-line>
        {bubble.line}
      </span>
      <span className="flex gap-1.5">
        <Button variant="primary" size="sm" onClick={onOpen} data-moa-bubble-open>
          {t('moa.bubble.open')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onLater} data-moa-bubble-later>
          {t('moa.bubble.later')}
        </Button>
      </span>
    </div>,
    document.body,
  );
}
