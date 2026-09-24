import type { ButtonHTMLAttributes, KeyboardEvent, MouseEvent } from 'react';
import { FOCUS_RING } from '../focusRing';
import { useFieldWiring } from './Field';

export interface ToggleControlProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'aria-checked'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * Shared behaviour of Switch and Checkbox: a button with a checked state.
 * The caller's own handlers run first and can cancel the toggle with
 * `preventDefault()`; the caller's id and aria-describedby are kept and
 * merged with the Field's wiring rather than replacing it.
 */
export function useToggleButtonProps(
  role: 'switch' | 'checkbox',
  baseClass: string,
  {
    checked,
    onCheckedChange,
    disabled,
    className = '',
    id,
    onClick,
    onKeyDown,
    'aria-describedby': describedBy,
    ...rest
  }: ToggleControlProps,
  toggleKeys: readonly string[],
): ButtonHTMLAttributes<HTMLButtonElement> & { role: string; 'aria-checked': boolean } {
  const wiring = useFieldWiring(id, describedBy);
  const toggle = () => {
    if (!disabled) onCheckedChange(!checked);
  };
  return {
    ...rest,
    type: 'button',
    role,
    'aria-checked': checked,
    id: wiring.id,
    'aria-describedby': wiring['aria-describedby'],
    disabled,
    className: `${baseClass} ${FOCUS_RING}${className ? ` ${className}` : ''}`,
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (!e.defaultPrevented) toggle();
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      if (e.key !== ' ' && e.key !== 'Enter') return;
      // Handled here, and the native button click suppressed, so each press
      // acts exactly once.
      e.preventDefault();
      if (toggleKeys.includes(e.key)) toggle();
    },
  };
}
