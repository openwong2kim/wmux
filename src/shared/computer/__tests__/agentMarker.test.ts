import { describe, expect, it } from 'vitest';
import { AGENT_MARKER_COLORS, agentMarkerColor } from '../agentMarker';

describe('agentMarkerColor', () => {
  it('hands out the palette in order and starts over after the last colour', () => {
    expect(agentMarkerColor(0)).toBe(AGENT_MARKER_COLORS[0]);
    expect(agentMarkerColor(9)).toBe(AGENT_MARKER_COLORS[9]);
    expect(agentMarkerColor(10)).toBe(AGENT_MARKER_COLORS[0]);
  });

  it('keeps ten distinct colours, none of them red', () => {
    expect(new Set(AGENT_MARKER_COLORS).size).toBe(10);
    for (const hex of AGENT_MARKER_COLORS) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      expect(r > 200 && g < 90 && b < 90).toBe(false);
    }
  });
});
