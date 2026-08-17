import { describe, it, expect } from 'vitest';
import {
  PANE_ACTIONS_CLUSTER_WIDTH,
  PANE_INJECT_CLUSTER_EXTRA,
  paneClusterWidth,
} from '../SurfaceTabs';

describe('paneClusterWidth', () => {
  it('keeps the historical 116 when only pane actions show', () => {
    expect(paneClusterWidth({ paneActionsVisible: true, showInject: false }))
      .toBe(PANE_ACTIONS_CLUSTER_WIDTH);
  });

  it('adds the inject extra on the focused pane', () => {
    expect(paneClusterWidth({ paneActionsVisible: true, showInject: true }))
      .toBe(PANE_ACTIONS_CLUSTER_WIDTH + PANE_INJECT_CLUSTER_EXTRA);
  });

  it('is inject-only when pane actions are hidden', () => {
    expect(paneClusterWidth({ paneActionsVisible: false, showInject: true })).toBe(83);
  });

  it('is zero when both chrome layers are off', () => {
    expect(paneClusterWidth({ paneActionsVisible: false, showInject: false })).toBe(0);
  });
});
