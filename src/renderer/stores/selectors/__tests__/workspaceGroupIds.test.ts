// #3069 — the sidebar's workspace → group map. Ids come from a hand-editable
// session file, so a lookup must never answer with Object's own properties.
import { describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import { selectWorkspaceGroupIds } from '../workspaceProjections';
import type { StoreState } from '../../index';

const state = (workspaces: { id: string; groupId?: string }[]) => ({ workspaces } as unknown as StoreState);

describe('selectWorkspaceGroupIds', () => {
  it('maps grouped workspaces only', () => {
    expect({ ...selectWorkspaceGroupIds(state([{ id: 'a', groupId: 'g1' }, { id: 'b' }])) }).toEqual({ a: 'g1' });
  });

  it('answers nothing for ids that name Object properties', () => {
    const map = selectWorkspaceGroupIds(state([{ id: '__proto__', groupId: 'g1' }, { id: 'a' }]));
    expect(map.constructor).toBeUndefined();
    expect(map.toString).toBeUndefined();
    expect(map['__proto__']).toBe('g1');
  });

  it('is shallow-equal while membership is unchanged', () => {
    const a = selectWorkspaceGroupIds(state([{ id: 'a', groupId: 'g1' }, { id: 'b' }]));
    const b = selectWorkspaceGroupIds(state([{ id: 'a', groupId: 'g1' }, { id: 'b' }]));
    expect(shallow(a, b)).toBe(true);
    expect(shallow(a, selectWorkspaceGroupIds(state([{ id: 'a', groupId: 'g2' }])))).toBe(false);
  });
});
