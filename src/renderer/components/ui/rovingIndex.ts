/**
 * Roving-focus step shared by single-choice groups (SegmentedControl, the A2A
 * link dialog's pickers): which index a key moves to from `from`, among the
 * `enabled` indices (ascending). Arrows wrap; Home/End jump to the ends.
 * Returns undefined for keys it does not handle or when nothing is enabled.
 * From a disabled (but selected) index, it steps relative to its position.
 */
export function rovingIndex(key: string, from: number, enabled: readonly number[]): number | undefined {
  if (enabled.length === 0) return undefined;
  const after = enabled.find((i) => i > from) ?? enabled[0];
  const before = [...enabled].reverse().find((i) => i < from) ?? enabled[enabled.length - 1];
  if (key === 'ArrowRight' || key === 'ArrowDown') return after;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return before;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  return undefined;
}
