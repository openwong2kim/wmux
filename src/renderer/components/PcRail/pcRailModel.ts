/**
 * PC column — the pure rules behind PcRail.tsx, kept apart so they can be
 * tested without a DOM.
 *
 *   monogram      the 2-letter mark on a host's icon
 *   cyclePc       Alt+Shift+Up/Down (and the roving arrows) over the column
 *   pcBadge       which mark an icon wears: needs-you count, done dot or none
 *   pcIconState   online / offline / needs-repair / insecure / unchecked
 *   pcShortcut*   Alt+Shift+Up/Down/Home → the computer to select
 */
import {
  LOCAL_PC_ID,
  PC_RAIL_SHORTCUTS,
  pcRailHostState,
  type PcId,
  type PcRailAttentionCounts,
  type PcRailHost,
  type PcRailHostState,
  type PcRailShortcutActionId,
} from '../../../shared/pcRail';

/**
 * Two letters from a host label: the initials of its first two words
 * ("office-mac" → "OM", "Studio Mini" → "SM"), or the first two letters of a
 * single word ("studio" → "ST"). Counted in code points, so a Hangul or emoji
 * label is never split mid-character. Empty labels fall back to "?".
 */
export function monogram(label: string): string {
  const words = label.trim().split(/[\s._\-/:@]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0]);
  const letters = words.length > 1 ? [first[0], Array.from(words[1])[0]] : first.slice(0, 2);
  return letters.join('').toLocaleUpperCase();
}

/**
 * The computer after (`+1`) or before (`-1`) the active one, wrapping, with
 * this computer first. An active id that is not in the column (a host removed
 * a moment ago) counts as this computer.
 */
export function cyclePc(hostIds: readonly string[], active: PcId, dir: 1 | -1): PcId {
  const order = [LOCAL_PC_ID, ...hostIds];
  const at = Math.max(0, order.indexOf(active));
  return order[(at + dir + order.length) % order.length];
}

export type PcBadge =
  | { kind: 'none' }
  | { kind: 'needs-you'; count: number }
  | { kind: 'finished' };

/**
 * The mark on one icon. The selected computer shows none: its rows are the
 * evidence, so one event is drawn at most twice. Needs-you wins over finished;
 * zero is never drawn.
 */
export function pcBadge(counts: PcRailAttentionCounts, selected: boolean): PcBadge {
  if (selected) return { kind: 'none' };
  if (counts.needsYou > 0) return { kind: 'needs-you', count: counts.needsYou };
  if (counts.finished > 0) return { kind: 'finished' };
  return { kind: 'none' };
}

/** Badge digits: the rail's own cap. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * How the icon is drawn. `unchecked`: the host reports reachable but no list
 * has come back yet (lastSeenAt null) — never drawn as online, never offline.
 */
export type PcIconState = PcRailHostState | 'unchecked';

export function pcIconState(host: Pick<PcRailHost, 'status' | 'lastSeenAt'>): PcIconState {
  const state = pcRailHostState(host.status);
  if (state === 'online' && host.lastSeenAt === null) return 'unchecked';
  return state;
}

/**
 * The PC rail shortcut a keydown's combo (comboFromEvent's spelling) runs,
 * if any. Read from PC_RAIL_SHORTCUTS until those rows join WMUX_KEYMAP.
 */
export function pcShortcutAction(combo: string | null): PcRailShortcutActionId | undefined {
  if (!combo) return undefined;
  return PC_RAIL_SHORTCUTS.find((s) => s.combo === combo)?.action;
}

/** The computer a PC rail shortcut moves to. */
export function pcShortcutTarget(action: PcRailShortcutActionId, hostIds: readonly string[], active: PcId): PcId {
  if (action === 'thisPc') return LOCAL_PC_ID;
  return cyclePc(hostIds, active, action === 'nextPc' ? 1 : -1);
}
