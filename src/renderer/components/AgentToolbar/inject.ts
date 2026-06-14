import { terminalRegistry } from '../../hooks/useTerminal';
import { pastePtyChunked, type TerminalModesLike } from '../../utils/clipboardChunk';

/** Quote any path containing a space; join with a single space. */
export function quotePathsForPrompt(paths: string[]): string {
  return paths.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
}

/** The ordered raw writes for a submit/no-submit inject. Pure, for testing. */
export function buildSubmitWrites(text: string, submit: boolean): string[] {
  return submit ? [text, '\r'] : [text];
}

/** Read the live terminal's bracketed-paste mode for this ptyId. */
function modesFor(ptyId: string): TerminalModesLike | null {
  const terminal = terminalRegistry.get(ptyId);
  const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } })?.modes;
  return modes ?? null;
}

/**
 * Inject text into the pane's PTY through the chunked paste path (bracketed-
 * paste safe, newline-normalized). When `submit` is true, follow with a single
 * CR to send it as one message.
 */
export async function injectText(ptyId: string, text: string, submit: boolean): Promise<void> {
  if (!ptyId || !text) return;
  const write = (d: string) => window.electronAPI.pty.write(ptyId, d);
  await pastePtyChunked(write, text, modesFor(ptyId));
  if (submit) write('\r');
}
