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

  // The addon loaded into each terminal, so a server-side switch can take it
  // back out of a terminal that is already open.
  var loaded = typeof WeakMap === 'function' ? new WeakMap() : null;

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
   * The addon options for this page. Without createImageBitmap the addon's
   * iTerm2 path falls back to an <img> on a blob URL that it never revokes on
   * a decode error and waits a full second on, stalling the parser; such a
   * browser keeps sixel only.
   */
  function optionsFor(env) {
    var opts = {};
    for (var k in OPTIONS) opts[k] = OPTIONS[k];
    opts.iipSupport = typeof env.createImageBitmap === 'function';
    return opts;
  }

  function dispose(addon) {
    try { addon.dispose(); } catch (e) { /* already torn down */ }
  }

  function activate(term, mod, opts) {
    var addon = null;
    try {
      addon = new mod.ImageAddon(opts);
      term.loadAddon(addon);
      return addon;
    } catch (e) {
      // A half-activated addon may already hold parser handlers.
      if (addon && typeof addon.dispose === 'function') dispose(addon);
      return null;
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
    var opts = optionsFor(env);
    // No cap on hand means no sixel either (env.capSixel is the shared
    // src/shared/terminal/sixelCap.ts, the same code the desktop runs).
    if (typeof env.capSixel !== 'function') opts.sixelSupport = false;
    var addon = activate(term, mod, opts);
    if (addon && opts.sixelSupport && !env.capSixel(addon, opts.pixelLimit)) {
      dispose(addon);
      opts.sixelSupport = false;
      addon = activate(term, mod, opts);
    }
    if (!addon) return false;
    if (loaded) loaded.set(term, addon);
    return true;
  }

  /**
   * Bring `term` in line with the server's current switch: load the addon if
   * it is on and missing, dispose it (and every image it holds) if it is off.
   */
  function sync(term, env) {
    var addon = loaded ? loaded.get(term) : undefined;
    if (!env || env.enabled === false) {
      if (addon) {
        dispose(addon);
        loaded.delete(term);
      }
      return false;
    }
    if (addon) return true;
    return load(term, env);
  }

  return { OPTIONS: OPTIONS, wasmUsable: wasmUsable, optionsFor: optionsFor, load: load, sync: sync };
});
