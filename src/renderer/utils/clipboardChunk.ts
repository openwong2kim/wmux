/**
 * Helpers for safely streaming clipboard text into the PTY.
 *
 * Why this exists:
 *   xterm.js handles paste itself when its native paste event fires
 *   (`Clipboard.ts` normalizes CRLF and wraps in bracketed-paste markers
 *   when the foreground app enabled DECSET 2004). wmux intercepts Ctrl+V,
 *   right-click paste, and drag-drop directly so we can read from
 *   Electron's clipboard API (not the browser's, which is gated and racy).
 *   That bypasses xterm's paste pipeline, so this module re-implements the
 *   three guarantees a terminal paste needs:
 *
 *     1. **Newline normalization** — collapse \r\n / \n / \r to a single
 *        separator that depends on bracketed mode (see normalizePasteText):
 *        LF inside a bracketed body (the readline in-body separator — a lone
 *        CR there makes PSReadLine misplace the cursor and inject blank
 *        space, the "multiline paste adds whitespace" bug), CR otherwise
 *        (each line is an Enter). An unnormalized \r\n boundary used to
 *        execute the first line mid-paste and strand the rest — the "front
 *        of paste disappears" symptom.
 *
 *     2. **UTF-16 surrogate safety** — never split an astral codepoint
 *        (emoji, CJK supplementary) across two chunks. UTF-16 high
 *        surrogates land at code-unit boundaries 0xD800-0xDBFF; if the
 *        chunk boundary falls between high and low surrogate, the
 *        chunked write produces a broken (`�`) character on the wire.
 *
 *     3. **IPC pacing** — yield to the event loop between chunks so the
 *        conpty input pipe drains. node-pty does not surface
 *        back-pressure to the JS layer (`IPty.write` is void), so a
 *        synchronous loop firing N IPC messages in one tick can overrun
 *        the ~64KB conpty pipe buffer on Windows.
 *
 *   The main process also enforces a 100KB silent backstop on `pty.write`
 *   (see `pty.handler.ts`) — chunking keeps us safely below that limit
 *   even when the user pastes a megabyte of log output.
 */

/** Maximum UTF-16 code units per `pty.write` call. Far below main's backstop. */
export const PTY_PASTE_CHUNK_SIZE = 4096;

/**
 * Lower threshold for `onData`-originated payloads worth chunking. Normal
 * keystrokes — even multi-byte IME commits or escape sequences — fit in
 * well under 256 units; anything larger is almost certainly a paste that
 * leaked through xterm's native paste path and should be chunked + paced.
 */
export const ONDATA_CHUNK_THRESHOLD = 1024;

/** Minimal subset of xterm's `Terminal.modes` we read for paste behavior. */
export interface TerminalModesLike {
  bracketedPasteMode?: boolean;
}

/** Wire pty write callback — kept narrow to make tests trivial to set up. */
export type PtyWriteFn = (data: string) => void;

/**
 * Normalize line endings in pasted text for the PTY wire. The correct
 * separator depends on whether the foreground app enabled bracketed paste
 * (DECSET 2004):
 *
 *   - NON-bracketed (`bracketed=false`, default): collapse every line break
 *     to a single CR. Each line is meant as an Enter, and every interactive
 *     shell (PowerShell, cmd, bash, zsh, fish) accepts CR as Enter via its
 *     line discipline. (Lone `\n` from *nix/WSL clipboards also becomes CR.)
 *
 *   - BRACKETED (`bracketed=true`): collapse to LF. Inside a bracket pair the
 *     body is INSERTED into the line editor, not executed, so the separator
 *     must be the readline in-body separator (LF) — NOT Enter. PSReadLine
 *     (and bash/zsh/fish readline) misplace the cursor and inject blank
 *     lines when they receive a lone CR as the in-body separator: the
 *     "multiline paste adds whitespace" bug (PSReadLine #3939, #417 — both
 *     recommend LF). Verified against real pwsh 7.6 / PSReadLine 2.4.5
 *     (scripts/paste-repro.cjs): a CR body splits the command line-by-line,
 *     an LF body buffers it as one multiline command.
 *
 * NOTE: this intentionally diverges from xterm.js, which normalizes to CR in
 * BOTH modes (xterm Clipboard.ts `prepareTextForTerminal`). wmux bypasses
 * xterm's paste pipeline (it reads Electron's clipboard directly for Ctrl+V /
 * right-click / drag-drop), so we own this choice and pick the separator that
 * actually works for the bracketed insert path.
 */
export function normalizePasteText(text: string, bracketed = false): string {
  if (!text) return text;
  return text.replace(/\r\n|\r|\n/g, bracketed ? '\n' : '\r');
}

/**
 * Split `text` into chunks of at most `size` UTF-16 code units, never
 * splitting a surrogate pair across a boundary. Returns chunks in order.
 *
 * UTF-16 represents codepoints U+10000 and above (most emoji, CJK
 * supplementary, mathematical alphanumerics) as a surrogate pair: one
 * high surrogate (0xD800-0xDBFF) followed by one low surrogate
 * (0xDC00-0xDFFF). Splitting between them produces two lone surrogates,
 * which the receiving shell renders as the U+FFFD replacement character.
 * That is functionally indistinguishable from a "the paste lost some
 * characters" bug from the user's perspective.
 */
