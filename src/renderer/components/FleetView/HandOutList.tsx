// Fleet's To hand out items (shared/handOut.ts): work nobody has been given
// yet, as cards in the board's first column and rows of the list's quiet
// section. Item text (title, note, folder, who added it) is untrusted:
// rendered as text only.
import { memo } from 'react';
import type { HandOutEntry } from '../../../shared/handOut';
import { displayPath } from '../../utils/displayPath';
import { formatIdle, IDLE_SHOW_AFTER_MS } from '../../utils/idleTime';

type T = (key: string, vars?: Record<string, string | number>) => string;

export const handOutKey = (id: string) => `handout:${id}`;

/** The hollow ring that marks To hand out: no status colour, nobody has it. */
export function HandOutRing() {
  return <span aria-hidden="true" className="inline-block flex-none w-[7px] h-[7px] rounded-full border border-[var(--text-muted)]" />;
}

/** "Added by you · 2d", or "Added by #ceo · wmux co. · 3h". */
export function handOutAddedLine(item: HandOutEntry, now: number, workspaceName: (id: string) => string, t: T): string {
  const age = now - item.createdAt < IDLE_SHOW_AFTER_MS ? t('fleet.handOut.now') : formatIdle(Math.max(0, now - item.createdAt));
  if (item.addedBy.kind === 'owner') return [t('fleet.handOut.addedByYou'), age].join(' · ');
  const who = item.addedBy.name ? `#${item.addedBy.name}` : t('fleet.handOut.aPane');
  return [t('fleet.handOut.addedBy', { name: who }), workspaceName(item.addedBy.workspaceId), age].filter(Boolean).join(' · ');
}

interface HandOutCardProps {
  item: HandOutEntry;
  layout: 'list' | 'board';
  focused: boolean;
  now: number;
  workspaceName: (id: string) => string;
  onFocus: () => void;
  t: T;
}

function HandOutCardImpl({ item, layout, focused, now, workspaceName, onFocus, t }: HandOutCardProps) {
  const folder = displayPath(item.folder);
  const agent = item.agent ?? t('fleet.handOut.anyAgent');
  // The board's cards sit on a fill like the other cards; the list's rows are
  // a fill only on hover and selection.
  const surface = layout === 'board'
    ? 'px-3 py-2.5 rounded-[10px] bg-[var(--selection-subtle)] hover:bg-[var(--selection)] aria-selected:bg-[var(--selection-hover)]'
    : 'px-2 py-[9px] rounded-[8px] hover:bg-[var(--hover-fill)] aria-selected:bg-[var(--selection)]';
  return (
    <button
      type="button"
      role="option"
      aria-selected={focused}
      aria-label={[item.title, folder, agent].join(', ')}
      title={item.note || undefined}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      className={`flex flex-col gap-[3px] w-full min-w-0 text-left outline-none focus-visible:![outline:2px_solid_var(--accent)] focus-visible:![outline-offset:-2px] ${surface}`}
      data-fleet-hand-out={item.id}
      data-fleet-key={handOutKey(item.id)}
    >
      <span className="line-clamp-2 [overflow-wrap:anywhere] text-[13px] leading-[18px] text-[var(--text-main)]">{item.title}</span>
      <span className="flex items-center gap-1.5 min-w-0 text-[11px] leading-[14px]">
        <span className="truncate font-mono text-[var(--text-sub)]" title={item.folder}>{folder}</span>
        <span aria-hidden="true" className="text-[var(--text-muted)]">·</span>
        <span className={`flex-none ${item.agent ? 'text-[var(--text-sub)]' : 'text-[var(--text-muted)]'}`}>{agent}</span>
      </span>
      <span className="truncate text-[11px] leading-[14px] text-[var(--text-muted)]">{handOutAddedLine(item, now, workspaceName, t)}</span>
    </button>
  );
}

export const HandOutCard = memo(HandOutCardImpl);
