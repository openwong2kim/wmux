/**
 * Terminal cursor shape. Matches xterm.js `ITerminalOptions.cursorStyle`
 * so the Settings value can be passed through without a mapping table.
 *
 * Default is `block` — the historical xterm.js default and the shape
 * every existing install already shows. Invalid / absent session values
 * fall back here rather than throwing (session.json is hand-editable).
 */

export const TERMINAL_CURSOR_STYLES = ['block', 'bar', 'underline'] as const;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];
export const DEFAULT_TERMINAL_CURSOR_STYLE: TerminalCursorStyle = 'block';

export function isTerminalCursorStyle(value: unknown): value is TerminalCursorStyle {
  return value === 'block' || value === 'bar' || value === 'underline';
}

/** Coerce a session / IPC value. Anything else becomes the block default. */
export function sanitizeTerminalCursorStyle(value: unknown): TerminalCursorStyle {
  return isTerminalCursorStyle(value) ? value : DEFAULT_TERMINAL_CURSOR_STYLE;
}
