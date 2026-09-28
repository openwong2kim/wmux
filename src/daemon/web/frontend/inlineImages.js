/* Inline images (sixel, iTerm2 OSC 1337) for the wmux web terminal (#1641).
 *
 * Both of @xterm/addon-image's decoders are WebAssembly, and a page that may
 * not compile wasm does not merely lose the image: the decoder throws inside
 * xterm's parser and every byte after it is lost. The server's CSP allows
 * wasm compilation, but a browser without CSP3 ignores that keyword, so the
 * addon is loaded only after a real module compiles and instantiates here.
 *
 * Kept out of app.js so the gate is unit tested against the exact bytes the
 * phone runs. Builds inline this file into terminal.html via
 * scripts/build-daemon-web.mjs and publish `wmuxInlineImages` on the global.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.wmuxInlineImages = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  // Sized for a phone, not the addon's desktop defaults (16 MP per image,
  // 25 MB payloads, 128 MB cache). Size reports stay off: they answer
  // XTWINOPS queries through onData, and a viewer must never answer queries
  // for the pane it watches.
  var OPTIONS = {
    enableSizeReports: false,
    sixelSupport: true,
    iipSupport: true,
    pixelLimit: 2048 * 2048,
    sixelSizeLimit: 4000000,
    iipSizeLimit: 4000000,
    storageLimit: 24
  };

  // The smallest valid module: magic + version, no sections.
  var EMPTY_MODULE = [0, 97, 115, 109, 1, 0, 0, 0];

  /** Whether this page may compile AND instantiate WebAssembly. */
  function wasmUsable(wa) {
    try {
      if (!wa || typeof wa.Module !== 'function' || typeof wa.Instance !== 'function') return false;
      return !!new wa.Instance(new wa.Module(new Uint8Array(EMPTY_MODULE)));
    } catch (e) {
      return false;
    }
  }

  /**
   * Load the image addon into `term` when it is enabled, present and usable.
   * Returns true when it was loaded. Never throws: the terminal works without
   * images, and a failure here must not take the text with it.
   */
  function load(term, env) {
    if (!env || env.enabled === false) return false;
    var mod = env.ImageAddon;
    if (!mod || typeof mod.ImageAddon !== 'function') return false;
    if (!wasmUsable(env.WebAssembly)) return false;
    try {
      term.loadAddon(new mod.ImageAddon(OPTIONS));
      return true;
    } catch (e) {
      return false;
    }
  }

  return { OPTIONS: OPTIONS, wasmUsable: wasmUsable, load: load };
});
