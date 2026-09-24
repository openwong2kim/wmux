import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { Icon } from '../icons';
import { useFieldWiring } from './Field';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Native <select> in the recessed input skin with a token-coloured chevron.
 * Native on purpose: the OS menu keeps keyboard, type-ahead and screen-reader
 * behaviour for free. Inside a Field it is labelled and described by the row.
 */
const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className = '', id, children, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const wiring = useFieldWiring(id, describedBy);
  return (
    <span className={`ui-select${className ? ` ${className}` : ''}`}>
      <select ref={ref} {...rest} id={wiring.id} aria-describedby={wiring['aria-describedby']}>
        {children}
      </select>
      <Icon size={12}>
        <polyline points="3.5,5.5 7,9 10.5,5.5" />
      </Icon>
    </span>
  );
});

export default Select;
