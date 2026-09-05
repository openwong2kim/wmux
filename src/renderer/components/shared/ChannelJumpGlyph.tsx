// ─── Channel jump glyph — the `#` that opens a task's channel ────────────────
//
// The audit's reading of the sidebar task rows: a bare `#` at the end of a row,
// 6px wide and 15px tall, in the same muted grey as the row's own text. It
// communicates nothing — not that it is a control, not where it goes — and it
// is the smallest target in the window.
//
// This is the shared shape of that affordance, extracted so the task rows in
// MissionsSection (and anywhere else a row needs to reach its channel) adopt
// ONE control rather than each growing its own:
//   - a real 24px hit box on the same 6px glyph (hitArea.ts);
//   - a tooltip AND an accessible name, both from the existing `missions.*`
//     keys — the name carries the task's title, because a column of buttons all
//     announcing "Open task channel" cannot be told apart;
//   - the DESIGN.md jump grammar: steel-blue `--accent-blue` is navigation, and
//     a jump affordance is "muted at rest, accent on hover" — the same
//     treatment the deck's Fleet row `→` already uses.
//
// Not wired into the task rows here: those rows belong to another lane in this
// pass, and two lanes editing one JSX block is how a merge conflict is made.

import { HIT_TARGET_24_TIGHT } from '../hitArea';
import { FOCUS_RING } from '../focusRing';

export interface ChannelJumpGlyphProps {
  /** Open the channel. The caller owns the routing (`setActiveChannel`). */
  onOpen: () => void;
  /**
   * What the channel belongs to — a task title. Present, the accessible name
   * becomes "Open task channel for {title}"; absent, the plain verb.
   */
  name?: string;
  /** Translator. Passed in so the glyph stays a pure, testable component. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Extra layout classes from the row (e.g. `flex-shrink-0`). */
  className?: string;
}

export default function ChannelJumpGlyph({
  onOpen,
  name,
  t,
  className = '',
}: ChannelJumpGlyphProps): React.ReactElement {
  const tooltip = t('missions.openChannel');
  const ariaLabel = name ? t('missions.openChannelFor', { title: name }) : tooltip;
  return (
    <button
      type="button"
      data-channel-jump
      onClick={(e) => {
        // Rows are usually clickable themselves (jump to the pane); opening the
        // channel must not also do that.
        e.stopPropagation();
        onOpen();
      }}
      title={tooltip}
      aria-label={ariaLabel}
      className={`${HIT_TARGET_24_TIGHT} ${FOCUS_RING} text-[10px] font-mono text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors ${className}`}
    >
      <span aria-hidden="true">#</span>
    </button>
  );
}
