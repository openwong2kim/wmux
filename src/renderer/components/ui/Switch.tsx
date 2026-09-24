import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent } from 'react';
import { FOCUS_RING } from '../focusRing';
import { useFieldControl } from './Field';

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'aria-checked'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * On/off switch (`role="switch"`). Space and Enter toggle; inside a Field it
 * is labelled and described by the row. Off = recessed neutral track; on =
 * tinted warm track with a warm knob (see styles/ui.css).
 */
const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, disabled, className = '', id, onKeyDown, ...rest },
  ref,
) {
  const field = useFieldControl();
  const toggle = () => {
    if (!disabled) onCheckedChange(!checked);
  };
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      id={id ?? field?.id}
      aria-describedby={field?.['aria-describedby']}
      disabled={disabled}
      className={`ui-switch ${FOCUS_RING}${className ? ` ${className}` : ''}`}
      onClick={toggle}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        // Handled here (and the native click suppressed) so each key press
        // toggles exactly once whatever the host's default button behaviour.
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggle();
        }
      }}
      {...rest}
    >
      <span className="ui-switch-knob" aria-hidden="true" />
    </button>
  );
});

export default Switch;
