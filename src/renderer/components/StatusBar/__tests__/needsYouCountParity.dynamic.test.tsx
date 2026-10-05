// @vitest-environment jsdom
// One Needs you count everywhere (owner decision on #1812): the titlebar, the
// rail's Fleet badge and Fleet's Needs you chip show the same number for the
// same store — errors included, as Fleet counts them (#1807). The fixture
// holds two input requests and a remote agent in error, which the titlebar
// used to leave out.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import StatusBar from '../StatusBar';
import SidebarNavigation from '../../Sidebar/SidebarNavigation';
import FleetView from '../../FleetView/FleetView';
import { useStore } from '../../../stores';
import { seedFleetTriageStore } from '../../../utils/__tests__/fleetTriageFixture';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
function mount(el: React.ReactElement): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => { root.render(el); });
  return host;
}

beforeEach(() => {
  // Any bridge call answers with something both callable (an unsubscribe)
  // and awaitable (an empty result).
  const stub = (): unknown => new Proxy(() => undefined, {
    get: (_t, key) => (key === 'then' ? (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve([]).then(ok, ko) : stub()),
    apply: () => stub(),
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  act(() => {
    seedFleetTriageStore(Date.now(), { fleetActiveTab: 'fleet', appRoute: 'workspaces', fleetViewVisible: false });
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount(); });
  document.body.innerHTML = '';
});

const digits = (text: string | null | undefined) => Number((text ?? '').match(/\d+/)?.[0] ?? NaN);

describe('one Needs you count', () => {
  it('titlebar === rail badge === Fleet chip, errors included', () => {
    const titlebar = mount(React.createElement(StatusBar));
    const rail = mount(React.createElement(SidebarNavigation, { compact: true, home: true }));
    const fleet = mount(React.createElement(FleetView));

    const titlebarCount = digits(titlebar.querySelector('[data-statusbar-needs]')?.textContent);
    const railCount = digits(rail.querySelector('[data-fleet-nav-count="needsYou"]')?.textContent);
    const chipCount = digits(fleet.querySelector('button[data-filter="attention"]')?.textContent);

    expect(titlebarCount).toBe(3);
    expect(railCount).toBe(titlebarCount);
    expect(chipCount).toBe(titlebarCount);
  });
});
