import type { MoaMascotState } from '../../../shared/moa';

export interface MoaMascotProps {
  state: MoaMascotState;
  /** Rendered size in px. 20 and 28 draw only the body and the face. */
  size: number;
  /** Accessible name; omit for a decorative mascot. */
  label?: string;
}

/**
 * Moa, the HQ main bot's character. Placeholder until the soft-3D vector
 * lands; the props are the contract the panel header and the titlebar use.
 */
export function MoaMascot({ state, size, label }: MoaMascotProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      data-moa-mascot={state}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="13" r="9" fill="currentColor" opacity="0.25" />
    </svg>
  );
}
