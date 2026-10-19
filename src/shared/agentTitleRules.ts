/**
 * The window-title glyphs agent CLIs show while a turn runs, kept in one place
 * for the daemon's chat gates and turn tracking and for main's title reader.
 * Pure (no Node/Electron deps): the renderer bundles titleDetect too.
 *
 * Claude Code (#2264, captured on 2.1.301) alternates `◐ <name>` / `◑ <name>`
 * about once a second for the whole turn (thinking, tools, streaming), reduced
 * motion included, and sets `✳ <name>` when the turn ends or is interrupted.
 * Codex puts a braille frame first (`⠙ <name> | <cwd>`) every ~100 ms and
 * drops it when the turn ends. Unlike a spinner row on screen, both stay up
 * while text streams.
 */

export const CLAUDE_RUNNING_TITLE = /^[◐◑]\s/;
/** The same spinner title as raw output carries it, inside its OSC 0/2 sequence. */
// eslint-disable-next-line no-control-regex
export const CLAUDE_RUNNING_TITLE_OSC = /\x1b\][02];[◐◑]\s/;
export const CLAUDE_IDLE_TITLE = /^✳\s/;
export const CODEX_RUNNING_TITLE = /^[⠁-⣿]\s/;

/** The running-spinner title per agent slug; an agent without one is absent. */
export const RUNNING_TITLE: ReadonlyMap<string, RegExp> = new Map([
  ['claude', CLAUDE_RUNNING_TITLE],
  ['codex', CODEX_RUNNING_TITLE],
]);

/** Codex while an approval box waits (`[ ! ] Action Required | <name> | <cwd>`,
 *  alternating with `[ . ]`, captured on 0.163.0). The question on screen can
 *  wrap or arrive in cursor-addressed pieces; the title stays whole. */
export const CODEX_AWAITING_TITLE = /^\[ [!.] \] Action Required\b/;

/** The waiting-on-a-human title per agent slug; an agent without one is absent. */
export const AWAITING_TITLE: ReadonlyMap<string, RegExp> = new Map([
  ['codex', CODEX_AWAITING_TITLE],
]);
