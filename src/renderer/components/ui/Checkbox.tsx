import { forwardRef } from 'react';
import { IconCheck } from '../icons';
import { useToggleButtonProps } from './toggleControl';
import type { ToggleControlProps } from './toggleControl';

export type CheckboxProps = ToggleControlProps;

/**
 * Checkbox (`role="checkbox"`) drawn with theme tokens instead of the native
 * OS box. Space toggles (the ARIA checkbox key); Enter does not, matching a
 * native checkbox. Inside a Field it is labelled and described by the row.
 */
const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(props, ref) {
  const buttonProps = useToggleButtonProps('checkbox', 'ui-checkbox', props, [' ']);
  return (
    <button ref={ref} {...buttonProps}>
      <IconCheck size={12} />
    </button>
  );
});

export default Checkbox;
