/** A headless xterm set up like the daemon's, for the Rust parity checks (no vitest import: bench/ uses it too). */
import { Terminal } from '@xterm/headless';
import { applyUnicodeWidthModel } from '../../shared/terminalUnicode';
import { XTERM_60_VT_EXTENSIONS } from '../../shared/terminal/replyParity';

export function snapshotTestTerminal(cols: number, rows: number, scrollback = 5000): Terminal {
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true, logLevel: 'off', vtExtensions: { ...XTERM_60_VT_EXTENSIONS } });
  applyUnicodeWidthModel(terminal);
  return terminal;
}

export async function writeTerminal(terminal: Terminal, bytes: string | Uint8Array): Promise<void> {
  await new Promise<void>(resolve => terminal.write(bytes, resolve));
}
