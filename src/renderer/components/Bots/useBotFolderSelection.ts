// The Bots list's multi-select for moving bots (DESIGN.md › Bots › Folders):
// a set of checked bot ids and the anchor a Shift-click extends from. The open
// conversation is a separate thing and never changes with these. Only live 1:1
// bots are checkable; the set is pruned to the rows on screen.
import { useEffect, useState } from 'react';
import { rangeBetween, type Conversation, type FolderSection } from './botsModel';

export interface BotFolderSelection {
  checked: ReadonlySet<string>;
  anchor: string | null;
  /** The checkable bots in on-screen order: each open folder's rows, then the
   *  unfiled ones. */
  checkOrder: string[];
  /** The checked bots, in on-screen order. */
  checkedIds: () => string[];
  clearChecked: () => void;
  toggleCheck: (botId: string) => void;
  checkRange: (botId: string) => void;
  /** Escape on the rows clears the check marks, unless `blocked` (a menu is
   *  open and takes Escape itself). */
  onEscape: (e: React.KeyboardEvent, blocked: boolean) => void;
}

export function useBotFolderSelection<R extends { c: Conversation }>({ foldersOn, searching, sections, unfiled }: {
  foldersOn: boolean;
  searching: boolean;
  sections: readonly FolderSection<R>[];
  unfiled: readonly R[];
}): BotFolderSelection {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const clearChecked = () => { setChecked(new Set()); setAnchor(null); };
  const checkOrder: string[] = [];
  if (foldersOn) {
    for (const { folder, rows: members } of sections) {
      if (!searching && folder.collapsed) continue;
      for (const r of members) if (r.c.kind === 'bot' && !r.c.removed) checkOrder.push(r.c.row.bot.id);
    }
    for (const r of unfiled) if (r.c.kind === 'bot' && !r.c.removed) checkOrder.push(r.c.row.bot.id);
  }
  const checkOrderKey = checkOrder.join('\n');
  useEffect(() => {
    const live = new Set(checkOrderKey ? checkOrderKey.split('\n') : []);
    setChecked((cur) => {
      if ([...cur].every((id) => live.has(id))) return cur;
      return new Set([...cur].filter((id) => live.has(id)));
    });
    setAnchor((cur) => (cur !== null && live.has(cur) ? cur : null));
  }, [checkOrderKey]);
  const toggleCheck = (botId: string) => {
    setChecked((cur) => {
      const next = new Set(cur);
      if (!next.delete(botId)) next.add(botId);
      return next;
    });
    setAnchor(botId);
  };
  const checkRange = (botId: string) => setChecked(new Set(rangeBetween(checkOrder, anchor, botId)));
  const checkedIds = () => checkOrder.filter((id) => checked.has(id));
  const onEscape = (e: React.KeyboardEvent, blocked: boolean) => {
    if (e.key !== 'Escape' || checked.size === 0 || blocked) return;
    e.preventDefault();
    clearChecked();
  };
  return { checked, anchor, checkOrder, checkedIds, clearChecked, toggleCheck, checkRange, onEscape };
}
