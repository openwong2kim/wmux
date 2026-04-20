import { useState, useCallback, useEffect, useMemo } from 'react';
import OnboardingHighlight from './OnboardingHighlight';
import { ONBOARDING_STEPS } from './steps';
import type { OnboardingStep } from './steps';
import type { TooltipPlacement } from './OnboardingHighlight';
import { t } from '../../i18n';

interface OnboardingOverlayProps {
  /** Called when the user finishes or skips the entire onboarding flow. */
  onComplete: () => void;
  /** Optional subset / override of steps. Defaults to ONBOARDING_STEPS. */
  steps?: OnboardingStep[];
}

/**
 * Full-screen onboarding overlay that walks the user through key UI areas.
 *
 * Renders a dark backdrop with a spotlight cutout on the current target
 * element and a tooltip with title, description, and navigation buttons.
 *
 * Steps whose target selector does not match any DOM element are
 * automatically skipped.
 */
export default function OnboardingOverlay({
  onComplete,
  steps = ONBOARDING_STEPS,
}: OnboardingOverlayProps) {
  const [currentIndex, setCurrentIndex] = useState(0);

  // Filter to only steps whose target actually exists in the DOM.
  // Re-evaluated on every render so freshly-mounted targets are picked up.
  const availableSteps = useMemo(() => {
    return steps.filter((step) => document.querySelector(step.targetSelector) !== null);
  }, [steps, currentIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // If no steps are available at all, complete immediately.
  useEffect(() => {
    if (availableSteps.length === 0) {
      onComplete();
    }
  }, [availableSteps.length, onComplete]);

  const step = availableSteps[currentIndex] as OnboardingStep | undefined;

  const handleNext = useCallback(() => {
    if (currentIndex + 1 >= availableSteps.length) {
      onComplete();
    } else {
      setCurrentIndex((i) => i + 1);
    }
  }, [currentIndex, availableSteps.length, onComplete]);

  const handlePrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, []);

  const handleSkip = useCallback(() => {
    onComplete();
  }, [onComplete]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onComplete();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onComplete]);

  if (!step) return null;

  const isFirst = currentIndex === 0;
  const isLast = currentIndex === availableSteps.length - 1;
  const stepLabel = `${currentIndex + 1} / ${availableSteps.length}`;

  return (
    <div
      className="onboarding-overlay"
      data-testid="onboarding-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
      }}
    >
      {/* Invisible backdrop — catches clicks outside the spotlight */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
        }}
        onClick={handleSkip}
        data-testid="onboarding-backdrop"
      />

      <OnboardingHighlight
        targetSelector={step.targetSelector}
        preferredPosition={step.placement}
      >
        {(placement: TooltipPlacement) => (
          <div
            className="onboarding-tooltip-card"
            style={{
              backgroundColor: 'var(--bg-base)',
              border: '1px solid var(--bg-surface)',
              borderRadius: 10,
              padding: '16px 20px',
              boxShadow: '0 12px 40px rgba(0, 0, 0, 0.5)',
              fontFamily: 'ui-monospace, monospace',
              // Fade-in animation
              animation: 'onboarding-fade-in 0.2s ease-out',
            }}
            onClick={(e) => e.stopPropagation()}
            data-placement={placement}
            data-testid="onboarding-card"
          >
            {/* Step indicator */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--text-subtle)',
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                }}
              >
                Step {stepLabel}
              </span>
              {/* Dot indicators */}
              <div style={{ display: 'flex', gap: 4 }}>
                {availableSteps.map((_, i) => (
                  <span
                    key={i}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      backgroundColor:
                        i === currentIndex
                          ? 'var(--accent-blue)'
                          : 'var(--bg-overlay)',
                      transition: 'background-color 0.2s ease',
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Title */}
            <h3
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--text-main)',
                margin: '0 0 6px 0',
              }}
            >
              {t(step.titleKey)}
            </h3>

            {/* Description */}
            <p
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--text-sub)',
                margin: '0 0 16px 0',
              }}
            >
              {t(step.descriptionKey)}
            </p>

            {/* Navigation buttons */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <button
                onClick={handleSkip}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-subtle)',
                  fontSize: 11,
                  cursor: 'pointer',
                  padding: '4px 0',
                  fontFamily: 'inherit',
                }}
                data-testid="onboarding-skip"
              >
                Skip
              </button>

              <div style={{ display: 'flex', gap: 8 }}>
                {!isFirst && (
                  <button
                    onClick={handlePrev}
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-sub)',
                      border: 'none',
                      borderRadius: 6,
                      padding: '6px 14px',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      transition: 'background-color 0.15s ease',
                    }}
                    data-testid="onboarding-prev"
                  >
                    Back
                  </button>
                )}
                <button
                  onClick={handleNext}
                  style={{
                    backgroundColor: 'var(--accent-blue)',
                    color: 'var(--bg-base)',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    transition: 'background-color 0.15s ease',
                  }}
                  data-testid="onboarding-next"
                >
                  {isLast ? 'Done' : 'Next'}
                </button>
              </div>
            </div>
          </div>
        )}
      </OnboardingHighlight>
    </div>
  );
}
