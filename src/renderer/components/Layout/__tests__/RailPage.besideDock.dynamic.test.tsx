// @vitest-environment jsdom
//
// The Git page leaves the dock (Moa) in view beside it: the page is inset off
// the dock's side of the sheet by measuring the dock, so nothing under it is
// reflowed or resized; every other rail page still covers the whole sheet,
// dock included. Focus left in the dock is dropped only when the page covers it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import RailPage, { insetBesideDock } from '../RailPage';

vi.mock('../../Git/GitPage', () => ({ default: () => <div data-stub-git /> }));
vi.mock('../../FleetView/FleetView', () => ({ default: () => <div data-stub-fleet /> }));
vi.mock('../../Schedules/SchedulesView', () => ({ default: () => null }));
vi.mock('../../Remote/RemotePage', () => ({ default: () => null }));

const rect = (left: number, right: number) => ({ left, right, width: right - left, top: 0, bottom: 800, height: 800, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;

describe('insetBesideDock', () => {
  const sheet = rect(50, 1430);
  it('keeps the page off the dock on whichever side it is', () => {
    expect(insetBesideDock(sheet, rect(1110, 1430))).toEqual({ left: 0, right: 320 });
    // Sidebar on the right: the dock is on the left edge.
    expect(insetBesideDock(sheet, rect(50, 370))).toEqual({ left: 320, right: 0 });
    // A file tree past the dock is left uncovered too (it stays inert).
    expect(insetBesideDock(sheet, rect(900, 1220))).toEqual({ left: 0, right: 530 });
  });

  it('no dock, an empty one, or one outside the sheet: no inset', () => {
    expect(insetBesideDock(sheet, null)).toEqual({ left: 0, right: 0 });
    expect(insetBesideDock(sheet, rect(1430, 1430))).toEqual({ left: 0, right: 0 });
    expect(insetBesideDock(sheet, rect(1500, 1800))).toEqual({ left: 0, right: 0 });
  });
});

describe('RailPage beside the dock', () => {
  let host: HTMLDivElement;
  let sheet: HTMLDivElement;
  let dock: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); });
    host = document.createElement('div');
    document.body.appendChild(host);
    // The sheet: the dock region and (inside the sheet) the rail page.
    const region = document.createElement('div');
    region.setAttribute('data-dock-region', '');
    dock = document.createElement('div');
    dock.className = 'wmux-dock';
    dock.tabIndex = 0;
    dock.getBoundingClientRect = () => rect(1110, 1430);
    region.appendChild(dock);
    sheet = document.createElement('div');
    sheet.getBoundingClientRect = () => rect(50, 1430);
    host.append(region, sheet);
    root = createRoot(sheet);
    act(() => useStore.setState({ appRoute: 'workspaces', inspectModeActive: false }));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const page = () => sheet.querySelector<HTMLElement>('.wmux-page');

  it('the Git page ends at the dock; Fleet covers the whole sheet; switching never touches the sheet or the dock', () => {
    act(() => root.render(<RailPage />));
    act(() => useStore.setState({ appRoute: 'git' }));
    expect(page()?.style.right).toBe('320px');
    expect(page()?.style.left).toBe('0px');
    expect(page()?.getAttribute('data-beside-dock')).toBe('true');
    act(() => useStore.setState({ appRoute: 'fleet' }));
    expect(page()?.style.right).toBe('');
    expect(page()?.getAttribute('data-beside-dock')).toBeNull();
    act(() => useStore.setState({ appRoute: 'git' }));
    expect(page()?.style.right).toBe('320px');
    act(() => useStore.setState({ appRoute: 'workspaces' }));
    expect(page()).toBeNull();
    // Only the page is styled: no rail page sizes the sheet or the dock.
    expect(sheet.getAttribute('style')).toBeNull();
    expect(dock.getAttribute('style')).toBeNull();
  });

  it('measures from inside the sheet\'s border, so the page meets the dock with no sliver between', () => {
    // The page's offsets start inside the border: 1px of it would leave 1px
    // of the panes showing between the page and an overlay dock.
    sheet.style.border = '1px solid';
    act(() => root.render(<RailPage />));
    act(() => useStore.setState({ appRoute: 'git' }));
    expect(page()?.style.right).toBe('319px');
  });

  it('with the dock closed the Git page takes the whole sheet', () => {
    dock.remove();
    act(() => root.render(<RailPage />));
    act(() => useStore.setState({ appRoute: 'git' }));
    expect(page()?.style.right).toBe('0px');
    expect(page()?.getAttribute('data-beside-dock')).toBeNull();
  });

  it('watches only the dock region\'s own children, never its subtree (streamed messages would force layouts)', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    act(() => root.render(<RailPage />));
    act(() => useStore.setState({ appRoute: 'git' }));
    const onRegion = observe.mock.calls.filter(([target]) => (target as Element).hasAttribute?.('data-dock-region'));
    expect(onRegion.map(([, opts]) => opts)).toEqual([{ childList: true }]);
    observe.mockRestore();
  });

  it('focus in the dock stays on the Git page and is dropped under a page that covers it', () => {
    act(() => root.render(<RailPage />));
    dock.focus();
    act(() => useStore.setState({ appRoute: 'git' }));
    expect(document.activeElement).toBe(dock);
    act(() => useStore.setState({ appRoute: 'fleet' }));
    expect(document.activeElement).not.toBe(dock);
  });
});
