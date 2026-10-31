import type { TextareaHTMLAttributes } from 'react';
import { useFieldWiring } from './Field';

/** A multi-line text box with the Input look, labelled by its enclosing Field. */
export default function TextArea({ id, 'aria-describedby': describedBy, className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const wiring = useFieldWiring(id, describedBy);
  return <textarea {...rest} id={wiring.id} aria-describedby={wiring['aria-describedby']} className={`ui-input resize-y ${className}`} />;
}
