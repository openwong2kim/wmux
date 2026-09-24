import { useState, useCallback, useEffect, useId, useMemo, useRef } from 'react';
import OnboardingHighlight from './OnboardingHighlight';
import Button from '../ui/Button';
import MediaPreview from '../ui/MediaPreview';
import { useModalLayer } from '../ui/modalLayer';
import { MEDIA_CLIPS } from '../../assets/media';
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

  // Keyboard path: each step puts focus on its forward action. The card
  // mounts only once the target is measured, so focus is taken from the
  // Next button's ref callback rather than an effect on the step index.
  // The backdrop blocks the pointer everywhere else, so the card is modal
  // for the keyboard too: the shared modal layer contains Tab inside it,
  // routes Escape (never mid-IME) to Skip, and returns focus to the element
  // that had it before the tour.
  const focusedStepRef = useRef<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const attachLayer = useModalLayer({ onEscape: onComplete });

  if (!step) return null;

  const isFirst = currentIndex === 0;
  const isLast = currentIndex === availableSteps.length - 1;
  const stepLabel = `${currentIndex + 1} / ${availableSteps.length}`;
  const clip = step.media ? MEDIA_CLIPS[step.media] : null;
  const focusNext = (el: HTMLButtonElement | null) => {
    if (el && focusedStepRef.current !== step.id) {
      focusedStepRef.current = step.id;
      el.focus();
    }
  };

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
            ref={attachLayer}
            className="onboarding-tooltip-card ui-surface"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onClick={(e) => e.stopPropagation()}
            data-placement={placement}
            data-testid="onboarding-card"
          >
            {clip && (
              <MediaPreview
                key={step.id}
                clip={clip}
                label={t(step.titleKey)}
                data-testid="onboarding-media"
              />
            )}

            {/* Step indicator */}
            <div className="onboarding-step-row">
              <span className="onboarding-step-label">
                {t('onboarding.step', { n: stepLabel })}
              </span>
              <div className="onboarding-dots" aria-hidden="true">
                {availableSteps.map((s, i) => (
                  <span key={s.id} className="onboarding-dot" data-active={i === currentIndex} />
                ))}
              </div>
            </div>

            <h3 id={titleId} className="onboarding-title">
              {t(step.titleKey)}
            </h3>
            <p id={descriptionId} className="onboarding-description">
              {t(step.descriptionKey)}
            </p>

            {/* Navigation: Skip (ghost) · Back (raised) · Next (the one primary) */}
            <div className="onboarding-actions">
              <Button size="md" variant="ghost" onClick={handleSkip} data-testid="onboarding-skip" className="onboarding-skip">
                {t('onboarding.skip')}
              </Button>
              <div className="onboarding-actions-end">
                {!isFirst && (
                  <Button size="md" variant="secondary" onClick={handlePrev} data-testid="onboarding-prev">
                    {t('onboarding.back')}
                  </Button>
                )}
                <Button ref={focusNext} size="md" variant="primary" onClick={handleNext} data-testid="onboarding-next">
                  {isLast ? t('onboarding.done') : t('onboarding.next')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </OnboardingHighlight>
    </div>
  );
}
