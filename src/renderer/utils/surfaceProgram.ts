import type { PaneLeaf, Surface } from '../../shared/types';

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

/** Prefer the active terminal; other tab types describe the leaf's first terminal. */
export function paneForegroundProgram(
  pane: PaneLeaf,
  surfaceAgent: SurfaceAgentNames,
  liveness: SurfaceProgramLiveness = {},
): string | null {
  const terminals = pane.surfaces.filter((s) => (s.surfaceType ?? 'terminal') === 'terminal');
  const surface = terminals.find((s) => s.id === pane.activeSurfaceId) ?? terminals[0];
  return surfaceForegroundProgram(surface, surfaceAgent, liveness);
}
