import type { HTMLAttributes } from 'react';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/**
 * Small inline label (11px, full-round). Neutral by default; status tones
 * tint the text and hairline only, never fill. There is no action/accent
 * tone: a badge is never the primary action. `warning` uses the theme's
 * warning hue — in the amber theme that is the amber, because DESIGN.md
 * assigns warning to the warm accent there on purpose.
 */
export default function Badge({ tone = 'neutral', className = '', ...rest }: BadgeProps) {
  return <span className={`ui-badge${className ? ` ${className}` : ''}`} data-tone={tone} {...rest} />;
}
