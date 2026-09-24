import { createContext, useContext, useId } from 'react';
import type { ReactNode } from 'react';

/**
 * Settings-style form row: a label (13px/500) with an optional description
 * (11px, --text-sub) and the control. `inline` puts the control on the right
 * of the text; `stacked` puts it underneath (text inputs, long selects).
 *
 * The row wires accessibility for the control it wraps: the primitives in
 * this folder (Switch, Checkbox, Select, Input) read {@link useFieldControl}
 * and pick up the label's `htmlFor` id and the description's
 * `aria-describedby`, so a call site never has to thread ids by hand.
 */

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
}

const FieldContext = createContext<FieldControlProps | null>(null);

/** Ids for the control inside the nearest Field, or null outside one. */
export function useFieldControl(): FieldControlProps | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  label: ReactNode;
  description?: ReactNode;
  layout?: 'inline' | 'stacked';
  /** The control. */
  children?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

export default function Field({
  label,
  description,
  layout = 'inline',
  children,
  className = '',
  'data-testid': testId,
}: FieldProps) {
  const id = useId();
  const descriptionId = useId();
  const hasDescription = description != null;
  const control: FieldControlProps = {
    id,
    'aria-describedby': hasDescription ? descriptionId : undefined,
  };
  return (
    <div className={`ui-field${className ? ` ${className}` : ''}`} data-layout={layout} data-testid={testId}>
      <div className="ui-field-text">
        <label htmlFor={id} className="ui-field-label">
          {label}
        </label>
        {hasDescription && (
          <span id={descriptionId} className="ui-field-description">
            {description}
          </span>
        )}
      </div>
      <div className="ui-field-control">
        <FieldContext.Provider value={control}>{children}</FieldContext.Provider>
      </div>
    </div>
  );
}
