// ─── Computer-use colour dots ───────────────────────────────────────────────
//
// An agent that drives other apps is drawn on screen in its own colour (halo,
// name pill, pointer; shared/computer/agentMarker.ts). Its pane carries the
// same colour as an 8px filled dot, on the pane's tab and on its workspace's
// sidebar row, so a marker on screen can be tied to its pane. Identity, not
// state: the one other place the agent palette is used (DESIGN.md › Agent
// identity colours). A pane gets a dot only once it has used computer use.

import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../hooks/useT';
import { useRowStore } from '../../stores/rowStore';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import type { Workspace } from '../../../shared/types';
import { AGENT_MARKER_COLORS } from '../../../shared/computer/agentMarker';
import type { TranslationKey } from '../../i18n/locales/en';

/** Dots a sidebar row draws before it folds the rest into "+N". */
export const ROW_MARKER_DOTS_MAX = 3;

const NONE: readonly string[] = [];

/** The marker colour of each of the workspace's panes that has one, in pane order. */
export function workspaceMarkerColors(
  workspace: Pick<Workspace, 'rootPane' | 'stashedPanes'> | undefined,
  markers: Record<string, string>,
): readonly string[] {
  if (!workspace?.rootPane) return NONE;
  let out: string[] | null = null;
  for (const leaf of getWorkspaceLeafPanes(workspace)) {
    for (const surface of leaf.surfaces) {
      const color = surface.ptyId ? markers[surface.ptyId] : undefined;
      if (color) (out ??= []).push(color);
    }
  }
  return out ?? NONE;
}

/** Spoken names of AGENT_MARKER_COLORS, in palette order, so dots of different agents read differently. */
const COLOR_NAME_KEYS = [
  'computerUse.colorName.orange',
  'computerUse.colorName.blue',
  'computerUse.colorName.violet',
  'computerUse.colorName.pink',
  'computerUse.colorName.teal',
  'computerUse.colorName.yellow',
  'computerUse.colorName.lime',
  'computerUse.colorName.sky',
  'computerUse.colorName.magenta',
  'computerUse.colorName.silver',
] as const satisfies readonly TranslationKey[];

/** One pane's computer-use colour. */
export function ComputerUseDot({ color }: { color: string }) {
  const t = useT();
  const nameKey = COLOR_NAME_KEYS[(AGENT_MARKER_COLORS as readonly string[]).indexOf(color)];
  const label = nameKey ? t('computerUse.markerColorNamed', { name: t(nameKey) }) : t('computerUse.markerColor');
  return (
    <span
      className="inline-block h-2 w-2 flex-none rounded-full"
      style={{ backgroundColor: color }}
      role="img"
      aria-label={label}
      title={label}
      data-computer-use-color={color}
    />
  );
}

/** A sidebar row's dots: one per marked pane, at most three, then "+N". */
export function WorkspaceComputerUseDots({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const colors = useRowStore(useShallow((s) => (
    Object.keys(s.agentMarkers).length === 0
      ? NONE
      : workspaceMarkerColors(s.workspaces.find((w) => w.id === workspaceId), s.agentMarkers)
  )));
  if (colors.length === 0) return null;
  const more = colors.length - ROW_MARKER_DOTS_MAX;
  return (
    <span className="flex flex-none items-center gap-0.5" data-computer-use-dots>
      {colors.slice(0, ROW_MARKER_DOTS_MAX).map((color, i) => <ComputerUseDot key={i} color={color} />)}
      {more > 0 && (
        <span
          className="text-[10px] leading-none tabular-nums text-[var(--text-muted)]"
          role="img"
          aria-label={t('computerUse.markerColorMore', { n: more })}
          title={t('computerUse.markerColorMore', { n: more })}
          data-computer-use-more={more}
        >
          +{more}
        </span>
      )}
    </span>
  );
}