export function splitSurrogateSafe(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    // If the would-be last code unit is a high surrogate and there is at
    // least one more code unit after it, back off by one so the pair
    // stays together. The deferred low surrogate joins the next chunk.
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Yield control to the event loop so queued IPC writes can drain and the
 * conpty input pipe can be read by the shell. `setTimeout(0)` is the
 * renderer-side equivalent of Node's `setImmediate` — both relinquish the
 * current macrotask. We use a 0ms timeout rather than `queueMicrotask`
 * because microtasks would re-enter before the IPC dispatch macrotask had
 * a chance to send our previous chunk.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Stream `text` into the PTY using `PTY_PASTE_CHUNK_SIZE` chunks.
 *
 * Async: yields to the event loop between chunks so the IPC queue and
 * conpty input pipe drain — without yielding, a 100KB paste can saturate
 * the conpty 64KB buffer and the kernel will start discarding writes.
 *
 * When bracketed paste mode is active, wraps the stream with the standard
 * CSI markers so the foreground app receives one logical paste even when
 * the body crosses several chunk boundaries. Markers are written
 * synchronously next to the surrounding chunks (no yield between marker
 * and first/last chunk) so a fast Ctrl+V repeat cannot interleave two
 * paste streams between marker and body.
 *
 * Newlines are normalized before chunking per bracketed mode (LF in-body
 * when bracketed, CR otherwise — see `normalizePasteText`). When bracketed,
 * raw ESC bytes in the body are also sanitized to U+241B so a pasted
 * `\x1b[201~` cannot forge the close marker and run the trailing bytes as a
 * command (paste injection).
 */
export async function pastePtyChunked(
  write: PtyWriteFn,
  text: string,
  modes?: TerminalModesLike | null,
): Promise<void> {
  if (!text) return;

  const bracketed = !!modes?.bracketedPasteMode;
  let normalized = normalizePasteText(text, bracketed);
  // ESC sanitize (paste-injection guard): inside a bracketed body a raw ESC
  // could forge the \x1b[201~ close marker and run the trailing bytes as a
  // command. Replace it with the visible symbol U+241B, matching xterm's
  // bracketTextForPaste. Length-preserving (1 unit → 1 unit), so the chunk
  // boundaries and surrogate-pair safety below are unaffected.
  if (bracketed) normalized = normalized.replaceAll(String.fromCharCode(0x1b), '␛');
  const size = PTY_PASTE_CHUNK_SIZE;

  // Fast path: short payload + bracketed mode → single write keeps the wire
  // traffic minimal, prevents any marker/body race, and matches the prior
  // code's semantics for the common-case command paste.
  if (bracketed && normalized.length <= size) {
    write(`\x1b[200~${normalized}\x1b[201~`);
    return;
  }

  // Fast path: short payload, no bracketed mode → single write, no yield.
  if (!bracketed && normalized.length <= size) {
    write(normalized);
    return;
  }

  const chunks = splitSurrogateSafe(normalized, size);

  if (bracketed) write('\x1b[200~');
  for (let i = 0; i < chunks.length; i++) {
    write(chunks[i]);
    // Yield between chunks (but not after the last one — no point).
    if (i < chunks.length - 1) await yieldToEventLoop();
  }
  if (bracketed) write('\x1b[201~');
}

/**
 * Route an `onData`-originated payload through the paste chunker when the
 * length suggests it is a paste that leaked through xterm.js's native
 * paste pipeline (Shift+Insert, OS menu paste, middle-click on Linux).
 * Normal keystrokes — single chars, escape sequences, IME commits —
 * stay on the direct fast path.
 *
 * If xterm has already wrapped the payload in bracketed-paste markers
 * (foreground app enabled DECSET 2004), the markers are stripped before
 * chunking and re-applied around the chunked body so the markers remain
 * atomic with the data they wrap.
 */
export async function chunkOnDataIfNeeded(
  write: PtyWriteFn,
  data: string,
): Promise<void> {
  if (data.length <= ONDATA_CHUNK_THRESHOLD) {
    write(data);
    return;
  }

  // Detect xterm-applied bracketed paste wrapping so we can keep markers
  // atomic with the body when re-chunking. The markers are exactly 6 code
  // units each: ESC [ 2 0 0 ~ and ESC [ 2 0 1 ~.
  const hasOpen = data.startsWith('\x1b[200~');
  const hasClose = data.endsWith('\x1b[201~');
  let inner = data;
  if (hasOpen) inner = inner.slice(6);
  if (hasClose) inner = inner.slice(0, -6);

  // If we detected a wrap, treat as bracketed regardless of the terminal's
  // current mode (the foreground app already received the open marker
  // intent from xterm).
  const modes: TerminalModesLike | null = hasOpen || hasClose
    ? { bracketedPasteMode: true }
    : null;

  await pastePtyChunked(write, inner, modes);
}
