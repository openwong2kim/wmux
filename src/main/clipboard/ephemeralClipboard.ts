/**
 * A clipboard entry that must not outlive what it grants — a computer
 * pairing link. Owned by the MAIN process, not the popover, so it survives
 * the renderer remounting the sidebar (Sidebar ↔ MiniSidebar), a closed
 * popover and a reload, and is still cleared when the app quits.
 *
 * Every clear is conditional: the clipboard is emptied only if it still holds
 * exactly the text this module put there. Anything the operator copied since
 * is theirs and is left alone.
 */
export interface EphemeralClipboardDeps {
  readText: () => string;
  writeText: (text: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Longest a held entry may live, whatever the caller asked for. */
const MAX_TTL_MS = 60 * 60 * 1000;

export class EphemeralClipboard {
  private held: { text: string; timer: unknown } | null = null;
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

  /** Write `text` and take it back off after `ttlMs` (if still there). */
  write(text: string, ttlMs: number): void {
    this.forget();
    this.deps.writeText(text);
    const ms = Math.max(0, Math.min(ttlMs, MAX_TTL_MS));
    this.held = { text, timer: this.setTimer(() => this.clear(), ms) };
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
    this.clear();
  }

  /** Clear the held text if the clipboard still has it (expiry, quit). */
  clear(): void {
    const held = this.held;
    this.forget();
    if (!held) return;
    try {
      if (this.deps.readText() === held.text) this.deps.writeText('');
    } catch {
      /* clipboard busy — nothing more can be done at this point */
    }
  }

  private forget(): void {
    if (this.held) this.clearTimer(this.held.timer);
    this.held = null;
  }
}
