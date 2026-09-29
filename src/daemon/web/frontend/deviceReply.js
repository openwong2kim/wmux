/* Terminal-generated device replies in the wmux web terminal.
 *
 * xterm (and the image addon) answer device queries BY THEMSELVES — DA1/DA2,
 * cursor and status reports, XTSMGRAPHICS, window size reports — and deliver
 * the answer through the same onData that carries typing. The queries come
 * from the pane's output, which is untrusted, and the machine that owns the
 * pane already has a terminal answering them. A viewer that forwarded its own
 * answer would type a second reply into the live shell. The repaint gate in
 * app.js only covers snapshot replay; this covers the live stream.
 *
 * Same shapes as the desktop remote mirror's `isDeviceReply`
 * (RemoteMirrorTerminal.tsx), plus the XTSMGRAPHICS reply (`CSI ? … S`) the
 * image addon adds. No key xterm encodes produces any of these: keys end in
 * `A`–`H`, `~`, `u` or a modified `P`–`S` without a `?`.
 *
 * Builds inline this file into terminal.html via scripts/build-daemon-web.mjs
 * and publish `wmuxDeviceReply` on the global.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.wmuxDeviceReply = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  var DEVICE_REPLY_RE = new RegExp(
    '^(?:' +
      // Device attributes (DA1/DA2/DA3) and device status / cursor position.
      '\\x1b\\[[?>=]?[0-9;]*[cnR]' +
      // DECRPM — "mode Ps is currently Pm".
      '|\\x1b\\[\\?[0-9;]*\\$y' +
      // XTSMGRAPHICS — sixel colour registers / geometry.
      '|\\x1b\\[\\?[0-9;]*S' +
      // Window / text-area reports (CSI 8 ; rows ; cols t and friends).
      '|\\x1b\\[[0-9;]+t' +
      // DCS replies: DECRQSS, XTVERSION, DA3.
      '|\\x1bP[^\\x1b]*\\x1b\\\\' +
      // OSC colour reports (`rgb:....` under BEL or ST).
      '|\\x1b\\][0-9;]*;?rgb:[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)' +
      ')$'
  );

  function isDeviceReply(data) {
    return typeof data === 'string' && DEVICE_REPLY_RE.test(data);
  }

  /** Wrap an onData sender so device replies never reach the pane. */
  function guard(send) {
    return function (data) {
      if (isDeviceReply(data)) return;
      send(data);
    };
  }

  return { isDeviceReply: isDeviceReply, guard: guard };
});
