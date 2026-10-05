import { describe, expect, it } from 'vitest';
import { nextRowIndex } from '../sidebarRowKeys';
import { closedGroupLabelKey } from '../SidebarTaskGroup';

describe('nextRowIndex (sidebar row keys)', () => {
  it('steps with the arrows and stops at the ends', () => {
    expect(nextRowIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextRowIndex('ArrowDown', 2, 3)).toBeNull();
    expect(nextRowIndex('ArrowUp', 1, 3)).toBe(0);
    expect(nextRowIndex('ArrowUp', 0, 3)).toBeNull();
  });
  it('jumps with Home and End and ignores other keys', () => {
    expect(nextRowIndex('Home', 2, 3)).toBe(0);
    expect(nextRowIndex('End', 0, 3)).toBe(2);
    expect(nextRowIndex('Enter', 0, 3)).toBeNull();
    expect(nextRowIndex('ArrowDown', -1, 3)).toBeNull();
  });
});

describe('closedGroupLabelKey', () => {
  it('names the group after who asked', () => {
    expect(closedGroupLabelKey(['gui'])).toBe('sidebar.tasks.guiGroup');
    expect(closedGroupLabelKey(['orchestrator', 'orchestrator'])).toBe('sidebar.tasks.orchestratorGroup');
    expect(closedGroupLabelKey(['pane', undefined])).toBe('sidebar.tasks.closedPaneGroup');
    expect(closedGroupLabelKey(['gui', 'pane'])).toBe('sidebar.tasks.otherGroup');
  });
});
