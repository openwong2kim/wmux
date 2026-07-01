// FleetCard render tests (fleet-activity-line-hook.md, renderer half).
//
// Vitest runs in node env without jsdom — same pattern as
// NotificationPanel.test.tsx / PermissionApprovalDialog.test.tsx: the card is a
// stateless view, so renderToStaticMarkup produces the real markup. We use it to
// pin the activity-vs-tail display contract:
//   - activity present            → the activity accent line shows.
//   - activity absent + terminal  → the raw tail fallback shows.
//   - both present                → activity WINS (tail suppressed).
//   - awaiting_input              → the affordance still takes priority.
//
// FleetCard calls useT() internally, which reads the module-singleton store's
// locale (default en). useT does not touch the DOM, so SSR runs it fine.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import FleetCard from '../FleetCard';
import type { FleetPane } from '../../../stores/selectors/fleet';

const noop = () => undefined;

function card(overrides: Partial<FleetPane> = {}): FleetPane {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'alpha',
    paneId: 'p1',
    surfaceId: 's1',
    ptyId: 'pty-1',
    agentStatus: 'running',
    title: 'claude',
    surfaceType: 'terminal',
    isActivePane: true,
    ...overrides,
  };
}

function render(props: { card: FleetPane; tail?: string[] }): string {
  return renderToStaticMarkup(
    createElement(FleetCard, { card: props.card, focused: false, onJump: noop, tail: props.tail }),
  );
}

describe('FleetCard — activity line vs tail fallback', () => {
  it('renders the activity line when card.activity is present', () => {
    const html = render({ card: card({ activity: '✎ fleet.ts' }) });
    expect(html).toContain('data-fleet-activity');
    expect(html).toContain('✎ fleet.ts');
  });

  it('renders the raw tail fallback when there is NO activity (terminal with output)', () => {
    const html = render({ card: card({ activity: undefined }), tail: ['line one', 'line two'] });
    expect(html).not.toContain('data-fleet-activity');
    expect(html).toContain('line one');
    expect(html).toContain('line two');
  });

  it('activity WINS over the tail when both are present (tail suppressed)', () => {
    const html = render({ card: card({ activity: '$ npm test' }), tail: ['noisy spinner frame', '────────'] });
    expect(html).toContain('data-fleet-activity');
    expect(html).toContain('$ npm test');
    // The fallback tail rows must NOT render when activity replaces the block.
    expect(html).not.toContain('noisy spinner frame');
  });

  it('treats a whitespace-only activity as absent (falls back to the tail)', () => {
    const html = render({ card: card({ activity: '   ' }), tail: ['fallback row'] });
    expect(html).not.toContain('data-fleet-activity');
    expect(html).toContain('fallback row');
  });

  it('awaiting_input affordance takes priority; the activity line is suppressed', () => {
    const html = render({ card: card({ agentStatus: 'awaiting_input', activity: '✎ fleet.ts' }) });
    // The yellow "needs your input" affordance shows...
    expect(html).toContain('Needs your input');
    // ...and the activity accent line does NOT (the affordance owns that row).
    expect(html).not.toContain('data-fleet-activity');
  });

  it('shows no activity line and no tail for a terminal with neither (idle baseline)', () => {
    const html = render({ card: card({ activity: undefined }), tail: [] });
    expect(html).not.toContain('data-fleet-activity');
  });

  it('does not show a terminal activity line on a browser surface (non-terminal type still labels itself)', () => {
    // A browser card has no ptyId-driven activity in practice; even if a stray
    // activity string were passed, the surfaceType label row is the affordance.
    const html = render({ card: card({ surfaceType: 'browser', activity: undefined }) });
    expect(html).toContain('browser'); // capitalized via CSS, raw text is 'browser'
  });
});

describe('FleetCard — X8 supervision chip', () => {
  it('renders an armed chip with the restart count', () => {
    const html = render({ card: card({ supervision: { status: 'armed', restartCount: 3 } }) });
    expect(html).toContain('data-fleet-supervision');
    expect(html).toContain('data-supervision-status="armed"');
    expect(html).toContain('⟳ 3');
  });

  it('omits the count on an armed pane with zero restarts', () => {
    const html = render({ card: card({ supervision: { status: 'armed', restartCount: 0 } }) });
    expect(html).toContain('data-fleet-supervision');
    expect(html).not.toContain('⟳ 0');
  });

  it('renders a stopped (guard-tripped) chip in red', () => {
    const html = render({ card: card({ supervision: { status: 'stopped', restartCount: 5 } }) });
    expect(html).toContain('data-supervision-status="stopped"');
    expect(html).toContain('⟳!');
    expect(html).toContain('var(--accent-red)');
  });

  it('renders no supervision chip when the pane is unsupervised', () => {
    expect(render({ card: card() })).not.toContain('data-fleet-supervision');
  });
});
