import { useEffect, useRef, useState, useCallback } from 'react';

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

/**
 * Resolves the best placement for the tooltip given available viewport space.
 */
function resolvePlacement(
  rect: TargetRect,
  preferred: 'top' | 'bottom' | 'left' | 'right' | 'auto',
): TooltipPlacement {
  if (preferred !== 'auto') return preferred;

  const spaceBelow = window.innerHeight - (rect.top + rect.height);
  const spaceAbove = rect.top;
  const spaceRight = window.innerWidth - (rect.left + rect.width);
  const spaceLeft = rect.left;

  // Prefer below, then above, then right, then left
  if (spaceBelow >= 160) return 'bottom';
  if (spaceAbove >= 160) return 'top';
  if (spaceRight >= TOOLTIP_WIDTH + TOOLTIP_GAP) return 'right';
  if (spaceLeft >= TOOLTIP_WIDTH + TOOLTIP_GAP) return 'left';
  return 'bottom';
}

/**
 * Computes CSS properties for positioning the tooltip near the target element.
 */
function computeTooltipStyle(
  rect: TargetRect,
  placement: TooltipPlacement,
): React.CSSProperties {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  switch (placement) {
    case 'bottom':
      return {
        position: 'fixed',
        top: rect.top + rect.height + PADDING + TOOLTIP_GAP,
        left: Math.max(16, Math.min(centerX - TOOLTIP_WIDTH / 2, window.innerWidth - TOOLTIP_WIDTH - 16)),
        width: TOOLTIP_WIDTH,
      };
    case 'top':
      return {
        position: 'fixed',
        bottom: window.innerHeight - rect.top + TOOLTIP_GAP,
        left: Math.max(16, Math.min(centerX - TOOLTIP_WIDTH / 2, window.innerWidth - TOOLTIP_WIDTH - 16)),
        width: TOOLTIP_WIDTH,
      };
    case 'right':
      return {
        position: 'fixed',
        top: Math.max(16, centerY - 40),
        left: rect.left + rect.width + PADDING + TOOLTIP_GAP,
        width: TOOLTIP_WIDTH,
      };
    case 'left':
      return {
        position: 'fixed',
        top: Math.max(16, centerY - 40),
        right: window.innerWidth - rect.left + TOOLTIP_GAP,
        width: TOOLTIP_WIDTH,
      };
  }
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

  if (!rect) return null;

  const placement = resolvePlacement(rect, preferredPosition);
  const tooltipStyle = computeTooltipStyle(rect, placement);

  // Spotlight box-shadow: a huge spread that covers the entire viewport,
  // with an inset "hole" matching the target rect.
  const spotlightStyle: React.CSSProperties = {
    position: 'fixed',
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    borderRadius: 6,
    boxShadow: '0 0 0 9999px var(--bg-overlay-scrim)',
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
      <div style={{ ...tooltipStyle, zIndex: 10001 }} data-testid="onboarding-tooltip">
        {children(placement, tooltipStyle)}
      </div>
    </>
  );
}
