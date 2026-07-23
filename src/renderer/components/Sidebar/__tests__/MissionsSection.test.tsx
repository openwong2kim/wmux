// MissionsSection tests (NB2 wave 2 cycle C).
//
// Vitest runs in node env without jsdom — renderToStaticMarkup reads only zustand's SSR
// snapshot (store state at creation time), so values after setState are not reflected. Core
// display logic (flatten, sort) is extracted to pure function flattenMissions for direct
// verification; empty state (null return → zero space) is pinned via SSR (mission cache is
// empty at creation time).
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import MissionsSection, { flattenMissions } from '../MissionsSection';
import type { WorkTask } from '../../../../shared/workTask';

function mission(over: Partial<WorkTask> & Pick<WorkTask, 'id' | 'title'>): WorkTask {
  const ref = { principalId: 'p', verifiedWorkspaceId: 'parent-a' };
  return {
    status: 'open',
    missionChannelId: `chan-${over.id}`,
    createdAt: 0,
    createdBy: ref,
    owner: ref,
    ...over,
  } as WorkTask;
}

describe('MissionsSection', () => {
  it('renders nothing with empty cache (zero space)', () => {
    // missionsByWorkspace is empty at store creation time, so SSR sees empty state.
    const html = renderToStaticMarkup(createElement(MissionsSection));
    expect(html).toBe('');
  });

  describe('flattenMissions (pure)', () => {
    it('empty map → empty array', () => {
      expect(flattenMissions({})).toEqual([]);
    });

    it('merges missions from multiple parents into one', () => {
      const out = flattenMissions({
        'parent-a': [mission({ id: 'a1', title: 'A' })],
        'parent-b': [mission({ id: 'b1', title: 'B' }), mission({ id: 'b2', title: 'C' })],
      });
      expect(out.map((t) => t.id).sort()).toEqual(['a1', 'b1', 'b2']);
    });

    it('sorts open before closed', () => {
      const out = flattenMissions({
        p: [
          mission({ id: 'closed', title: 'Z', status: 'closed', createdAt: 100 }),
          mission({ id: 'open', title: 'A', status: 'open', createdAt: 1 }),
        ],
      });
      expect(out[0].id).toBe('open');
      expect(out[1].id).toBe('closed');
    });

    it('within same status, newest first (createdAt desc)', () => {
      const out = flattenMissions({
        p: [
          mission({ id: 'older', title: 'O', createdAt: 1 }),
          mission({ id: 'newer', title: 'N', createdAt: 5 }),
        ],
      });
      expect(out.map((t) => t.id)).toEqual(['newer', 'older']);
    });
  });
});
