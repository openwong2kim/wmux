import { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/xterm';
import { isWongttyTerminal } from './load';

interface WongttySnapshotTerminal {
  ansiSnapshot(options: { scrollback: number; excludeModes: boolean }): { ok: true; payload: Uint8Array } | { ok: false; reason: string };
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
      const painted = snapshot.ansiSnapshot({ scrollback, excludeModes: true });
      if (painted.ok) {
        console.warn(`[wmux:engine-swap] wongtty cannot carry this screen's modes (${full.reason}); the new terminal takes its text and colours only`);
        return new TextDecoder().decode(painted.payload);
      }
      console.warn(`[wmux:engine-swap] wongtty cannot serialize this screen (${painted.reason}); the new terminal takes its plain text`);
      return plainText(terminal, scrollback);
    }
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);
    try {
      return addon.serialize({ scrollback }) + xtermMouseEncoding(terminal);
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
  const encoding = (terminal as unknown as { _core?: { mouseStateService?: { activeEncoding?: string } } })._core?.mouseStateService?.activeEncoding;
  return (encoding && MOUSE_ENCODING_MODES[encoding]) ?? '';
}

/** The newest `scrollback` history lines and the screen as plain text, soft
 *  wraps joined so the new terminal wraps them again. */
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
  return out;
}
