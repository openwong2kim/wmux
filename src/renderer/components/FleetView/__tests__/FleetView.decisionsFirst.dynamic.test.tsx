// @vitest-environment jsdom
//
// Needs you holds decisions only: questions, then errors. Finished turns fold
// into one "Finished N" row; the chip, the section head and the rail count
// agree; a needs-input row's detail shows the question in full with the
// prompt's choices; an error row names its error and Check opens the detail
// on it; the row menu opens from the keyboard.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as terminalTail from '../../../utils/terminalTail';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import { selectFleetSectionCounts } from '../../../stores/selectors/fleet';
import type { Workspace, Pane, Surface } from '../../../../shared/types';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: `${id} task`, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal' };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function workspace(id: string, name: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name, rootPane, activePaneId };
}

const QUESTION = `Apply the migration to the production database now? ${'It rewrites the billing tables. '.repeat(6)}`.trim();
const TAILS: Record<string, string[]> = {
  'pty-1': ['Apply the migration?', '❯ 1. Yes', '  2. No, and tell Claude what to do differently', '', 'Esc to cancel'],
  'pty-2': ['> npm run build', 'Error: build failed at step 3', '    at compile (build.ts:4:2)', 'exit 1'],
};

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(React.createElement(FleetView)); });
}

async function flushRaf(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function rows(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-fleet-card]'));
}
function row(ptyId: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-fleet-card][data-pty-id="${ptyId}"]`)!;
}
function key(element: Element, name: string, init: KeyboardEventInit = {}): void {
  act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init })); });
}

beforeEach(() => {
  vi.spyOn(terminalTail, 'tailForPty').mockImplementation((ptyId: string) => TAILS[ptyId] ?? []);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: () => undefined, dispose: () => undefined },
    metadata: { setLabel: async () => ({ ok: true }) },
  };
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      fleetActiveTab: 'fleet',
      fleetSortMode: 'attention',
      appRoute: 'fleet',
      fleetViewVisible: true,
      workspaces: [
        workspace('ws-1', 'alpha', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
        workspace('ws-2', 'beta', leaf('p2', [surface('s2', 'pty-2')]), 'p2'),
        workspace('ws-3', 'gamma', leaf('p3', [surface('s3', 'pty-3')]), 'p3'),
        workspace('ws-4', 'delta', leaf('p4', [surface('s4', 'pty-4')]), 'p4'),
        workspace('ws-5', 'epsilon', leaf('p5', [surface('s5', 'pty-5')]), 'p5'),
      ],
      surfaceAgent: Object.fromEntries(['pty-1', 'pty-2', 'pty-3', 'pty-4', 'pty-5']
        .map((id) => [id, { name: 'Claude Code', status: 'idle' as const }])),
      surfaceAgentStatus: { 'pty-1': 'awaiting_input', 'pty-2': 'error', 'pty-3': 'complete', 'pty-4': 'complete' },
      surfacePendingQuestion: { 'pty-1': QUESTION },
      surfaceTurnOpenAt: { 'pty-5': Date.now() },
      surfaceOutputAt: { 'pty-3': Date.now() - 5 * 60_000, 'pty-4': Date.now() - 2 * 60_000 },
      agentClockMs: Date.now(),
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  document.body.innerHTML = '';
});

describe('FleetView — Needs you is decisions only', () => {
  it('lists the question, then the error; finished turns fold into one Finished row', async () => {
    mount();
    await flushRaf();
    expect([...container.querySelectorAll<HTMLElement>('[data-fleet-section]')].map((el) => el.dataset.fleetSection))
      .toEqual(['needsYou', 'finished', 'running']);
    expect(rows().map((r) => r.dataset.ptyId)).toEqual(['pty-1', 'pty-2', 'pty-5']);
    expect(container.querySelector('[data-fleet-finished-toggle]')?.textContent).toBe('Finished 2 · newest 2m');
  });

  it('one count: the chip, the section head and the rail read the same number', async () => {
    mount();
    await flushRaf();
    const chip = container.querySelector('[data-filter="attention"] > span:last-child')?.textContent;
    const head = container.querySelector('[data-fleet-section="needsYou"] .wmux-board-col-count')?.textContent;
    expect(chip).toBe('2');
    expect(head).toBe('2');
    expect(selectFleetSectionCounts(useStore.getState()).needsYou).toBe(2);
  });

  it('announces the Needs you count when it changes, not when Fleet opens', async () => {
    mount();
    await flushRaf();
    const live = container.querySelector('[data-fleet-live]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');
    act(() => { useStore.setState({ surfaceAgentStatus: { ...useStore.getState().surfaceAgentStatus, 'pty-3': 'awaiting_input' } }); });
    await flushRaf();
    expect(live.textContent).toBe('Needs you: 3');
  });
});

describe('FleetView — respond and check in place', () => {
  it('a needs-input detail shows the full question and the prompt choices first, output below', async () => {
    mount();
    await flushRaf();
    act(() => row('pty-1').focus());
    key(row('pty-1'), ' ');
    await flushRaf();
    const request = container.querySelector<HTMLElement>('[data-fleet-request="input"]')!;
    expect(request).not.toBeNull();
    expect(request.querySelector('[data-fleet-request-text]')?.textContent).toBe(QUESTION);
    expect([...request.querySelectorAll('[data-fleet-request-choices] li')].map((li) => li.textContent))
      .toEqual(['1. Yes', '2. No, and tell Claude what to do differently']);
    // The request comes before the output in the detail.
    const preview = container.querySelector('[data-fleet-preview]')!;
    expect(request.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Reply opens the row's composer without leaving Fleet.
    act(() => container.querySelector<HTMLButtonElement>('[data-fleet-request-reply]')!.click());
    expect(container.querySelector('[data-fleet-editor="message"]')).not.toBeNull();
    expect(useStore.getState().appRoute).toBe('fleet');
  });

  it('an error row names its last error line; Check opens the detail on it instead of jumping', async () => {
    mount();
    await flushRaf();
    const error = row('pty-2');
    expect(error.querySelector('[data-fleet-now="error"]')?.textContent).toBe('Error: build failed at step 3');
    act(() => { error.focus(); error.click(); });
    await flushRaf();
    expect(useStore.getState().appRoute).toBe('fleet');
    expect(container.querySelector('[data-fleet-request="check"] [data-fleet-request-text]')?.textContent)
      .toBe('Error: build failed at step 3');
    expect(container.querySelector('[data-fleet-error-line]')?.textContent).toBe('Error: build failed at step 3');
    // The detail's Jump goes to the pane.
    act(() => container.querySelector<HTMLButtonElement>('[data-fleet-request-jump]')!.click());
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(useStore.getState().activeWorkspaceId).toBe('ws-2');
  });

  it('a question row keeps its whole question in the accessible name\'s clipped form', async () => {
    mount();
    await flushRaf();
    const label = row('pty-1').getAttribute('aria-label') ?? '';
    expect(label.length).toBeLessThan(160);
    expect(label).toContain('Apply the migration');
  });
});

describe('FleetView — listbox semantics', () => {
  it('row buttons outside the options are hidden from the tree; Shift+F10 opens the row menu', async () => {
    mount();
    await flushRaf();
    for (const el of container.querySelectorAll('[data-fleet-row-trigger], [data-fleet-detail-toggle]')) {
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.getAttribute('tabindex')).toBe('-1');
    }
    act(() => row('pty-5').focus());
    key(row('pty-5'), 'F10', { shiftKey: true });
    expect(document.body.querySelectorAll('[data-pane-menu-action]').length).toBeGreaterThan(0);
  });
});
