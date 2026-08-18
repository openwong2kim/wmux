/* Kitty keyboard-protocol negotiation for the wmux web browser terminal.
 *
 * A browser terminal is a viewer: it sends Shift+Enter as the CSI-u byte
 * `\x1b[13;2u`, but that byte only means "newline" to an app that asked for
 * kitty encodings. A viewer never negotiated with the app it watches, and an
 * app that did not ask reads it as ESC followed by `[13;2u` — in vim's insert
 * mode that leaves insert and runs the rest as normal-mode input (where `u` is
 * undo). The desktop hit the same wall for its attach mirror and solved it in
 * `keyboardProtocol.ts` + `mirrorInput.ts` (#924); this is that solution
 * ported to the browser.
 *
 * xterm parses DECSET 2004 for us (`term.modes.bracketedPasteMode`) but
 * exposes nothing about keyboard protocols, so we watch the pane's own output
 * for the two negotiations that matter — same idea as the bracketed-paste
 * read, one layer lower.
 *
 * Deliberately conservative: unknown state means NOT negotiated, so the
 * browser falls back to what xterm would have encoded — the behaviour before
 * any of this existed. A missed negotiation costs a convenience; a false
 * positive corrupts an editing session.
 *
 * Pure on purpose, so the state machine can be tested without a DOM, xterm,
 * or a real browser — the same split `copyPasteKeys.js` / `touchScroll.js`
 * use. Builds inline this file into terminal.html via
 * scripts/build-daemon-web.mjs and publishes `wmuxKeyboardProtocol` on the
 * global for app.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.wmuxKeyboardProtocol = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  // Built via RegExp(...) with a hex escape so the source stays pure-ASCII
  // while still matching ESC at runtime — mirrors keyboardProtocol.ts.
  /* eslint-disable no-control-regex */
  var KITTY_PUSH_OR_SET = new RegExp('\\x1b\\[[>=](\\d*)(?:;\\d+)?u', 'g');
  var KITTY_POP = new RegExp('\\x1b\\[<\\d*u', 'g');
  var MODIFY_OTHER_KEYS = new RegExp('\\x1b\\[>4;([0-2])m', 'g');
  /* eslint-enable no-control-regex */

  var INITIAL_STATE = { kitty: false, modifyOtherKeys: 0 };

  /**
   * Fold one chunk of pane output into the keyboard state.
   *
   * Pure: takes the previous state, returns the next one. A chunk that says
   * nothing about keyboards returns the same object, so callers can compare by
   * reference to skip work.
   *
   * A sequence split across two chunks is missed. That is the conservative
   * direction (no negotiation seen → send the legacy byte) and the alternative
   * — carrying a partial-sequence buffer — would have to be correct about every
   * escape shape to avoid holding bytes forever.
   *
   * @param {{kitty: boolean, modifyOtherKeys: number}} prev
   * @param {Uint8Array|string} bytes pane output bytes (or latin1 string).
   * @returns the next state (same reference when nothing changed).
   */
  function foldRemoteKeyboardState(prev, bytes) {
    // Pane bytes are raw; a latin1 view is exact for these pure-ASCII
    // sequences and cannot corrupt what xterm receives (we never write this
    // string back).
    var chunk = typeof bytes === 'string'
      ? bytes
      : Array.from(bytes, function (b) { return String.fromCharCode(b); }).join('');
    if (chunk.indexOf('\x1b[') < 0) return prev;

    var kitty = prev.kitty;
    var modifyOtherKeys = prev.modifyOtherKeys;
    var events = [];

    // Walk in order so a push followed by a pop inside one chunk lands on the
    // later one rather than on whichever regex ran last.
    KITTY_PUSH_OR_SET.lastIndex = 0;
    var m;
    while ((m = KITTY_PUSH_OR_SET.exec(chunk)) !== null) {
      var flags = m[1] === '' ? 0 : Number(m[1]);
      events.push({ index: m.index, apply: function () { kitty = flags > 0; } });
    }
    KITTY_POP.lastIndex = 0;
    while ((m = KITTY_POP.exec(chunk)) !== null) {
      events.push({ index: m.index, apply: function () { kitty = false; } });
    }
    MODIFY_OTHER_KEYS.lastIndex = 0;
    while ((m = MODIFY_OTHER_KEYS.exec(chunk)) !== null) {
      var level = Number(m[1]);
      events.push({ index: m.index, apply: function () { modifyOtherKeys = level; } });
    }

    if (events.length === 0) return prev;
    events.sort(function (a, b) { return a.index - b.index; });
    for (var i = 0; i < events.length; i++) events[i].apply();

    var changed = kitty !== prev.kitty || modifyOtherKeys !== prev.modifyOtherKeys;
    return changed ? { kitty: kitty, modifyOtherKeys: modifyOtherKeys } : prev;
  }

  /**
   * Whether the pane will understand the CSI-u bytes we encode ourselves.
   *
   * Only kitty. modifyOtherKeys mode 2 wants `CSI 27 ; ... ~` instead, so
   * sending CSI-u there would be the same category of mistake this file exists
   * to prevent.
   *
   * @param {{kitty: boolean}} state the current keyboard state.
   * @returns {boolean} true when CSI-u is safe to send.
   */
  function acceptsCsiU(state) {
    return state.kitty;
  }

  return {
    INITIAL_STATE: INITIAL_STATE,
    foldRemoteKeyboardState: foldRemoteKeyboardState,
    acceptsCsiU: acceptsCsiU
  };
});
