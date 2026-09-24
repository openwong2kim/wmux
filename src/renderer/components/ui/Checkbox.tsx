import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent } from 'react';
import { FOCUS_RING } from '../focusRing';
import { IconCheck } from '../icons';
import { useFieldControl } from './Field';

export interface CheckboxProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'aria-checked'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * Checkbox (`role="checkbox"`) drawn with theme tokens instead of the native
 * OS box. Space toggles (the ARIA checkbox key); Enter does not, matching a
 * native checkbox. Inside a Field it is labelled and described by the row.
 */
const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
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
      role="checkbox"
      aria-checked={checked}
      id={id ?? field?.id}
      aria-describedby={field?.['aria-describedby']}
      disabled={disabled}
      className={`ui-checkbox ${FOCUS_RING}${className ? ` ${className}` : ''}`}
      onClick={toggle}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === ' ') {
          e.preventDefault();
          toggle();
        } else if (e.key === 'Enter') {
          // A native checkbox does not toggle on Enter; neither does this one.
          e.preventDefault();
        }
      }}
      {...rest}
    >
      <IconCheck size={12} />
    </button>
  );
});

export default Checkbox;
