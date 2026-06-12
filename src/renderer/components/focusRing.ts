/**
 * Keyboard-visible focus indicator for interactive controls. wmux is a
 * keyboard-first developer tool, so every interactive control needs one.
 * Extracted from SettingsPanel (PR #150) so sidebar and future components
 * share the same ring. Applied via className so it composes with inline
 * color styles.
 */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-blue)] focus-visible:ring-offset-1 focus-visible:ring-offset-[color:var(--bg-base)]';
