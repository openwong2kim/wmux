import type { HTMLAttributes } from 'react';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/**
 * Small inline label (11px). Neutral by default; status tones tint the text
 * and hairline only, never fill. There is deliberately no warm/accent tone:
 * the accent is spent on alive dots and the one primary action, and a badge
 * is neither.
 */
export default function Badge({ tone = 'neutral', className = '', ...rest }: BadgeProps) {
  return <span className={`ui-badge${className ? ` ${className}` : ''}`} data-tone={tone} {...rest} />;
}
