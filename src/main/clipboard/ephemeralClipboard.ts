/**
 * A clipboard entry that must not outlive what it grants — a computer
 * pairing link. Owned by the MAIN process, not the popover, so it survives
 * the renderer remounting the sidebar (Sidebar ↔ MiniSidebar), a closed
 * popover and a reload, and is still cleared when the app quits.
 *
 * Every clear is conditional: the clipboard is emptied only if it still holds
 * exactly the text this module put there. Anything the operator copied since
 * is theirs and is left alone.
 *
 * The clipboard is asynchronous, so writes and clears run one at a time, in
 * the order they were asked for: a clear still reading never empties a link
 * written after it.
 */
export interface EphemeralClipboardDeps {
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Longest a held entry may live, whatever the caller asked for. */
const MAX_TTL_MS = 60 * 60 * 1000;

export class EphemeralClipboard {
  private held: { text: string; timer: unknown } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: EphemeralClipboardDeps) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Write `text` and take it back off after `ttlMs` (if still there). A failed write rejects. */
  write(text: string, ttlMs: number): Promise<void> {
    return this.inTurn(async () => {
      this.forget();
      await this.deps.writeText(text);
      const ms = Math.max(0, Math.min(ttlMs, MAX_TTL_MS));
      this.held = { text, timer: this.setTimer(() => void this.clear(), ms) };
    });
  }

  /**
   * The renderer's word on which link still pairs anything (`''` = none).
   * A held link that is no longer it — consumed, cancelled, re-minted — is
   * cleared now rather than at its expiry. A held bundle (Connect a PC's
   * invite with the link on its own line) is kept while that line is live.
   */
  keepOnly(stillValid: string): void {
    if (!this.held) return;
    if (stillValid && this.held.text.split('\n').includes(stillValid)) return;
    void this.clear();
  }

  /** Clear the held text if the clipboard still has it (expiry, quit). Never rejects. */
  clear(): Promise<void> {
    return this.inTurn(async () => {
      const held = this.held;
      this.forget();
      if (!held) return;
      try {
        // Not atomic: the clipboard offers no compare-and-swap, so text another
        // app copies between this read and the write is cleared too. The window
        // is one asynchronous hop; a second read would narrow it, not close it.
        if ((await this.deps.readText()) === held.text) await this.deps.writeText('');
      } catch {
        /* clipboard busy — nothing more can be done at this point */
      }
    });
  }

  /** Run `step` after every step asked for before it. */
  private inTurn(step: () => Promise<void>): Promise<void> {
    const run = this.queue.then(step);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private forget(): void {
    if (this.held) this.clearTimer(this.held.timer);
    this.held = null;
  }
}
