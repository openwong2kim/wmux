// @vitest-environment jsdom
//
// AgentModeChip: reads the current mode on mount, renders it as a chip, and
// sets a new mode from the dropdown (optimistic + echo). Injected fake api so
// no preload/IPC is needed.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { AgentModeChip, type AgentModeApi } from '../AgentModeChip';
import type { AgentMode } from '../../../../main/deck/deckAutonomyStore';

const t = (k: string) => k; // identity — assert on keys

function render(ui: React.ReactElement): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    cleanup: () => { act(() => root.unmount()); container.remove(); },
  };
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fakeApi(initial: AgentMode): { api: AgentModeApi; sets: AgentMode[] } {
  const sets: AgentMode[] = [];
  return {
    sets,
    api: {
      get: async () => ({ mode: initial }),
      set: async (_ws, mode) => { sets.push(mode); return { ok: true, mode }; },
    },
  };
}

describe('AgentModeChip', () => {
  it('renders the current mode label after the initial read', async () => {
    const { api } = fakeApi('danger');
    const { container, cleanup } = render(<AgentModeChip api={api} workspaceId="ws-1" t={t} />);
    cleanups.push(cleanup);
    await flush();
    const chip = container.querySelector('[data-agent-mode-chip] button')!;
    expect(chip.textContent).toContain('deck.mode.danger');
  });

  it('opens the dropdown and sets a new mode (optimistic + persisted)', async () => {
    const { api, sets } = fakeApi('assist');
    const { container, cleanup } = render(<AgentModeChip api={api} workspaceId="ws-1" t={t} />);
    cleanups.push(cleanup);
    await flush();

    // open
    const chip = container.querySelector('[data-agent-mode-chip] > button') as HTMLButtonElement;
    act(() => chip.click());
    // pick 'off'
    const off = container.querySelector('[data-mode-option="off"]') as HTMLButtonElement;
    expect(off).toBeTruthy();
    await act(async () => { off.click(); await Promise.resolve(); });

    expect(sets).toEqual(['off']);
    // chip reflects the new mode; dropdown closed
    expect((container.querySelector('[data-agent-mode-chip] > button')!).textContent).toContain('deck.mode.off');
    expect(container.querySelector('[data-mode-option="off"]')).toBeNull();
  });

  // Caught live, not by review: a dev renderer hot-reloaded ahead of a stale
  // main answered with the retired `auto`, `MODE_SKIN[mode]` came back
  // undefined, and reading `.btn` threw — taking the whole deck rail down
  // through its ErrorBoundary ("Crashed: Cannot read properties of undefined").
  // The mode crosses an IPC boundary, so an unknown value must degrade, never
  // throw. A downgrade to an older main would do exactly the same thing.
  it('survives a mode the renderer does not know (stale/downgraded main)', async () => {
    const api: AgentModeApi = {
      get: async () => ({ mode: 'auto' as unknown as AgentMode }),
      set: async () => ({ ok: true }),
    };
    const { container, cleanup } = render(<AgentModeChip api={api} workspaceId="ws-1" t={t} />);
    cleanups.push(cleanup);
    await flush();

    const chip = container.querySelector('[data-agent-mode-chip] > button');
    expect(chip).toBeTruthy();
    // Falls back to the OFF dot — the most conservative badge.
    expect(container.querySelector('[data-agent-mode-dot]')!.className).toContain('--text-muted');
  });

  // DESIGN.md amber diet: the chip used to be a red-tinted bordered pill in
  // `danger` and a warm-tinted pill in `assist`, so an idle control spent
  // attention points and a toolbar button carried a box at rest. State now
  // lives in the dot; the chip body is the boxless recipe that only raises on
  // hover (.ui-chip-boxless in styles/ui.css).
  it('is a boxless chip: state lives in the dot, never in a tint at rest', async () => {
    for (const [mode, dotToken] of [
      ['off', '--text-muted'],
      ['assist', '--accent)'],
      ['danger', '--accent-red'],
    ] as const) {
      const api: AgentModeApi = {
        get: async () => ({ mode: mode as AgentMode }),
        set: async () => ({ ok: true }),
      };
      const { container, cleanup } = render(<AgentModeChip api={api} workspaceId="ws-1" t={t} />);
      cleanups.push(cleanup);
      await flush();

      const chip = container.querySelector('[data-agent-mode-chip] > button') as HTMLElement;
      expect(chip.className, `${mode} chip is boxless`).toContain('ui-chip-boxless');
      // No fill, no coloured border, no per-mode weight bump at rest.
      expect(chip.className).not.toMatch(/\bbg-\[/);
      expect(chip.className).not.toMatch(/\bborder(-|\[)/);
      expect(chip.className).not.toMatch(/font-(medium|semibold)/);
      // The dot is one size in every mode, so switching never reflows the row.
      const dot = container.querySelector('[data-agent-mode-dot]') as HTMLElement;
      expect(dot.className, `${mode} dot`).toContain(dotToken);
      expect(dot.className, `${mode} dot size`).toContain('w-2 h-2');
      // `danger` keeps a second, text-level signal — the label in red, still
      // with no fill or border. The other two modes stay neutral text.
      if (mode === 'danger') expect(chip.className).toContain('text-[var(--accent-red)]');
      else expect(chip.className).not.toContain('--accent-red');
      // The dot is aria-hidden, so the mode has to reach AT users through the
      // label, together with what the mode actually does.
      // `t` is the identity here, so the label key itself is the rendered text.
      expect(chip.getAttribute('aria-label'), `${mode} aria-label`).toContain(`deck.mode.${mode}`);
      expect(chip.getAttribute('aria-label')).toContain(`deck.mode.${mode}Desc`);
      cleanup();
      cleanups.pop();
    }
  });

  // The raised hover/open skin paints box-shadow, and so does the app-wide
  // FOCUS_RING (Tailwind ring-*). ui.css loads after the Tailwind utilities, so
  // without an explicit :focus-visible rule a hovered or open chip swallowed the
  // keyboard ring — the one state a keyboard user needs to see.
  it('keeps a focus-visible ring rule that outranks the raised hover skin', () => {
    const css = readFileSync(
      pathJoin(__dirname, '..', '..', '..', 'styles', 'ui.css'),
      'utf8',
    );
    const hover = css.indexOf(".ui-chip-boxless:hover:not(:disabled)");
    const focus = css.indexOf('.ui-chip-boxless:focus-visible:not(:disabled)');
    expect(hover).toBeGreaterThan(-1);
    // Present, and declared AFTER the hover/expanded rule so it wins the tie.
    expect(focus).toBeGreaterThan(hover);
    const rule = css.slice(focus, css.indexOf('}', focus));
    expect(rule).toContain('var(--accent-blue)');
    expect(rule).toContain('var(--bg-base)');
  });

  // The chip lives at the bottom of the deck rail, so the menu opens UPWARD by
  // default. In a short window three options with descriptions are taller than
  // the room above the chip, and the menu ran off the top of the window — the
  // first option (`off`) was rendered but unreachable, so the operator could
  // raise autonomy and never lower it. Reported live 2026-08-03.
  //
  // Viewport height is global state — restore it so a later test never inherits
  // the short window these cases set up.
  const realInnerHeight = window.innerHeight;
  afterEach(() => { Object.defineProperty(window, 'innerHeight', { value: realInnerHeight, writable: true, configurable: true }); });
  function setViewportHeight(px: number): void {
    Object.defineProperty(window, 'innerHeight', { value: px, writable: true, configurable: true });
  }

  async function openMenuWithChipAt(top: number, bottom: number): Promise<HTMLElement> {
    const { api } = fakeApi('danger');
    const { container, cleanup } = render(<AgentModeChip api={api} workspaceId="ws-1" t={t} />);
    cleanups.push(cleanup);
    await flush();
    const root = container.querySelector('[data-agent-mode-chip]') as HTMLElement;
    root.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    act(() => (container.querySelector('[data-agent-mode-chip] > button') as HTMLButtonElement).click());
    return container.querySelector('[role="listbox"]') as HTMLElement;
  }

  it('caps the upward menu at the room above the chip', async () => {
    setViewportHeight(768);
    const menu = await openMenuWithChipAt(700, 720);
    expect(menu.className).toContain('bottom-full'); // more room above → opens up
    expect(menu.style.maxHeight).toBe('692px');      // 700 - 8 gap
    expect(menu.className).toContain('overflow-y-auto');
  });

  it('flips the menu downward when the chip is pinned near the top', async () => {
    setViewportHeight(768);
    const menu = await openMenuWithChipAt(10, 30);
    expect(menu.className).toContain('top-full');
    expect(menu.className).not.toContain('bottom-full');
    expect(menu.style.maxHeight).toBe('730px'); // 768 - 30 - 8 gap
  });

  // A minimum height that outgrows the measured room is the same overflow bug
  // in miniature: the menu would extend past the window edge again and clip the
  // option nearest it. In a window this short the menu is small and scrolls.
  it('never claims more height than the room it measured', async () => {
    setViewportHeight(200);
    const menu = await openMenuWithChipAt(60, 80);
    expect(menu.style.maxHeight).toBe('112px'); // 200 - 80 - 8, the larger side
    expect(parseInt(menu.style.maxHeight, 10)).toBeLessThan(200);
  });

  it('renders nothing until the first read resolves (no label flash)', () => {
    const api: AgentModeApi = { get: () => new Promise(() => {}), set: async () => ({ ok: true }) };
    const { container, cleanup } = render(<AgentModeChip api={api} workspaceId="ws-1" t={t} />);
    cleanups.push(cleanup);
    expect(container.querySelector('[data-agent-mode-chip]')).toBeNull();
  });
});
