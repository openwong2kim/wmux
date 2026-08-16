import { createLeafPane, type Pane, type PaneBranch } from './types';

export interface LayoutPreset {
  id: string;
  /** English fallback label. The sidebar + menu renders `t(\`preset.${id}.name\`)`
   *  instead; this raw value is still used by agent-facing persona text. */
  name: string;
  /** English fallback description (see `name`). */
  description: string;
  /** Factory that creates a fresh pane tree each time */
  createRootPane: () => Pane;
}

function createBranchPane(
  direction: 'horizontal' | 'vertical',
  children: Pane[],
  sizes?: number[],
): PaneBranch {
  return {
    id: `pane-${crypto.randomUUID()}`,
    type: 'branch',
    direction,
    children,
    sizes,
  };
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'single',
    name: 'Single Pane',
    description: 'A single terminal pane',
    createRootPane: () => createLeafPane(),
  },
  {
    id: 'hsplit',
    name: 'Horizontal Split',
    description: 'Two panes side by side',
    createRootPane: () =>
      createBranchPane('horizontal', [createLeafPane(), createLeafPane()], [50, 50]),
  },
  {
    id: 'vsplit',
    name: 'Vertical Split',
    description: 'Two panes stacked vertically',
    createRootPane: () =>
      createBranchPane('vertical', [createLeafPane(), createLeafPane()], [50, 50]),
  },
  {
    id: 'three-col',
    name: 'Three Columns',
    description: 'Three panes in a row',
    createRootPane: () =>
      createBranchPane(
        'horizontal',
        [createLeafPane(), createLeafPane(), createLeafPane()],
        [33, 34, 33],
      ),
  },
  {
    id: 'main-side',
    name: 'Main + Sidebar',
    description: 'Large left pane with smaller right pane',
    createRootPane: () =>
      createBranchPane('horizontal', [createLeafPane(), createLeafPane()], [70, 30]),
  },
  {
    id: 'grid-4',
    name: '2x2 Grid',
    description: 'Four panes in a grid',
    createRootPane: () =>
      createBranchPane(
        'vertical',
        [
          createBranchPane('horizontal', [createLeafPane(), createLeafPane()], [50, 50]),
          createBranchPane('horizontal', [createLeafPane(), createLeafPane()], [50, 50]),
        ],
        [50, 50],
      ),
  },
];

export function getPresetById(id: string): LayoutPreset | undefined {
  return LAYOUT_PRESETS.find((p) => p.id === id);
}
