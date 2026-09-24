import { forwardRef } from 'react';
import { useToggleButtonProps } from './toggleControl';
import type { ToggleControlProps } from './toggleControl';

export type SwitchProps = ToggleControlProps;

/**
 * On/off switch (`role="switch"`). Space and Enter toggle; inside a Field it
 * is labelled and described by the row. Neutral in both states: a dim track
 * when off, a light track with a dark knob when on (styles/ui.css).
 */
const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(props, ref) {
  const buttonProps = useToggleButtonProps('switch', 'ui-switch', props, [' ', 'Enter']);
  return (
    <button ref={ref} {...buttonProps}>
      <span className="ui-switch-knob" aria-hidden="true" />
    </button>
  );
});

export default Switch;
