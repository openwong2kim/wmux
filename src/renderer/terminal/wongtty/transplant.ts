import { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/xterm';
import { isWongttyTerminal } from './load';

interface WongttySnapshotTerminal {
  ansiSnapshot(options: { scrollback: number; excludeModes: boolean }): { ok: true; payload: Uint8Array } | { ok: false; reason: string };
}

/**
 * The whole terminal (scrollback, screen and modes) for a local-mode engine
 * swap of the Labs wongtty switch (useTerminal), where no daemon can replay the
 * session into the new terminal; null when the engine cannot serialize it.
 * The browser build has no engine swap and stubs this module.
 */
export function serializeForTransplant(terminal: Terminal, scrollback: number): string | null {
  try {
    if (isWongttyTerminal(terminal)) {
      const snapshot = (terminal as unknown as WongttySnapshotTerminal).ansiSnapshot({ scrollback, excludeModes: false });
      if (!snapshot.ok) {
        console.warn(`[wmux:engine-swap] wongtty cannot serialize this screen (${snapshot.reason}); the new terminal starts empty`);
        return null;
      }
      return new TextDecoder().decode(snapshot.payload);
    }
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);
    try {
      return addon.serialize({ scrollback });
    } finally {
      addon.dispose();
    }
  } catch (err) {
    console.warn('[wmux:engine-swap] could not serialize the terminal; the new terminal starts empty', err);
    return null;
  }
}
