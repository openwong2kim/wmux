/* Copy / paste / newline key decisions for the wmux web browser terminal.
 *
 * A browser terminal is a viewer first: every key belongs to the pane it
 * watches, and anything this side keeps is a deliberate exception — the
 * editing conveniences that operate on LOCAL state (the selection and the
 * clipboard) rather than the remote pane. This mirrors what #924 added to the
 * desktop attach mirror (`mirrorInput.ts`), adapted for a browser: the
 * decision is pure, and app.js owns the clipboard, the socket, and xterm.
 *
 * Pure on purpose, so the table can be tested without a DOM, xterm, or a real
 * browser — the same split `touchScroll.js` / `pairQuery.js` already use.
 * Builds inline this file into terminal.html via scripts/build-daemon-web.mjs
 * and publishes `wmuxWebKeys` on the global for app.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.wmuxWebKeys = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * A key chord matched by BOTH `key` and physical `code`. Under a CJK IME
   * `key` is a composed jamo or the literal 'Process', so a `key`-only test
   * silently stops matching — the exact failure useTerminal.ts documents for
   * its own Ctrl+C branch, and the reason every clipboard chord here carries a
   * `code` fallback (same rationale as #924's mirrorInput).
   */
  function isLetter(e, lower, code) {
    return e.key === lower || e.key === lower.toUpperCase() || e.code === code;
  }

  /**
   * Decide what a keydown means for a browser terminal.
   *
   * @param ev KeyboardEvent-like ({ type, key, code, ctrlKey, shiftKey, altKey,
   *            metaKey, isComposing })
   * @param opts { isMac, hasSelection, readOnly }
   * @returns null to pass through to xterm/browser; or
   *          { action: 'copy' } — copy the selection to the clipboard;
   *          { action: 'newline', data } — send the newline byte to the pane;
   *          { action: 'swallow' } — consume the key, do nothing.
   */
  function decideWebKey(ev, opts) {
    if (ev.type !== 'keydown') return null;
    var isMac = !!opts.isMac;
    var hasSelection = !!opts.hasSelection;
    var readOnly = !!opts.readOnly;

    // Shift+Enter → CSI u (`ESC [ 13 ; 2 u`): kitty-protocol apps (Claude Code,
    // codex) insert a newline instead of submitting. Same byte #924's mirror
    // sends; a read-only host takes nothing.
    if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.isComposing) {
      return readOnly ? { action: 'swallow' } : { action: 'newline', data: '\x1b[13;2u' };
    }

    // Ctrl+Enter → LF, same "insert newline, don't submit" intent as Ctrl+J.
    // xterm sends a bare CR for Ctrl+Enter — indistinguishable from plain Enter
    // — so emit LF ourselves so an in-pane TUI adds a line instead of
    // submitting. (newlineKeys.ts, moved here verbatim in spirit.)
    if (ev.key === 'Enter' && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && !ev.isComposing) {
      return readOnly ? { action: 'swallow' } : { action: 'newline', data: '\n' };
    }

    // Ctrl+J → LF. Keyed on the physical KeyJ so it survives a CJK IME where
    // `key`/`keyCode` are mangled to 'Process' and xterm's keyCode-based
    // Ctrl+<letter> path would otherwise drop the keystroke.
    if (ev.code === 'KeyJ' && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && !ev.isComposing) {
      return readOnly ? { action: 'swallow' } : { action: 'newline', data: '\n' };
    }

    var bareMeta = ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey;
    var bareCtrl = ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey;
    var ctrlShift = ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;

    // macOS: ⌘C copies and ⌘V pastes, so Ctrl+C stays SIGINT unconditionally.
    // ⌘V is left to the browser's own paste path (xterm's textarea handles it).
    if (isMac && bareMeta && isLetter(ev, 'c', 'KeyC')) {
      return hasSelection ? { action: 'copy' } : null;
    }
    if (isMac && bareMeta && isLetter(ev, 'v', 'KeyV')) return null;

    // Windows/Linux: Ctrl+C copies ONLY when there is a selection. With an
    // empty selection it must still interrupt the remote process — the whole
    // point of the key, and #895 asks for the selection case, not for SIGINT to
    // be taken away.
    if (!isMac && bareCtrl && isLetter(ev, 'c', 'KeyC')) {
      return hasSelection ? { action: 'copy' } : null;
    }
    // Ctrl+V on Windows/Linux: xterm's keydown path ENCODES Ctrl+V as the SYN
    // control byte (\x16) and preventDefaults — the browser's native paste
    // event never fires, so "leave it to the browser" silently does nothing.
    // Returning { action: 'paste' } makes app.js return false, which xterm
    // treats as "do not process this key": it neither sends \x16 nor
    // preventDefaults, so the browser's own Ctrl+V paste lands on the focused
    // xterm textarea and xterm's native paste listener feeds it to the PTY.
    // That path works on cleartext pages too — native paste is a browser
    // default, not a secure-context API. (macOS ⌘V above is already left to
    // the browser and works, because xterm never intercepts a bare meta key.)
    if (!isMac && bareCtrl && isLetter(ev, 'v', 'KeyV')) return { action: 'paste' };
    // Ctrl+D on Windows/Linux: the desktop maps it to split-right, so it never
    // reaches the PTY — but xterm would encode it as EOF (\x04), exiting the
    // shell and "closing" the pane on a key the user pressed by accident.
    // App.js swallows it (preventDefault + do nothing), so an errant Ctrl+D
    // can never kill a browser pane or trigger a browser action.
    if (!isMac && bareCtrl && isLetter(ev, 'd', 'KeyD')) return { action: 'swallow' };

    // Ctrl+Shift+C — the explicit copy form, on every platform. With no
    // selection it is swallowed rather than forwarded (there is nothing to copy
    // and no meaningful remote meaning for it).
    if (ctrlShift && isLetter(ev, 'c', 'KeyC')) {
      return hasSelection ? { action: 'copy' } : { action: 'swallow' };
    }

    return null;
  }

  return { decideWebKey: decideWebKey };
});
