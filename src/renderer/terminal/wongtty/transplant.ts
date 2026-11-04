import { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/xterm';
import { isWongttyTerminal } from './load';

interface WongttySnapshotTerminal {
  ansiSnapshot(options: { scrollback: number; excludeModes: boolean }): { ok: true; payload: Uint8Array } | { ok: false; reason: string };
}

/** What xterm.js keeps out of its public API that a carried terminal needs. */
interface XtermInternals {
  _core?: {
    mouseStateService?: { activeEncoding?: string };
    coreService?: { decPrivateModes?: { cursorStyle?: 'block' | 'underline' | 'bar'; cursorBlink?: boolean } };
    buffer?: { scrollTop?: number; scrollBottom?: number };
  };
}

/**
 * The whole terminal (scrollback, screen and modes) for an engine swap of the
 * Labs wongtty switch (useTerminal): in local mode, where no daemon can replay
 * the session into the new terminal, and in daemon mode as the fallback when
 * that replay fails. null when the engine cannot serialize it.
 * The browser build has no engine swap and stubs this module.
 */
export function serializeForTransplant(terminal: Terminal, scrollback: number): string | null {
  try {
    if (isWongttyTerminal(terminal)) {
      const snapshot = terminal as unknown as WongttySnapshotTerminal;
      const full = snapshot.ansiSnapshot({ scrollback, excludeModes: false });
      if (full.ok) return new TextDecoder().decode(full.payload);
      // Scroll margins (a TUI's DECSTBM) or an overlong unfinished sequence:
      // the screen and scrollback still come over, without the modes.
      // The modes go back from the terminal's own `modes`; its scroll
      // margins, mouse report encoding and cursor shape have no public reader
      // and stay behind.
      const painted = snapshot.ansiSnapshot({ scrollback, excludeModes: true });
      if (painted.ok) {
        console.warn(`[wmux:engine-swap] wongtty cannot carry this screen whole (${full.reason}); the new terminal takes its text, colours and modes, not its scroll margins`);
        return new TextDecoder().decode(painted.payload) + publicModes(terminal);
      }
      console.warn(`[wmux:engine-swap] wongtty cannot serialize this screen (${painted.reason}); the new terminal takes its plain text and modes`);
      return plainText(terminal, scrollback) + publicModes(terminal);
    }
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);
    try {
      return addon.serialize({ scrollback }) + xtermMouseEncoding(terminal) + xtermCursorStyle(terminal) + xtermCursorAfterMargins(terminal);
    } finally {
      addon.dispose();
    }
  } catch (err) {
    console.warn('[wmux:engine-swap] could not serialize the terminal; the new terminal starts empty', err);
    return null;
  }
}

// SerializeAddon writes the mouse tracking mode but not the encoding of the
// reports (SGR, SGR pixels), which a TUI that asked for SGR cannot read
// without.
const MOUSE_ENCODING_MODES: Record<string, string> = { SGR: '\x1b[?1006h', SGR_PIXELS: '\x1b[?1016h' };

/** The mode that selects xterm.js's mouse report encoding, or '' for the default. */
function xtermMouseEncoding(terminal: Terminal): string {
  const encoding = (terminal as unknown as XtermInternals)._core?.mouseStateService?.activeEncoding;
  return (encoding && MOUSE_ENCODING_MODES[encoding]) ?? '';
}

const CURSOR_SHAPES = ['block', 'underline', 'bar'] as const;

/** DECSCUSR for the cursor shape a program set, which SerializeAddon leaves
 *  out; '' while the program set none. */
function xtermCursorStyle(terminal: Terminal): string {
  const modes = (terminal as unknown as XtermInternals)._core?.coreService?.decPrivateModes;
  const shape = modes?.cursorStyle ? CURSOR_SHAPES.indexOf(modes.cursorStyle) : -1;
  return shape < 0 ? '' : `\x1b[${shape * 2 + (modes?.cursorBlink ? 1 : 2)} q`;
}

/** SerializeAddon places the cursor, then writes origin mode and the scroll
 *  margins, and both of those home it: put it back where it was. */
function xtermCursorAfterMargins(terminal: Terminal): string {
  const buffer = (terminal as unknown as XtermInternals)._core?.buffer;
  const top = buffer?.scrollTop ?? 0;
  const margins = top !== 0 || (buffer?.scrollBottom ?? terminal.rows - 1) !== terminal.rows - 1;
  const origin = terminal.modes.originMode;
  if (!margins && !origin) return '';
  const active = terminal.buffer.active;
  return `\x1b[${active.cursorY - (origin ? top : 0) + 1};${active.cursorX + 1}H`;
}

/** The modes `terminal.modes` reports, as SerializeAddon writes them, and the
 *  cursor put back where origin mode moved it from. */
function publicModes(terminal: Terminal): string {
  const m = terminal.modes;
  let out = '';
  if (m.applicationCursorKeysMode) out += '\x1b[?1h';
  if (m.applicationKeypadMode) out += '\x1b[?66h';
  if (m.bracketedPasteMode) out += '\x1b[?2004h';
  if (m.insertMode) out += '\x1b[4h';
  if (m.sendFocusMode) out += '\x1b[?1004h';
  if (m.wraparoundMode === false) out += '\x1b[?7l';
  const mouse = { x10: '\x1b[?9h', vt200: '\x1b[?1000h', drag: '\x1b[?1002h', any: '\x1b[?1003h', none: '' }[m.mouseTrackingMode] ?? '';
  out += mouse;
  if (!m.showCursor) out += '\x1b[?25l';
  if (m.originMode) {
    const active = terminal.buffer.active;
    out += `\x1b[?6h\x1b[${active.cursorY + 1};${active.cursorX + 1}H`;
  }
  return out;
}

/** The newest `scrollback` history lines and the screen as plain text, soft
 *  wraps joined so the new terminal wraps them again, and the cursor put
 *  back where the output after the swap continues. */
function plainText(terminal: Terminal, scrollback: number): string {
  const buffer = terminal.buffer.active;
  const first = Math.max(0, buffer.length - terminal.rows - scrollback);
  let out = '';
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    if (y > first && !line.isWrapped) out += '\r\n';
    out += line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
  }
  return out + `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
}
