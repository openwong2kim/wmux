import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { FOCUS_RING } from '../focusRing';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  value: V;
  options: ReadonlyArray<SegmentOption<V>>;
  onValueChange: (value: V) => void;
  /** Accessible name of the group (required: segments alone do not say what they choose). */
  ariaLabel: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * Single-choice segmented control, exposed as a radio group: one tab stop
 * (the selected segment), arrow keys move and select, Home/End jump to the
 * ends. Recessed track with the active segment raised.
 */
export default function SegmentedControl<V extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  className = '',
  'data-testid': testId,
}: SegmentedControlProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i !== -1);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const tabStop = selectedIndex !== -1 && !options[selectedIndex].disabled ? selectedIndex : enabled[0];

  const move = (from: number, e: KeyboardEvent<HTMLButtonElement>) => {
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(from);
    let next: number | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(pos + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onValueChange(options[next].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`ui-segmented${className ? ` ${className}` : ''}`}
      data-testid={testId}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === tabStop ? 0 : -1}
          disabled={o.disabled}
          className={`ui-segment ${FOCUS_RING}`}
          onClick={() => onValueChange(o.value)}
          onKeyDown={(e) => move(i, e)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
