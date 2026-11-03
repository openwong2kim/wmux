// The Bots list's multi-select for moving bots (DESIGN.md › Bots › Folders),
// worked like a file picker's: `selection` always holds the open conversation's
// bot (when it is a live 1:1 bot, even if its collapsed folder hides the row); Ctrl/Cmd-click adds or drops others
// and Shift-click takes the range from the anchor, neither opening a chat. Only
// live 1:1 bots can be in it, it is pruned to the rows on screen, and it starts
// over whenever the open conversation changes.
import { useEffect, useState } from 'react';
import { rangeBetween, type Conversation, type FolderSection } from './botsModel';

export interface BotFolderSelection {
  /** Every selected bot: the open bot plus the ones picked with Ctrl/Shift. */
  selection: ReadonlySet<string>;
  /** The selectable bots in on-screen order: each open folder's rows, then the
   *  unfiled ones. */
  order: string[];
  /** The selected bots, in on-screen order. */
  selectedIds: () => string[];
  /** Back to just the open bot. */
  collapse: () => void;
  /** A plain click on a bot row (which opens it): that bot alone, and the anchor. */
  selectOnly: (botId: string) => void;
  /** Ctrl/Cmd-click: add or drop a bot. The open bot stays. */
  toggle: (botId: string) => void;
  /** Shift-click: the range from the anchor (the open bot without one). */
  extendTo: (botId: string) => void;
  /** Escape on the rows collapses a multi-selection, unless `blocked` (a menu
   *  is open and takes Escape itself). */
  onEscape: (e: React.KeyboardEvent, blocked: boolean) => void;
}

interface Picked {
  /** The open bot this was built around; a different open bot voids it. */
  forOpen: string | null;
  /** Bots picked besides the open one. */
  ids: ReadonlySet<string>;
  anchor: string | null;
}

export function useBotFolderSelection<R extends { c: Conversation }>({ foldersOn, searching, sections, unfiled, openBotId }: {
  foldersOn: boolean;
  searching: boolean;
  sections: readonly FolderSection<R>[];
  unfiled: readonly R[];
  /** The open conversation's bot, when it is a live 1:1 bot. */
  openBotId: string | null;
}): BotFolderSelection {
  const [state, setState] = useState<Picked>({ forOpen: null, ids: new Set(), anchor: null });
  const order: string[] = [];
  if (foldersOn) {
    for (const { folder, rows: members } of sections) {
      if (!searching && folder.collapsed) continue;
      for (const r of members) if (r.c.kind === 'bot' && !r.c.removed) order.push(r.c.row.bot.id);
    }
    for (const r of unfiled) if (r.c.kind === 'bot' && !r.c.removed) order.push(r.c.row.bot.id);
  }
  const orderKey = order.join('\n');
  const live = new Set(order);
  const fresh: Picked = { forOpen: openBotId, ids: new Set(), anchor: openBotId };
  const cur = state.forOpen === openBotId ? state : fresh;
  const selection = new Set<string>();
  // The open bot stays selected even while its folder is collapsed (row hidden).
  if (foldersOn && openBotId !== null) selection.add(openBotId);
  for (const id of cur.ids) if (live.has(id)) selection.add(id);
  // Drop ids whose rows left the screen so none comes back stale.
  useEffect(() => {
    const onScreen = new Set(orderKey ? orderKey.split('\n') : []);
    setState((s) => (s.ids.size > 0 && [...s.ids].some((id) => !onScreen.has(id))
      ? { ...s, ids: new Set([...s.ids].filter((id) => onScreen.has(id))) }
      : s));
  }, [orderKey]);
  const base = (s: Picked): Picked => (s.forOpen === openBotId ? s : fresh);
  const collapse = () => setState(fresh);
  const selectOnly = (botId: string) => setState({ forOpen: botId, ids: new Set(), anchor: botId });
  const toggle = (botId: string) => setState((s) => {
    const b = base(s);
    if (botId === openBotId) return { ...b, anchor: botId };
    const ids = new Set(b.ids);
    if (!ids.delete(botId)) ids.add(botId);
    return { ...b, ids, anchor: botId };
  });
  const extendTo = (botId: string) => setState((s) => {
    const b = base(s);
    const from = b.anchor !== null && live.has(b.anchor) ? b.anchor : openBotId;
    const ids = new Set(rangeBetween(order, from, botId));
    if (openBotId !== null) ids.delete(openBotId);
    return { ...b, ids, anchor: from };
  });
  const selectedIds = () => {
    const ids = order.filter((id) => selection.has(id));
    // A hidden open bot is not in `order`; put it first so a batch move includes it.
    return openBotId !== null && !live.has(openBotId) && selection.has(openBotId) ? [openBotId, ...ids] : ids;
  };
  const onEscape = (e: React.KeyboardEvent, blocked: boolean) => {
    if (e.key !== 'Escape' || selection.size < 2 || blocked) return;
    e.preventDefault();
    collapse();
  };
  return { selection, order, selectedIds, collapse, selectOnly, toggle, extendTo, onEscape };
}
