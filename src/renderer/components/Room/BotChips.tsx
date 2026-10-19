// ─── Bot chips ───────────────────────────────────────────────────────────────
//
// One chip per bot: avatar · name · presence dot · queue depth · budget bar, and an
// optional muted secondary word after the name (the HQ strip's workspace).
// The secondary word gives way first; the name is cut only when it alone
// is wider than the dock. The
// presence comes only from what the bot runtime reported; a bot it has not
// reported on is `unknown`, drawn as a hollow ring — never a grey
// "offline". A queue of 0 and an unreported budget draw nothing. The chip
// opens a menu of the runtime's verbs (Wake, Park, Resume, Interrupt),
// sent through the factory bot port. The menu floats beside its chip, level
// with it (chipMenuPlace), portalled out of the strip, so it never covers
// the next chip nor is cut off by the strip's scroll.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { BotPresence } from '../../../shared/bot';
import { FOCUS_RING } from '../focusRing';
import Popover from '../ui/Popover';
import { getFactoryBotPort, type BotAction, type FactoryBotPort, type FactoryBotRow } from './factoryPorts';
import { roleLabel } from './roomFormat';
import BotAvatar from './BotAvatar';

type T = (key: string, vars?: Record<string, string | number>) => string;

export function botPresence(row: FactoryBotRow): BotPresence {
  return row.status?.presence ?? 'unknown';
}

const DOT_CLASS: Record<BotPresence, string> = {
  running: 'bg-[var(--accent)]',
  idle: 'bg-[var(--text-sub)]',
  parked: 'bg-[var(--accent-yellow)]',
  stopped: 'bg-[var(--text-muted)]',
  // A ring, not a fill: not reported is not the same as stopped.
  unknown: 'border border-[var(--text-muted)] bg-transparent',
};

export function PresenceDot({ presence }: { presence: BotPresence }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      data-presence={presence}
      className={`inline-block w-[6px] h-[6px] rounded-full shrink-0 ${DOT_CLASS[presence]}`}
    />
  );
}

/** Which verbs make sense now (the runtime re-checks every one). A bot
 *  parked during its running turn is reported running until the turn ends:
 *  its park is what Resume undoes. */
export function botActionsFor(row: FactoryBotRow): Record<BotAction, boolean> {
  const presence = botPresence(row);
  const parked = presence === 'parked' || !!row.bot.parked;
  return {
    wake: !parked,
    park: !parked,
    resume: parked,
    interrupt: presence === 'running',
  };
}

/** The share of today's turns left, 0..1, or null when not reported. */
export function budgetShare(row: FactoryBotRow): number | null {
  const max = row.bot.budget?.maxTurnsPerDay;
  const left = row.status?.budgetLeft?.turnsDay;
  if (typeof max !== 'number' || max <= 0 || typeof left !== 'number') return null;
  return Math.max(0, Math.min(1, left / max));
}

const ACTIONS: readonly BotAction[] = ['wake', 'park', 'resume', 'interrupt'];

/** The verb menu's size, to place it before it renders (four 32px rows —
 *  `.ui-section-row`'s height — the popover's padding and hairline; its min
 *  width). */
export const CHIP_MENU_SIZE = { width: 160, height: ACTIONS.length * 32 + 14 } as const;
const MENU_GAP = 4;
const MENU_MARGIN = 8;

type Rect = { left: number; right: number; top: number; bottom: number };

/** Where the chip's menu goes, in window coordinates: beside the chip and
 *  level with it — on its left (the dock sits at the window's right edge),
 *  else on its right — so it covers no other chip of the strip; only when
 *  neither side has room, under the chip. Always inside the window. Pure. */
export function chipMenuPlace(anchor: Rect, menu: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number } {
  const maxTop = Math.max(MENU_MARGIN, viewport.height - menu.height - MENU_MARGIN);
  const level = Math.min(Math.max(anchor.top, MENU_MARGIN), maxTop);
  const leftSide = anchor.left - MENU_GAP - menu.width;
  if (leftSide >= MENU_MARGIN) return { left: leftSide, top: level };
  const rightSide = anchor.right + MENU_GAP;
  if (rightSide + menu.width <= viewport.width - MENU_MARGIN) return { left: rightSide, top: level };
  const maxLeft = Math.max(MENU_MARGIN, viewport.width - menu.width - MENU_MARGIN);
  return { left: Math.min(Math.max(anchor.left, MENU_MARGIN), maxLeft), top: Math.min(anchor.bottom + MENU_GAP, maxTop) };
}

/** The menu's verbs that can run now, in order. */
function enabledItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].filter((b) => !b.disabled);
}

