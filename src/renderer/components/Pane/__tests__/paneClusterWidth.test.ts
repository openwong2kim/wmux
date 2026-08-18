import { describe, it, expect } from 'vitest';
import { PANE_ACTIONS_CLUSTER_WIDTH, paneClusterWidth } from '../SurfaceTabs';

describe('paneClusterWidth', () => {
  it('keeps the historical 116 when pane actions show', () => {
    expect(paneClusterWidth({ paneActionsVisible: true })).toBe(PANE_ACTIONS_CLUSTER_WIDTH);
  });

  it('is zero when the cluster is off', () => {
    expect(paneClusterWidth({ paneActionsVisible: false })).toBe(0);
  });
});
