// The Fleet board card keeps the usage-limit hold readable: a muted clock and
// "Waiting", never the red error grammar of its column.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import FleetBoardCard from '../FleetBoardCard';
import { fleetRow, type FleetPane } from '../../../stores/selectors/fleet';

const noop = () => undefined;

function card(overrides: Partial<FleetPane> = {}): FleetPane {
  return {
    workspaceId: 'ws-1', workspaceName: 'alpha', paneId: 'p1', surfaceId: 's1', ptyId: 'pty-1',
    agentStatus: 'idle', title: 'claude', surfaceType: 'terminal', isActivePane: true, unverifiable: false,
    ...overrides,
  };
}

function render(c: FleetPane): string {
  return renderToStaticMarkup(createElement(FleetBoardCard, {
    card: c, row: fleetRow(c), column: 'idle', focused: false, dense: false, now: 0, onJump: noop, onFocus: noop,
  }));
}

describe('FleetBoardCard — usage-limit hold', () => {
  it('draws a held pane as a muted Waiting clock', () => {
    const html = render(card({ usageLimitWaiting: true }));
    expect(html).toContain('Waiting');
    expect(html).toContain('data-shape="clock"');
    expect(html).toContain('data-usage-waiting="true"');
    expect(html).toContain('var(--text-muted)');
    expect(html).not.toContain('var(--accent-red)');
  });

  it('draws the plain status dot when the pane is not held', () => {
    const html = render(card());
    expect(html).not.toContain('data-shape="clock"');
    expect(html).not.toContain('data-usage-waiting');
  });
});
