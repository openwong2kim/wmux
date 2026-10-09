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
  isPcRailFeedStale,
  type PcRailHost,
  type PcRailHostFeed,
  type PcRailHostState,
  type PcRailShortcutActionId,
} from '../../../shared/pcRail';
import { timeAgo } from '../../utils/timeAgo';

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

/** The i18n `t` (passed in, so this module stays DOM- and store-free). */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The host's name plus every state the icon draws, one per line: the
 * tooltip and the accessible description say the same thing.
 */
export function hostSummary(host: PcRailHost, feed: PcRailHostFeed | undefined, t: Translate, now = Date.now()): string[] {
  const lines = [host.label];
  const state = pcIconState(host);
  if (state === 'online') {
    lines.push(t('pcRail.online'));
    if (feed && feed.workspaces.length === 0) lines.push(t('pcRail.noWorkspaces', { name: host.label }));
  } else if (state === 'unchecked') lines.push(t('pcRail.notChecked'));
  else if (state === 'offline') {
    lines.push(host.lastSeenAt !== null ? t('pcRail.offlineLastSeen', { time: clockTime(host.lastSeenAt) }) : t('pcRail.offline'));
  } else if (state === 'needs-repair') lines.push(t('pcRail.needsRepair', { name: host.label }));
  else lines.push(t('pcRail.insecure'));
  if (feed && isPcRailFeedStale(feed) && feed.fetchedAt !== null && state !== 'offline') {
    lines.push(t('pcRail.updatedAgo', { time: timeAgo(feed.fetchedAt, now) }));
  }
  if (host.attention.needsYou > 0) lines.push(t('pcRail.needsYouCount', { count: host.attention.needsYou }));
  if (host.attention.finished > 0) lines.push(t('pcRail.finishedCount', { count: host.attention.finished }));
  // An unreachable host keeps its last-known counts; say how old they are.
  if (state === 'offline' && host.lastSeenAt !== null && (host.attention.needsYou > 0 || host.attention.finished > 0)) {
    lines.push(t('pcRail.asOf', { time: clockTime(host.lastSeenAt) }));
  }
  if (host.muted) lines.push(t('pcRail.muted'));
  if (host.tokenKind === 'operator') lines.push(t('pcRail.operatorToken'));
  return lines;
}

/**
 * What the PC menu says about this computer's access to `host`: view only or
 * can type, and how to take it back. An operator-link host is not a paired
 * device over there, so it gets the operator note instead of the revoke hint.
 */
export function accessLines(host: PcRailHost, t: Translate): string[] {
  const lines: string[] = [];
  if (host.allowInput !== undefined) lines.push(host.allowInput ? t('pcRail.access.canType') : t('pcRail.access.viewOnly'));
  lines.push(host.tokenKind === 'operator'
    ? t('pcRail.operatorTokenHint', { name: host.label })
    : t('pcRail.access.revokeHint', { name: host.label }));
  return lines;
}
