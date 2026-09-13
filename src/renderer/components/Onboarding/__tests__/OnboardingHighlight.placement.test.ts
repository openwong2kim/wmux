/**
 * #1275 — the onboarding card must always land fully inside the viewport so
 * Skip / Next stay reachable, even when no side of the target has room.
 */
import { describe, it, expect } from 'vitest';
import { computeTooltipLayout, VIEWPORT_MARGIN } from '../OnboardingHighlight';
import type { TargetRect, ViewportSize } from '../OnboardingHighlight';

const CARD_HEIGHT = 170;

function expectInside(layout: ReturnType<typeof computeTooltipLayout>, viewport: ViewportSize, height: number) {
  const { top, left, width, maxHeight } = layout.style;
  const renderedHeight = Math.min(height, maxHeight);
  expect(top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  expect(left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  expect(top + renderedHeight).toBeLessThanOrEqual(viewport.height - VIEWPORT_MARGIN);
  expect(left + width).toBeLessThanOrEqual(viewport.width - VIEWPORT_MARGIN);
}

describe('computeTooltipLayout', () => {
  it('725×800: a pane-area target with no room on any side keeps the card inside the viewport', () => {
    const viewport = { width: 725, height: 800 };
    // Step 1 highlights the pane area, which fills nearly the whole window.
    const paneArea: TargetRect = { top: 28, left: 232, width: 501, height: 760 };
    const layout = computeTooltipLayout(paneArea, 'bottom', viewport, CARD_HEIGHT);
    expectInside(layout, viewport, CARD_HEIGHT);
  });

  it('falls back to the side with the most room when the preferred side does not fit', () => {
    const viewport = { width: 725, height: 800 };
    // Target hugs the bottom edge: 'bottom' cannot fit, 'top' has plenty of room.
    const statusBar: TargetRect = { top: 760, left: 0, width: 725, height: 40 };
    const layout = computeTooltipLayout(statusBar, 'bottom', viewport, CARD_HEIGHT);
    expect(layout.placement).toBe('top');
    expectInside(layout, viewport, CARD_HEIGHT);
  });

  it('keeps the preferred side when it fits', () => {
    const viewport = { width: 1440, height: 900 };
    const button: TargetRect = { top: 100, left: 20, width: 40, height: 40 };
    const layout = computeTooltipLayout(button, 'right', viewport, CARD_HEIGHT);
    expect(layout.placement).toBe('right');
    expect(layout.style.left).toBe(20 + 40 + 8 + 12);
    expectInside(layout, viewport, CARD_HEIGHT);
  });

  it('a card taller than the viewport is capped and scrolls instead of overflowing', () => {
    const viewport = { width: 300, height: 200 };
    const target: TargetRect = { top: 50, left: 50, width: 100, height: 50 };
    const layout = computeTooltipLayout(target, 'bottom', viewport, 400);
    expect(layout.style.maxHeight).toBe(200 - VIEWPORT_MARGIN * 2);
    expect(layout.style.overflowY).toBe('auto');
    expectInside(layout, viewport, 400);
  });
});
