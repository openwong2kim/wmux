import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { FOCUS_RING } from '../focusRing';

/**
 * GPUI / Zed-style button variants. The class recipes live in styles/ui.css
 * (theme-safe token color-mix). `icon` is a standalone square ghost chip; the
 * rest compose `.ui-btn` + a variant modifier.
 *
 * - `primary`: solid warm fill, the ONE filled action of a surface.
 * - `secondary`: raised neutral (the default).
 * - `ghost`: boxless until hover.
 * - `destructive`: red tint at rest (alias of `dangerTinted`).
 * - `danger`: solid red, only for the final confirm of a destructive flow.
 */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'danger'
  | 'dangerTinted'
  | 'icon';

/** Opt-in sizes on the 4-step type scale. Omitted = the legacy 12px recipe. */
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ui-btn ui-btn-primary',
  secondary: 'ui-btn ui-btn-secondary',
  ghost: 'ui-btn ui-btn-ghost',
  destructive: 'ui-btn ui-btn-danger-tinted',
  danger: 'ui-btn ui-btn-danger',
  dangerTinted: 'ui-btn ui-btn-danger-tinted',
  icon: 'ui-icon-btn',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'ui-btn-sm',
  md: 'ui-btn-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Ignored for `icon`, which the call site sizes. */
  size?: ButtonSize;
}

/**
 * Shared button primitive. className-composable (caller classes append after
 * the variant recipe so sizing/layout overrides win) and ref-forwarding so it
 * drops into tight spots. The keyboard ring is the app-wide FOCUS_RING (single
 * ring system). `type` defaults to "button" so a Button inside a form never
 * submits by accident — pass `type="submit"` explicitly when that's wanted.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size, className = '', type, ...rest },
  ref,
) {
  const sizeCls = size && variant !== 'icon' ? ` ${SIZE_CLASS[size]}` : '';
  const cls = `${VARIANT_CLASS[variant]}${sizeCls} ${FOCUS_RING}${className ? ` ${className}` : ''}`;
  return <button ref={ref} type={type ?? 'button'} className={cls} {...rest} />;
});

export default Button;
