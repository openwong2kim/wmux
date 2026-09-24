import { useEffect, useState } from 'react';
import type { MediaClip } from '../../assets/media';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function readReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED_MOTION).matches;
  } catch {
    return false;
  }
}

/** Live `prefers-reduced-motion` state (false where matchMedia is missing). */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(readReducedMotion);
  useEffect(() => {
    const mql = typeof window !== 'undefined' ? window.matchMedia?.(REDUCED_MOTION) : undefined;
    if (!mql) return;
    const onChange = () => setReduce(mql.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);
  return reduce;
}

export interface MediaPreviewProps {
  clip: MediaClip;
  /** What the clip shows, for assistive tech. */
  label: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * A small looping, muted, autoplaying clip that shows what a feature does.
 * Under `prefers-reduced-motion` it renders the still poster instead and
 * never starts playback. Exposed as one image with a label; the media
 * element itself is hidden from assistive tech.
 */
export default function MediaPreview({ clip, label, className = '', 'data-testid': testId }: MediaPreviewProps) {
  const reduce = usePrefersReducedMotion();
  return (
    <div
      className={`ui-media${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={label}
      data-testid={testId}
      data-motion={reduce ? 'reduced' : 'full'}
    >
      {reduce ? (
        <img src={clip.poster} alt="" aria-hidden="true" draggable={false} />
      ) : (
        <video
          src={clip.src}
          poster={clip.poster}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          aria-hidden="true"
          tabIndex={-1}
        />
      )}
    </div>
  );
}
