import type { Surface } from '../../shared/types';

export type SurfaceAgentNames = Readonly<Record<string, { name: string } | undefined>>;

/** Describe the live local terminal program without changing its launch shell or title. */
export function surfaceForegroundProgram(
  surface: Surface | undefined,
  surfaceAgent: SurfaceAgentNames,
): string | null {
  if (!surface || (surface.surfaceType && surface.surfaceType !== 'terminal')) return null;
  return surfaceAgent[surface.ptyId]?.name || surface.shell || null;
}
