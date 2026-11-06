import type { PaneLeaf, Surface } from '../../shared/types';
import { splitShownTerminal } from '../components/Pane/surfaceKinds';

export type SurfaceAgentNames = Readonly<Record<string, { name: string } | undefined>>;

export interface SurfaceProgramLiveness {
  agentAliveByPtyId?: Readonly<Record<string, boolean>>;
  commandRunningByPtyId?: Readonly<Record<string, boolean>>;
}

/** A launch shell is not evidence of which program currently owns the terminal. */
export function surfaceForegroundProgram(
  surface: Surface | undefined,
  surfaceAgent: SurfaceAgentNames,
  liveness: SurfaceProgramLiveness = {},
): string | null {
  if (!surface?.ptyId || (surface.surfaceType && surface.surfaceType !== 'terminal')) return null;
  if (liveness.agentAliveByPtyId?.[surface.ptyId] === false
    || liveness.commandRunningByPtyId?.[surface.ptyId] === false) return null;
  return surfaceAgent[surface.ptyId]?.name || null;
}

/** The program in the terminal the pane draws (`splitShownTerminal`), whatever tab has the focus. */
export function paneForegroundProgram(
  pane: PaneLeaf,
  surfaceAgent: SurfaceAgentNames,
  liveness: SurfaceProgramLiveness = {},
): string | null {
  return surfaceForegroundProgram(splitShownTerminal(pane), surfaceAgent, liveness);
}
