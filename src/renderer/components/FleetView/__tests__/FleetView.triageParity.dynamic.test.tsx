// @vitest-environment jsdom
//
// fleet.triage and the Fleet overlay are one truth: for the same store, the
// rows the overlay renders and the rows the RPC returns sit in the same
// sections in the same order.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import { buildFleetTriage } from '../../../utils/fleetTriage';
import { ACTIVE_PTY_BY_PANE, seedFleetTriageStore } from '../../../utils/__tests__/fleetTriageFixture';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: () => undefined, dispose: () => undefined },
    metadata: { setLabel: async () => ({ ok: true }) },
  };
  act(() => {
    seedFleetTriageStore(Date.now(), { fleetActiveTab: 'fleet', fleetIdleExpanded: true });
  });
});

afterEach(() => {
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  document.body.innerHTML = '';
});

/** Section → the ACTIVE pty of each rendered card, in DOM order. */
function renderedSections(): Record<string, string[]> {
  const out: Record<string, string[]> = { needsYou: [], running: [], idle: [] };
  let section = '';
  for (const el of container.querySelectorAll<HTMLElement>('[data-fleet-section], [data-fleet-card]')) {
    if (el.dataset.fleetSection) section = el.dataset.fleetSection;
    else out[section].push(el.dataset.ptyId ?? '');
  }
  return out;
}

describe('FleetView ↔ fleet.triage parity', () => {
  it('lists the same panes in the same sections and order', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root.render(React.createElement(FleetView)); });

    const payload = buildFleetTriage(useStore.getState(), { includeIdle: true }, Date.now());
    const cardKeys = (rows: { paneId: string }[]) => rows.map((row) => ACTIVE_PTY_BY_PANE[row.paneId]);
    const expected = {
      needsYou: cardKeys(payload.needsYou),
      running: cardKeys(payload.running),
      idle: cardKeys(payload.idle.rows ?? []),
    };

    expect(expected.needsYou).toHaveLength(3);
    expect(expected.running).toHaveLength(1);
    expect(expected.idle).toHaveLength(2);
    expect(renderedSections()).toEqual(expected);
  });
});
