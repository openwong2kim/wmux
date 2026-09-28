import type { Terminal, ITerminalOptions } from '@xterm/xterm';
import type { ImageAddon, IImageAddonOptions } from '@xterm/addon-image';

/**
 * Inline terminal images (#1641): sixel (DCS … q) and the iTerm2 inline-image
 * protocol (OSC 1337) through @xterm/addon-image.
 *
 * Every limit below is PER PANE — each terminal gets its own addon, decoder
 * and image store — so the defaults are cut down from the addon's own
 * (16M px / 128 MB / 25 MB / 20 MB), which assume a single terminal:
 *
 * - pixelLimit 2^23 (8,388,608 px): a full 4K frame (3840x2160 = 8.3M px) or
 *   4096x2048 still fits. The sixel decoder may keep up to pixelLimit * 4
 *   bytes (32 MB) after decoding an image that large, so halving the addon's
 *   16M default halves that worst-case per-pane hold.
 * - storageLimit 64 MB: the FIFO image cache (RGBA, 4 bytes per pixel). Room
 *   for two full-4K frames or dozens of diagram-sized images; older images
 *   drop to a placeholder instead of growing the renderer without bound.
 * - sixelSizeLimit / iipSizeLimit 16 MB: the raw sequence size at which the
 *   decoder aborts. A sixel/PNG for an image within pixelLimit is far smaller
 *   in practice; this only stops a runaway or hostile stream early.
 */
export const INLINE_IMAGE_ADDON_OPTIONS = {
  pixelLimit: 2 ** 23,
  storageLimit: 64,
  sixelSizeLimit: 16 * 1024 * 1024,
  iipSizeLimit: 16 * 1024 * 1024,
  // Size reports (CSI 14t / 16t / 18t) let apps size a sixel to the cell
  // grid. The addon turns them on in windowOptions and never turns them off,
  // so detachInlineImages restores the previous windowOptions itself.
  enableSizeReports: true,
} as const satisfies Partial<IImageAddonOptions>;

type ImageAddonModule = typeof import('@xterm/addon-image');

interface Attachment {
  addon: ImageAddon | null;
  detached: boolean;
  windowOptions: ITerminalOptions['windowOptions'];
}

// Keyed by the Terminal instance, not the React mount: a parked terminal
// (#1002) is adopted by the next mount with its images intact, and a second
// sync on the same instance is a no-op instead of a second addon (two stores,
// two canvases, two DA1 handlers).
const attachments = new WeakMap<Terminal, Attachment>();

let loadedModule: ImageAddonModule | null = null;
let modulePromise: Promise<ImageAddonModule> | null = null;

let wasmUsable: boolean | null = null;

/**
 * Whether this page may compile WebAssembly. The addon's sixel decoder and
 * its OSC 1337 base64 decoder are both WebAssembly; under a CSP without
 * 'wasm-unsafe-eval' the first image throws a CompileError inside xterm's
 * parser and every byte of output after it is lost. Probing with the
 * smallest valid module (magic + version) fails the same way, so without it
 * the addon is never loaded and images are ignored rather than fatal.
 */
export function canCompileWasm(): boolean {
  if (wasmUsable === null) {
    try {
      new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
      wasmUsable = true;
    } catch (err) {
      console.warn('[wmux:inline-images] WebAssembly is blocked here; inline images stay off', err);
      wasmUsable = false;
    }
  }
  return wasmUsable;
}

/** Start fetching the addon chunk. Safe to call repeatedly. */
export function preloadInlineImageAddon(): Promise<ImageAddonModule> {
  if (!modulePromise) {
    modulePromise = import('@xterm/addon-image').then((mod) => {
      loadedModule = mod;
      return mod;
    });
    // Drop a failed fetch so the next call retries instead of caching it.
    modulePromise.catch(() => { modulePromise = null; });
  }
  return modulePromise;
}

function activate(terminal: Terminal, attachment: Attachment, mod: ImageAddonModule): void {
  if (attachment.detached || attachments.get(terminal) !== attachment) return;
  attachment.windowOptions = { ...(terminal.options.windowOptions ?? {}) };
  const addon = new mod.ImageAddon(INLINE_IMAGE_ADDON_OPTIONS);
  try {
    terminal.loadAddon(addon);
    attachment.addon = addon;
  } catch (err) {
    // A terminal disposed between the sync and the chunk arriving.
    console.warn('[wmux:inline-images] addon load failed', err);
    attachments.delete(terminal);
  }
}

/**
 * Attach the image addon to this terminal instance. Synchronous when the chunk
 * is already loaded — so the attach made at mount lands before the pane's
 * replay is parsed — otherwise it attaches once the chunk arrives. The very
 * first pane of a cold start can therefore miss images in its own replay.
 */
export function attachInlineImages(terminal: Terminal): void {
  if (attachments.has(terminal) || !canCompileWasm()) return;
  const attachment: Attachment = { addon: null, detached: false, windowOptions: undefined };
  attachments.set(terminal, attachment);
  if (loadedModule) {
    activate(terminal, attachment, loadedModule);
    return;
  }
  preloadInlineImageAddon().then(
    (mod) => activate(terminal, attachment, mod),
    (err) => {
      console.warn('[wmux:inline-images] addon chunk failed to load', err);
      if (attachments.get(terminal) === attachment) attachments.delete(terminal);
    },
  );
}

/** Dispose the addon (drops its canvas, image store and decoder) and undo its option changes. */
export function detachInlineImages(terminal: Terminal): void {
  const attachment = attachments.get(terminal);
  if (!attachment) return;
  attachments.delete(terminal);
  attachment.detached = true;
  if (!attachment.addon) return;
  try {
    attachment.addon.dispose();
  } finally {
    attachment.addon = null;
    try {
      terminal.options.windowOptions = attachment.windowOptions ?? {};
    } catch {
      // terminal already disposed — nothing left to restore
    }
  }
}

export function syncInlineImages(terminal: Terminal, enabled: boolean): void {
  if (enabled) attachInlineImages(terminal);
  else detachInlineImages(terminal);
}

/** Test hook: the live addon on this terminal, if any. */
export function getInlineImageAddon(terminal: Terminal): ImageAddon | null {
  return attachments.get(terminal)?.addon ?? null;
}
