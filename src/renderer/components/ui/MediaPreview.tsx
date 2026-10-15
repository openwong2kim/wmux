import { useEffect, useState } from 'react';
import type { MediaClip } from '../../assets/media';
import { prefersReducedMotion, subscribeReducedMotion } from '../../utils/reducedMotion';

/** Live reduced-motion state: `prefers-reduced-motion`, or Windows' setting
 *  (utils/reducedMotion.ts); false where neither can be read. */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(prefersReducedMotion);
  useEffect(() => {
    setReduce(prefersReducedMotion());
    return subscribeReducedMotion(() => setReduce(prefersReducedMotion()));
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
