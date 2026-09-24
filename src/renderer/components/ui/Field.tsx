import { createContext, useContext, useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Settings-style form row: a label (13px/500) with an optional description
 * (11px, --text-sub) and the control. `inline` puts the control on the right
 * of the text; `stacked` puts it underneath (text inputs, long selects).
 *
 * The row wires accessibility for the control it wraps. Controls in this
 * folder call {@link useFieldWiring}: they take the row's control id (or keep
 * an explicit id of their own, which the label then adopts), the
 * description's `aria-describedby`, and — for group controls such as
 * SegmentedControl that a `<label for>` cannot name — the label's id for
 * `aria-labelledby`.
 */

interface FieldContextValue {
  controlId: string;
  labelId: string;
  descriptionId: string | undefined;
  adoptId: (id: string | undefined) => void;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldWiring {
  id: string | undefined;
  'aria-describedby': string | undefined;
  /** The Field label's id, for controls a `<label for>` cannot name. */
  labelId: string | undefined;
}

/** Ids a control inside a Field needs. `id` / `describedBy` are the caller's
 *  own props; they win over (and are merged with) the Field's. */
export function useFieldWiring(id?: string, describedBy?: string): FieldWiring {
  const field = useContext(FieldContext);
  const adoptId = field?.adoptId;
  useEffect(() => {
    if (!id || !adoptId) return;
    adoptId(id);
    return () => adoptId(undefined);
  }, [id, adoptId]);
  const describedByAll = [describedBy, field?.descriptionId].filter(Boolean).join(' ') || undefined;
  return {
    id: id ?? field?.controlId,
    'aria-describedby': describedByAll,
    labelId: field?.labelId,
  };
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
  const generatedId = useId();
  const labelId = useId();
  const descriptionId = useId();
  const [adoptedId, setAdoptedId] = useState<string | undefined>(undefined);
  const hasDescription = description != null;
  const controlId = adoptedId ?? generatedId;
  const context = useMemo<FieldContextValue>(
    () => ({
      controlId,
      labelId,
      descriptionId: hasDescription ? descriptionId : undefined,
      adoptId: setAdoptedId,
    }),
    [controlId, labelId, hasDescription, descriptionId],
  );
  return (
    <div className={`ui-field${className ? ` ${className}` : ''}`} data-layout={layout} data-testid={testId}>
      <div className="ui-field-text">
        <label id={labelId} htmlFor={controlId} className="ui-field-label">
          {label}
        </label>
        {hasDescription && (
          <span id={descriptionId} className="ui-field-description">
            {description}
          </span>
        )}
      </div>
      <div className="ui-field-control">
        <FieldContext.Provider value={context}>{children}</FieldContext.Provider>
      </div>
    </div>
  );
}
