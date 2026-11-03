// @vitest-environment jsdom
// The open bot stays selected while its folder is collapsed, so the batch
// move acts on it whether or not its row is on screen (DESIGN.md › Bots › Folders).
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useBotFolderSelection, type BotFolderSelection } from '../useBotFolderSelection';

type Row = { c: { kind: 'bot'; removed: boolean; row: { bot: { id: string } } } };
const row = (id: string): Row => ({ c: { kind: 'bot', removed: false, row: { bot: { id } } } });
const section = (id: string, collapsed: boolean, ids: string[]) => ({
  folder: { id, name: id, botIds: ids, collapsed, createdAt: 0 },
  rows: ids.map(row),
});

function run(collapsed: boolean, foldersOn = true): BotFolderSelection {
  let out!: BotFolderSelection;
  function Probe() {
    out = useBotFolderSelection<any>({
      foldersOn,
      searching: false,
      sections: [section('fld-a', collapsed, ['open']), section('fld-b', false, ['b1', 'b2'])] as any,
      unfiled: [],
      openBotId: 'open',
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return out;
}

describe('useBotFolderSelection', () => {
  it('keeps the open bot selected when its folder is collapsed', () => {
    const s = run(true);
    expect(s.order).toEqual(['b1', 'b2']);
    expect(s.selection.has('open')).toBe(true);
    expect(s.selectedIds()).toEqual(['open']);
  });

  it('lists the open bot in screen order when its folder is open', () => {
    const s = run(false);
    expect(s.selectedIds()).toEqual(['open']);
    expect(s.order).toEqual(['open', 'b1', 'b2']);
  });

  it('selects nothing with folders off', () => {
    expect(run(false, false).selection.size).toBe(0);
  });
});
