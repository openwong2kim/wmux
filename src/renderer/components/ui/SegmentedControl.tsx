import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { FOCUS_RING } from '../focusRing';
import { useFieldWiring } from './Field';

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  value: V;
  options: ReadonlyArray<SegmentOption<V>>;
  onValueChange: (value: V) => void;
  /** Accessible name of the group. Optional inside a Field, whose label names it. */
  ariaLabel?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * Single-choice segmented control, exposed as a radio group: one tab stop,
 * arrow keys move and select (skipping disabled options, wrapping), Home/End
 * jump to the ends. Full-round track with the active pill filled neutral.
 *
 * Disabled options use `aria-disabled`, not the native attribute, so they
 * stay focusable. That matters when `value` itself points at a disabled
 * option: the group still reports the truth (that option is checked), and the
 * tab stop stays on it rather than on an unchecked option, which would make a
 * screen reader announce the wrong choice. Arrow keys then leave it for the
 * enabled options; clicking a disabled option does nothing.
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
  const wiring = useFieldWiring();
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i !== -1);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const tabStop = selectedIndex !== -1 ? selectedIndex : enabled[0] ?? 0;

  const move = (from: number, e: KeyboardEvent<HTMLButtonElement>) => {
    if (enabled.length === 0) return;
    // From a disabled (but selected) option, step relative to its position.
    const after = enabled.find((i) => i > from) ?? enabled[0];
    const before = [...enabled].reverse().find((i) => i < from) ?? enabled[enabled.length - 1];
    let next: number | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = after;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = before;
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
      aria-labelledby={ariaLabel ? undefined : wiring.labelId}
      aria-describedby={wiring['aria-describedby']}
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
          aria-disabled={o.disabled || undefined}
          tabIndex={i === tabStop ? 0 : -1}
          className={`ui-segment ${FOCUS_RING}`}
          onClick={() => {
            if (!o.disabled) onValueChange(o.value);
          }}
          onKeyDown={(e) => move(i, e)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
