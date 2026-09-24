import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { useFieldWiring } from './Field';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * Recessed text input (GPUI sunken field; recipe in styles/ui.css). Focus
 * paints the cool --accent-blue border + glow (navigation/interactive
 * grammar). className-composable and ref-forwarding. Font size / weight are
 * left to the caller (or inherited) so it fits both dialog and compact chrome.
 * Inside a Field it takes the row's label id and description.
 */
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', id, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const wiring = useFieldWiring(id, describedBy);
  return (
    <input
      ref={ref}
      {...rest}
      id={wiring.id}
      aria-describedby={wiring['aria-describedby']}
      className={`ui-input${className ? ` ${className}` : ''}`}
    />
  );
});

export default Input;
