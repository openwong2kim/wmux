import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { useFieldControl } from './Field';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * Recessed text input (GPUI sunken field; recipe in styles/ui.css). Focus
 * paints the cool --accent-blue border + glow (navigation/interactive
 * grammar). className-composable and ref-forwarding. Font size / weight are
 * left to the caller (or inherited) so it fits both dialog and compact chrome.
 * Inside a Field it takes the row's label id and description.
 */
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', id, ...rest },
  ref,
) {
  const field = useFieldControl();
  return (
    <input
      ref={ref}
      id={id ?? field?.id}
      aria-describedby={field?.['aria-describedby']}
      className={`ui-input${className ? ` ${className}` : ''}`}
      {...rest}
    />
  );
});

export default Input;
