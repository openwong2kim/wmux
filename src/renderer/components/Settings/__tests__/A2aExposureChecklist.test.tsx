/**
 * "Panes to show" checklist: pure view via renderToStaticMarkup (node env),
 * callbacks invoked directly, plus the explicit-list toggles it writes.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { A2aExposureChecklistView, type A2aExposureChecklistViewProps } from '../A2aExposureChecklist';
import { togglePaneExposure, toggleWorkspaceExposure } from '../../Remote/a2aLinkModel';

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

const base: A2aExposureChecklistViewProps = {
  pcName: 'LAPTOP',
  workspaces: [
    { id: 'w1', name: 'API', panes: [{ id: 'p1', name: 'w1-1(claude)' }, { id: 'p2', name: 'w1-2' }] },
    { id: 'w2', name: 'Docs', panes: [{ id: 'p3', name: 'w2-1' }] },
  ],
  exposure: { workspaceIds: [], paneIds: {} },
  busy: false,
  moaAvailable: true,
  onToggleBrain: () => undefined,
  onToggleWorkspace: () => undefined,
  onTogglePane: () => undefined,
  t,
};

const render = (p: Partial<A2aExposureChecklistViewProps> = {}): string =>
  renderToStaticMarkup(createElement(A2aExposureChecklistView, { ...base, ...p }));

describe('A2aExposureChecklistView', () => {
  it('shows nothing ticked by default', () => {
    const html = render();
    expect(html).toContain('API');
    expect(html).toContain('w1-1(claude)');
    expect(html).not.toContain('aria-checked="true"');
  });

  it('ticks the listed panes and counts them per workspace', () => {
    const html = render({ exposure: { workspaceIds: ['w1'], paneIds: { w1: ['p1'] } } });
    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(1);
    expect(html).toContain('settings.a2aExposureCount(1,2)');
  });
});

describe('A2aExposureChecklistView Moa row', () => {
  it('is unticked by default and ticks from the exposure', () => {
    expect(render()).toContain('settings.a2aExposureMoa');
    const on = render({ exposure: { workspaceIds: [], paneIds: {}, brain: true } });
    expect((on.match(/aria-checked="true"/g) ?? []).length).toBe(1);
  });

  it('is disabled while this PC has no Moa', () => {
    const html = render({ moaAvailable: false });
    expect(html).toContain('settings.a2aExposureMoaOff');
    expect(html).toMatch(/data-testid="a2a-exposure-moa"[\s\S]*?disabled=""/);
  });
});

describe('exposure toggles write explicit pane lists', () => {
  it('keeps the Moa flag across pane toggles', () => {
    expect(togglePaneExposure({ workspaceIds: [], paneIds: {}, brain: true }, 'w1', 'p1', true).brain).toBe(true);
  });

  it('a workspace tick lists its current panes; untick drops it', () => {
    const on = toggleWorkspaceExposure({ workspaceIds: [], paneIds: {} }, 'w1', ['p1', 'p2'], true);
    expect(on).toEqual({ workspaceIds: ['w1'], paneIds: { w1: ['p1', 'p2'] } });
    expect(toggleWorkspaceExposure(on, 'w1', ['p1', 'p2'], false)).toEqual({ workspaceIds: [], paneIds: {} });
  });

  it('unticking the last pane drops the workspace rather than leaving an empty list', () => {
    const one = togglePaneExposure({ workspaceIds: [], paneIds: {} }, 'w1', 'p1', true);
    expect(one).toEqual({ workspaceIds: ['w1'], paneIds: { w1: ['p1'] } });
    expect(togglePaneExposure(one, 'w1', 'p1', false)).toEqual({ workspaceIds: [], paneIds: {} });
  });
});
