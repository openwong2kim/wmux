import { useCallback, useEffect, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';

/**
 * Floating "scroll to bottom" button. Appears at the bottom-right of the
 * terminal ONLY while the user is scrolled up (not following output) and
 * disappears the moment they are back at the bottom. Clicking jumps to the
 * latest output.
 *
 * Per DESIGN.md's "no dead gauges" rule: never a permanent overlay over the
 * terminal hero — the affordance exists exactly when scrollback has run far
 * ahead and is otherwise invisible.
 */
export default function ScrollToBottomButton({ terminal }: { terminal: Terminal | null }) {
  const t = useT();
  const [scrolledUp, setScrolledUp] = useState(false);

  const update = useCallback(() => {
    if (!terminal) {
      setScrolledUp(false);
      return;
    }
    // xterm: at the bottom means viewportY equals baseY (following output);
    // scrolled up means viewportY < baseY. Same relation the resize
    // preservation logic in useTerminal relies on.
    const { baseY, viewportY } = terminal.buffer.active;
    setScrolledUp(viewportY < baseY);
  }, [terminal]);

  // Re-evaluate on scroll, on new output (baseY grows / viewport shifts),
  // and on resize (rows change the at-bottom relation). Setting the same
  // boolean value is a no-op for React, so an output flood does not re-render.
  useEffect(() => {
    if (!terminal) return;
    update();
    const subs = [
      terminal.onScroll(update),
      terminal.onWriteParsed(update),
      terminal.onResize(update),
    ];
    return () => subs.forEach((d) => d.dispose());
  }, [terminal, update]);

  if (!terminal || !scrolledUp) return null;

  return (
    <button
      type="button"
      onClick={() => terminal.scrollToBottom()}
      title={t('terminal.scrollToBottom')}
      aria-label={t('terminal.scrollToBottom')}
      className={`absolute bottom-3 right-4 z-20 flex h-7 w-7 cursor-pointer items-center justify-center rounded-[5px] border bg-[color-mix(in_srgb,var(--bg-surface)_72%,transparent)] border-[color-mix(in_srgb,var(--text-main)_10%,transparent)] text-[var(--text-muted)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--text-main)_6%,transparent)] transition-colors hover:bg-[var(--bg-surface)] hover:border-[color-mix(in_srgb,var(--text-main)_16%,transparent)] hover:text-[var(--accent)] hover:shadow-[0_1px_3px_rgba(0,0,0,0.25)] ${FOCUS_RING}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 5.5 7 9l4-3.5" />
      </svg>
    </button>
  );
}