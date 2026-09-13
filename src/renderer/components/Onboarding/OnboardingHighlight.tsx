import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';

export interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

interface OnboardingHighlightProps {
  targetSelector: string;
  preferredPosition?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  children: (placement: TooltipPlacement, tooltipStyle: React.CSSProperties) => React.ReactNode;
}

const PADDING = 8;
const TOOLTIP_GAP = 12;
const TOOLTIP_WIDTH = 320;
/** Minimum distance between the card and the viewport edge. */
export const VIEWPORT_MARGIN = 16;
/** Card height used until the rendered card has been measured. */
const ESTIMATED_CARD_HEIGHT = 180;

export interface ViewportSize {
  width: number;
  height: number;
}

export interface TooltipLayout {
  placement: TooltipPlacement;
  style: React.CSSProperties & { top: number; left: number; width: number; maxHeight: number };
}

const AUTO_ORDER: TooltipPlacement[] = ['bottom', 'top', 'right', 'left'];

/**
 * #1275 — resolves the placement and a viewport-clamped position for the
 * tooltip card. The preferred side (or the auto order) wins when the card
 * fits there; otherwise the side with the most room is used. Either way the
 * card is clamped inside the viewport so Skip / Next stay reachable — the old
 * resolver fell back to 'bottom' unclamped and pushed the card off-screen on
 * small windows.
 */
export function computeTooltipLayout(
  rect: TargetRect,
  preferred: TooltipPlacement | 'auto',
  viewport: ViewportSize,
  cardHeight: number,
): TooltipLayout {
  const width = Math.max(0, Math.min(TOOLTIP_WIDTH, viewport.width - VIEWPORT_MARGIN * 2));
  const maxHeight = Math.max(0, viewport.height - VIEWPORT_MARGIN * 2);
  const height = Math.min(cardHeight, maxHeight);
  const rectRight = rect.left + rect.width;
  const rectBottom = rect.top + rect.height;

  // Room left over on each side once the card (plus gap and margin) is placed there.
  const slack: Record<TooltipPlacement, number> = {
    bottom: viewport.height - rectBottom - (PADDING + TOOLTIP_GAP + height + VIEWPORT_MARGIN),
    top: rect.top - (TOOLTIP_GAP + height + VIEWPORT_MARGIN),
    right: viewport.width - rectRight - (PADDING + TOOLTIP_GAP + width + VIEWPORT_MARGIN),
    left: rect.left - (TOOLTIP_GAP + width + VIEWPORT_MARGIN),
  };

  const order = preferred === 'auto' ? AUTO_ORDER : [preferred, ...AUTO_ORDER.filter((p) => p !== preferred)];
  const placement = order.find((p) => slack[p] >= 0)
    ?? order.reduce((best, p) => (slack[p] > slack[best] ? p : best));

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  let top: number;
  let left: number;
  switch (placement) {
    case 'bottom':
      top = rectBottom + PADDING + TOOLTIP_GAP;
      left = centerX - width / 2;
      break;
    case 'top':
      top = rect.top - TOOLTIP_GAP - height;
      left = centerX - width / 2;
      break;
    case 'right':
      top = centerY - 40;
      left = rectRight + PADDING + TOOLTIP_GAP;
      break;
    case 'left':
      top = centerY - 40;
      left = rect.left - TOOLTIP_GAP - width;
      break;
  }

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  top = clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN - height));
  left = clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - width));

  return {
    placement,
    style: { position: 'fixed', top, left, width, maxHeight, overflowY: 'auto' },
  };
}

/**
 * OnboardingHighlight tracks a DOM element by CSS selector, renders a
 * spotlight cutout, and positions a tooltip near the target.
 *
 * If the target element does not exist in the DOM, `onMissing` is called
 * so the parent can skip the step.
 */
export default function OnboardingHighlight({
  targetSelector,
  preferredPosition = 'auto',
  children,
}: OnboardingHighlightProps) {
  const [rect, setRect] = useState<TargetRect | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number>(0);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(ESTIMATED_CARD_HEIGHT);

  const measure = useCallback(() => {
    const el = document.querySelector(targetSelector);
    if (!el) {
      setRect(null);
      return;
    }
    const domRect = el.getBoundingClientRect();
    setRect({
      top: domRect.top - PADDING,
      left: domRect.left - PADDING,
      width: domRect.width + PADDING * 2,
      height: domRect.height + PADDING * 2,
    });
  }, [targetSelector]);

  useEffect(() => {
    measure();

    const el = document.querySelector(targetSelector);
    if (!el) return;

    // Observe resize of the target element
    observerRef.current = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(measure);
    });
    observerRef.current.observe(el);

    // Also re-measure on window resize
    const handleResize = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      observerRef.current?.disconnect();
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', handleResize);
    };
  }, [targetSelector, measure]);

  // Measure the rendered card so the viewport clamp uses its real height
  // (scrollHeight stays the content height even when maxHeight caps the box).
  // Re-measured only when the target / step changes, so a placement flip
  // near zero slack cannot feed back into another measurement.
  useLayoutEffect(() => {
    const measured = tooltipRef.current?.scrollHeight;
    if (measured && Math.abs(measured - cardHeight) > 1) setCardHeight(measured);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cardHeight is the output, not a trigger
  }, [rect, targetSelector]);

  if (!rect) return null;

  const { placement, style: tooltipStyle } = computeTooltipLayout(
    rect,
    preferredPosition,
    { width: window.innerWidth, height: window.innerHeight },
    cardHeight,
  );

  // Spotlight box-shadow: a huge spread that covers the entire viewport,
  // with an inset "hole" matching the target rect.
  const spotlightStyle: React.CSSProperties = {
    position: 'fixed',
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    borderRadius: 6,
    boxShadow: '0 0 0 9999px var(--bg-overlay-scrim, rgba(0, 0, 0, 0.55))',
    pointerEvents: 'none',
    zIndex: 10000,
    transition: 'top 0.3s ease, left 0.3s ease, width 0.3s ease, height 0.3s ease',
  };

  return (
    <>
      <div
        className="onboarding-spotlight"
        style={spotlightStyle}
        data-testid="onboarding-spotlight"
      />
      <div ref={tooltipRef} style={{ ...tooltipStyle, zIndex: 10001 }} data-testid="onboarding-tooltip">
        {children(placement, tooltipStyle)}
      </div>
    </>
  );
}
