import { terminalRegistry } from '../hooks/useTerminal';

/**
 * Read a pane's live xterm buffer to plaintext lines (trailing empty lines
 * popped). This is the SINGLE buffer-read path shared by the MCP
 * `input.readScreen` RPC and the Fleet View live-output tail, so the two can
 * never diverge in how they translate a buffer to text.
 *
 * NO `offsetWidth` / `isConnected` guard — see `scrollbackDump.ts:86` for the
 * guard that must NOT be copied here. AppLayout mounts every background pane
 * with `display:none`, so every inactive pane's xterm element reports
 * `offsetWidth === 0`; copying that guard would blank the tail for the entire
 * background fleet (i.e. the majority of cards). The buffer contents are valid
 * regardless of whether the element is laid out, so we read unconditionally,
 * gated only on the ptyId being present in the registry.
 */
export function readPtyBufferLines(ptyId: string): string[] {
  const terminal = terminalRegistry.get(ptyId);
  if (!terminal) return [];
  const buffer = terminal.buffer.active;
  const lastLine = buffer.baseY + buffer.cursorY;
  const lines: string[] = [];
  for (let i = 0; i <= lastLine && i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Last `n` non-empty plaintext lines of a pane's live buffer (the Fleet View
 * tail). `n <= 0` returns every line. A ptyId not in the registry yields `[]`.
 */
export function tailForPty(ptyId: string, n = 3): string[] {
  const lines = readPtyBufferLines(ptyId);
  return n > 0 ? lines.slice(-n) : lines;
}
