import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_COLOR_IDS,
  WORKSPACE_COLOR_HEX,
  normalizeWorkspaceColor,
  workspaceColorHex,
} from '../workspaceColors';

describe('workspaceColors', () => {
  it('every id has a hex and every hex is a 6-digit color', () => {
    for (const id of WORKSPACE_COLOR_IDS) {
      expect(WORKSPACE_COLOR_HEX[id]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.keys(WORKSPACE_COLOR_HEX)).toHaveLength(WORKSPACE_COLOR_IDS.length);
  });

  it('normalize accepts known ids', () => {
    for (const id of WORKSPACE_COLOR_IDS) {
      expect(normalizeWorkspaceColor(id)).toBe(id);
    }
  });

  it('normalize drops anything else instead of throwing', () => {
    // A hand-edited session.json, a value from a newer build, or a prototype
    // pollution attempt must all end as "no tag" — never as a rendered value.
    for (const bad of [undefined, null, '', 'chartreuse', '#ff0000', 42, {}, [], 'toString']) {
      expect(normalizeWorkspaceColor(bad)).toBeUndefined();
    }
  });

  it('workspaceColorHex maps id → hex and unknown → undefined', () => {
    expect(workspaceColorHex('blue')).toBe(WORKSPACE_COLOR_HEX.blue);
    expect(workspaceColorHex('nope')).toBeUndefined();
    expect(workspaceColorHex(undefined)).toBeUndefined();
  });
});