function BotChip({ row, port, t, onResult, secondary }: {
  row: FactoryBotRow;
  port: FactoryBotPort;
  t: T;
  onResult: (msg: string | null) => void;
  secondary?: string;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const presence = botPresence(row);
  const queue = row.status?.queueDepth ?? 0;
  const share = budgetShare(row);
  const allowed = botActionsFor(row);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    // Fixed to the window: a resize, or a scroll that moves the chip (one of
    // its containers, or the page), would leave it beside the wrong chip.
    // Other regions scrolling (the room's cards) keep it open.
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target === document || (target instanceof Node && target.contains(buttonRef.current))) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);
  // The menu sits outside the strip (portalled), so keys reach it from the
  // chip: opening moves focus to its first verb that can run now.
  useEffect(() => {
    if (!open) return;
    enabledItems(menuRef.current)[0]?.focus();
  }, [open]);
  const closeToChip = () => { setOpen(false); buttonRef.current?.focus(); };
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      closeToChip();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = enabledItems(menuRef.current);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) {
      const at = chipMenuPlace(r, CHIP_MENU_SIZE, { width: window.innerWidth, height: window.innerHeight });
      setPlace({ position: 'fixed', zIndex: 'var(--z-popover-top)', left: at.left, top: at.top, minWidth: CHIP_MENU_SIZE.width });
    }
    setOpen(true);
  };

  const run = async (action: BotAction) => {
    setOpen(false);
    buttonRef.current?.focus();
    try {
      const r = await port.act(action, row.bot.id);
      onResult(r.ok ? null : t('room.bot.actionFailed', { name: row.bot.name, reason: r.message ?? '' }));
    } catch (err) {
      onResult(t('room.bot.actionFailed', { name: row.bot.name, reason: err instanceof Error ? err.message : String(err) }));
    }
  };

  const presenceWord = t(`room.presence.${presence}`);
  const parts = [row.bot.name, ...(secondary ? [secondary] : []), roleLabel(row.bot.role, t), presenceWord];
  if (queue > 0) parts.push(t('room.bot.queued', { count: queue }));
  if (share !== null) parts.push(t('room.bot.budget', { percent: Math.round(share * 100) }));
  const name = parts.join(', ');

  return (
    <div ref={wrapRef} className="relative min-w-0 max-w-full">
      <button
        ref={buttonRef}
        type="button"
        data-testid="room-bot-chip"
        data-bot-id={row.bot.id}
        data-presence={presence}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        title={row.status?.lastError ? `${name} — ${row.status.lastError.message}` : name}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}
        className={`h-[26px] max-w-full inline-flex items-center gap-1.5 pl-[5px] pr-2 rounded-[var(--chip-radius)] text-[12px] text-[var(--text-main)] ${open ? 'bg-[var(--selection-emphasis)]' : 'bg-[var(--selection)] hover:bg-[var(--selection-hover)]'} ${FOCUS_RING}`}
      >
        <BotAvatar bot={row.bot} size={16} t={t} />
        <span data-bot-name className="min-w-0 truncate">{row.bot.name}</span>
        {secondary && <span data-bot-secondary className="min-w-0 truncate text-[11px] text-[var(--text-muted)]" style={{ flexShrink: 1000 }}>{secondary}</span>}
        <PresenceDot presence={presence} />
        {queue > 0 && <span className="text-[11px] tabular-nums text-[var(--text-sub)]" data-bot-queue>{queue}</span>}
        {share !== null && (
          <span aria-hidden="true" data-bot-budget className="relative shrink-0 w-[20px] h-[3px] rounded-full bg-[var(--line)] overflow-hidden">
            <span className="absolute inset-y-0 left-0 bg-[var(--text-sub)]" style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
        )}
      </button>
      {open && createPortal(
        <Popover ref={menuRef} role="menu" aria-label={row.bot.name} data-testid="room-bot-menu" style={place} onKeyDown={onMenuKey}>
          {ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              data-bot-action={action}
              disabled={!allowed[action] || !port.available}
              onClick={() => void run(action)}
              className={`ui-section-row w-full text-left text-[13px] disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`}
            >
              {t(`room.bot.${action}`)}
            </button>
          ))}
        </Popover>,
        document.body,
      )}
    </div>
  );
}

export function BotChips({ rows, t, port, secondaryOf }: {
  rows: readonly FactoryBotRow[];
  t: T;
  port?: FactoryBotPort;
  /** A muted word after each bot's name (the HQ strip: its workspace). */
  secondaryOf?: (row: FactoryBotRow) => string;
}): React.ReactElement | null {
  const [result, setResult] = useState<string | null>(null);
  if (rows.length === 0) return null;
  const p = port ?? getFactoryBotPort();
  return (
    <div data-testid="room-bot-chips" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('room.bots')}>
        {rows.map((row) => <BotChip key={row.bot.id} row={row} port={p} t={t} onResult={setResult} secondary={secondaryOf?.(row)} />)}
      </div>
      {result && <p role="status" className="text-[11px] text-[var(--accent-red)]">{result}</p>}
    </div>
  );
}
