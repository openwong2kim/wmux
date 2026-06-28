import { useEffect } from 'react';
import { useStore } from '../stores';
import { terminalRegistry, copySelectionWithFeedback } from './useTerminal';
import { resolveActivePanePtyId } from './useActivePaneFocus';
import {
  resolveCopyTarget,
  type ActiveElementInfo,
  type TerminalSelectionSnapshot,
} from '../utils/resolveCopyTarget';

/**
 * Read a DOM-free snapshot of the focused element for `resolveCopyTarget`.
 *
 * `hasOwnSelection` distinguishes "the composer is focused but empty" (Ctrl+C
 * should copy the terminal selection) from "the composer is focused AND the
 * user selected text inside it" (its native copy must win). For input/textarea
 * that is `selectionStart !== selectionEnd`; for contenteditable it is a
 * non-collapsed, non-empty window selection. `selectionStart` throws / is null
 * on input types that don't support it (number, email, …) — guarded below.
 */
function readActiveElementInfo(active: Element | null): ActiveElementInfo | null {
  if (!active) return null;

  const tag = active.tagName;
  const isInputLike = tag === 'INPUT' || tag === 'TEXTAREA';
  const isContentEditable = (active as HTMLElement).isContentEditable === true;
  const isEditable = isInputLike || isContentEditable;

  let hasOwnSelection = false;
  if (isInputLike) {
    const el = active as HTMLInputElement | HTMLTextAreaElement;
    try {
      // selectionStart/End are null on inputs that don't support text
      // selection (type=number/email/…). `!= null` filters both.
      if (el.selectionStart != null && el.selectionEnd != null) {
        hasOwnSelection = el.selectionStart !== el.selectionEnd;
      }
    } catch {
      hasOwnSelection = false;
    }
  } else if (isContentEditable) {
    const sel = window.getSelection();
    hasOwnSelection = !!sel && !sel.isCollapsed && sel.toString().length > 0;
  }

  return {
    isXtermTextarea: active.classList.contains('xterm-helper-textarea'),
    isEditable,
    hasOwnSelection,
  };
}

/**
 * Focus-independent terminal Ctrl+C copy (fix B).
 *
 * RCA: xterm's own Ctrl+C copy handler (`useTerminal`'s
 * `attachCustomKeyEventHandler`) only runs while the terminal's hidden
 * `.xterm-helper-textarea` holds DOM focus. When the channel dock / composer
 * textarea owns focus, a user who drag-selects terminal text and presses Ctrl+C
 * gets total silence — the key lands on the empty composer, xterm never sees it,
 * so there is no copy, no `^C`, and no toast. The copy logic itself is fine; the
 * shortcut just never reaches it.
 *
 * This hook installs ONE document-level capture-phase keydown listener that, on
 * Ctrl+C, looks for a VISIBLE terminal holding a non-empty xterm selection and
 * copies it — but YIELDS (does nothing, leaving every existing path intact) when:
 *   • the keydown is an OS auto-repeat tick (a held Ctrl+C copies once),
 *   • focus is on a terminal's own helper textarea (xterm handles copy/SIGINT),
 *   • focus is on an editable element with its own selection (composer copy),
 *   • no VISIBLE terminal holds a selection (SIGINT `^C` must still fire) — an
 *     offscreen/unmounted terminal's stale selection is never a copy candidate.
 * The yield/act decision is the pure, fully-tested `resolveCopyTarget`; this
 * wrapper only feeds it the live DOM and acts on the verdict.
 *
 * Capture phase + `stopImmediatePropagation` ensure that when we DO copy, the
 * event is consumed before any focused field's native copy or the bubble-phase
 * focus self-heal in `useActivePaneFocus` reacts to it. The `code === 'KeyC'`
 * fallback mirrors the existing handlers so the shortcut survives a CJK IME,
 * where `e.key` is a composed jamo / 'Process' rather than 'c'.
 */
export function useTerminalCopyShortcut(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Plain Ctrl+C only — Shift/Alt/Meta combos are other shortcuts
      // (Ctrl+Shift+C copy fallback is owned by useTerminal). `code` fallback
      // keeps it working under a Hangul / non-Latin IME.
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      if (e.key !== 'c' && e.code !== 'KeyC') return;
      // Ignore OS key auto-repeat: a held Ctrl+C must copy / toast / consume the
      // event at most once, not fire on every repeat tick.
      if (e.repeat) return;

      // Yield to a genuine NATIVE selection of non-terminal DOM text (a channel
      // message body, the read-only editor <pre>, the roster, markdown). xterm
      // runs the WebGL renderer, so a terminal's own selection is canvas-drawn
      // and NEVER appears in window.getSelection(); therefore any non-empty
      // native selection is non-terminal text whose native copy must win.
      // Without this, a leftover xterm selection (auto-copy-on-select leaves the
      // highlight in place) makes Ctrl+C copy stale terminal text AND
      // preventDefault the real copy — silent wrong-clipboard in the very dock
      // this feature serves. The input/textarea selectionStart path below still
      // matters: those internal selections are NOT reflected here.
      const nativeSel = window.getSelection();
      if (nativeSel && !nativeSel.isCollapsed && nativeSel.toString().length > 0) return;

      // Snapshot every live terminal's current selection. getSelection() is
      // wrapped per-terminal so a mid-teardown (disposed) terminal can't throw
      // and kill the whole shortcut.
      const selections: TerminalSelectionSnapshot[] = [];
      for (const [ptyId, terminal] of terminalRegistry) {
        try {
          // Only VISIBLE terminals are copy candidates. A workspace/tab switch
          // can leave a terminal mounted-but-offscreen in the registry while it
          // still holds an old xterm selection; copying that stale, unseen
          // selection (clobbering the clipboard + toasting) is the consensus P2
          // bug. checkVisibility() is exact on Chromium (display:none /
          // visibility:hidden / disconnected / details-closed all count as
          // hidden); offsetParent is the fallback where it is unavailable.
          const el = terminal.element;
          const visible =
            !!el &&
            (typeof el.checkVisibility === 'function'
              ? el.checkVisibility()
              : el.offsetParent !== null);
          if (!visible) continue;
          selections.push({ ptyId, selection: terminal.getSelection() });
        } catch {
          // disposed / not-yet-ready terminal — skip it
        }
      }

      const target = resolveCopyTarget({
        selections,
        activePtyId: resolveActivePanePtyId(useStore.getState()),
        activeElement: readActiveElementInfo(document.activeElement),
      });
      if (!target) return; // yield — preserve copy / SIGINT / composer behavior

      // We own this keystroke: stop it before the focused field's native copy
      // or any other listener reacts, then copy with the shared feedback path.
      e.preventDefault();
      e.stopImmediatePropagation();
      void copySelectionWithFeedback(
        terminalRegistry.get(target.ptyId) ?? null,
        target.selection,
      );
    };

    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, []);
}
