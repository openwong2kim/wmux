import { Terminal as ProbeTerminal } from '@xterm/xterm';
import type { Terminal, ITerminalOptions, ITerminalAddon } from '@xterm/xterm';
import type { ImageAddon, IImageAddonOptions } from '@xterm/addon-image';

/**
 * Inline terminal images (#1641): sixel (DCS … q) and the iTerm2 inline-image
 * protocol (OSC 1337) through @xterm/addon-image.
 *
 * Each terminal gets its own addon, decoder and image store, so the limits are
 * cut down from the addon's own (16M px / 128 MB / 25 MB / 20 MB), which
 * assume a single terminal:
 *
 * - pixelLimit 2^23 (8,388,608 px): a full 4K frame (3840x2160 = 8.3M px) or
 *   4096x2048 still fits. The sixel decoder may keep up to pixelLimit * 4
 *   bytes (32 MB) after decoding an image that large, so halving the addon's
 *   16M default halves that worst-case per-pane hold.
 * - storageLimit: the FIFO image cache (RGBA, 4 bytes per pixel); older images
 *   drop to a placeholder. One pane may use up to 64 MB, and all panes share
 *   TOTAL_STORAGE_MB, split evenly (never below MIN_PANE_STORAGE_MB) as panes
 *   attach and go away — see rebalanceStorage.
 * - sixelSizeLimit / iipSizeLimit 16 MB: the raw sequence size at which the
 *   decoder aborts. A sixel/PNG for an image within pixelLimit is far smaller
 *   in practice; this only stops a runaway or hostile stream early.
 */
export const INLINE_IMAGE_ADDON_OPTIONS = {
  pixelLimit: 2 ** 23,
  storageLimit: 64,
  sixelSizeLimit: 16 * 1024 * 1024,
  iipSizeLimit: 16 * 1024 * 1024,
  // Size reports (CSI 14t / 16t / 18t) are ON deliberately: the pty carries no
  // pixel size (TIOCGWINSZ xpixel/ypixel stay 0), so this is how sixel tools
  // learn the cell size and fit an image to the grid instead of guessing. The
  // replies carry pixel geometry only; replayed queries are stripped by
  // replayQuerySanitizer. The addon never turns them off, so detach removes
  // the keys it added.
  enableSizeReports: true,
} as const satisfies Partial<IImageAddonOptions>;

export const TOTAL_STORAGE_MB = 256;
export const MIN_PANE_STORAGE_MB = 8;

/** The windowOptions keys ImageAddon.activate switches on. */
const SIZE_REPORT_KEYS = ['getWinSizePixels', 'getCellSizePixels', 'getWinSizeChars'] as const;

type ImageAddonModule = typeof import('@xterm/addon-image');
type WindowOptions = NonNullable<ITerminalOptions['windowOptions']>;

interface Attachment {
  terminal: Terminal;
  addon: ImageAddon | null;
  /** Disposed with the terminal, so a terminal disposed while attached leaves `live`. */
  sentinel: ITerminalAddon | null;
  detached: boolean;
  /** Size-report keys this attachment turned on (were not on before). */
  addedKeys: (typeof SIZE_REPORT_KEYS)[number][];
}

// Keyed by the Terminal instance, not the React mount: a parked terminal
// (#1002) is adopted by the next mount with its images intact, and a second
// sync on the same instance is a no-op instead of a second addon (two stores,
// two canvases, two DA1 handlers).
const attachments = new WeakMap<Terminal, Attachment>();
/** Attachments with a loaded addon — the storage budget's denominator. */
const live = new Set<Attachment>();
/**
 * Highest image id a terminal's earlier addon handed out. Image ids live in
 * the buffer cells, and a fresh addon counts from 1 again, so after an
 * off/on toggle an old cell would pick up the NEW image with the same id.
 * The next addon on that terminal starts above it instead.
 */
const idHighWater = new WeakMap<Terminal, number>();

type ProbeState = 'pending' | 'ok' | 'failed';
let probeState: ProbeState = 'pending';
let loadedModule: ImageAddonModule | null = null;
let preloadPromise: Promise<boolean> | null = null;

let wasmUsable: boolean | null = null;

/**
 * Whether this page may compile and instantiate WebAssembly at all. The
 * addon's sixel decoder and its OSC 1337 base64 decoder are both
 * WebAssembly; under a CSP without 'wasm-unsafe-eval' the first image throws
 * a CompileError inside xterm's parser and every byte of output after it is
 * lost. This cheap check runs first; the real decoders are exercised by
 * probeDecoders once the chunk is loaded. It runs whatever the CSP says: an
 * engine may lack WebAssembly outright or ignore 'wasm-unsafe-eval'.
 */
export function canCompileWasm(): boolean {
  if (wasmUsable === null) {
    try {
      const probe = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
      new WebAssembly.Instance(probe);
      wasmUsable = true;
    } catch (err) {
      console.warn('[wmux:inline-images] WebAssembly is blocked here; inline images stay off', err);
      wasmUsable = false;
    }
  }
  return wasmUsable;
}

// A 3-byte OSC 1337 payload (not a real image, so it is dropped without an
// async decode) still runs the base64 WebAssembly decoder, which compiles
// lazily on first use; the sixel run goes through the sixel decoder. The
// trailing text must land for the probe to pass.
const PROBE_SEQUENCE = '\x1b]1337;File=inline=1;size=3:AAAA\x07\x1bPq#0!4~\x1b\\probe-ok';
const PROBE_TIMEOUT_MS = 2000;

/**
 * Run the addon's REAL decoders once on a throwaway, never-opened terminal:
 * a failure there (compile error, parser stall) costs only that terminal.
 */
async function probeDecoders(mod: ImageAddonModule): Promise<boolean> {
  const term = new ProbeTerminal({ cols: 40, rows: 4, allowProposedApi: true, windowOptions: {} });
  try {
    term.loadAddon(new mod.ImageAddon({ ...INLINE_IMAGE_ADDON_OPTIONS, enableSizeReports: false }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe write timed out')), PROBE_TIMEOUT_MS);
      term.write(PROBE_SEQUENCE, () => { clearTimeout(timer); resolve(); });
    });
    const line = term.buffer.active.getLine(term.buffer.active.cursorY)?.translateToString(true) ?? '';
    if (!line.includes('probe-ok')) throw new Error('text after the probe images did not render');
    return true;
  } catch (err) {
    console.warn('[wmux:inline-images] image decoders failed their probe; inline images stay off', err);
    return false;
  } finally {
    try { term.dispose(); } catch { /* best effort */ }
  }
}

/**
 * Fetch the addon chunk and probe its decoders. Called at renderer start when
 * the setting is on, so the first pane's attach is synchronous and lands
 * before its replay is parsed. Safe to call repeatedly.
 */
export function preloadInlineImageAddon(): Promise<boolean> {
  if (!canCompileWasm()) {
    probeState = 'failed';
    return Promise.resolve(false);
  }
  if (!preloadPromise) {
    preloadPromise = import('@xterm/addon-image')
      .then(async (mod) => {
        const ok = await probeDecoders(mod);
        loadedModule = ok ? mod : null;
        probeState = ok ? 'ok' : 'failed';
        return ok;
      })
      .catch((err) => {
        // A failed fetch is retried on the next call.
        console.warn('[wmux:inline-images] addon chunk failed to load', err);
        preloadPromise = null;
        return false;
      });
  }
  return preloadPromise;
}

function rebalanceStorage(): void {
  const perPane = Math.max(
    MIN_PANE_STORAGE_MB,
    Math.min(INLINE_IMAGE_ADDON_OPTIONS.storageLimit, Math.floor(TOTAL_STORAGE_MB / Math.max(1, live.size))),
  );
  for (const a of live) {
    if (a.addon && a.addon.storageLimit !== perPane) a.addon.storageLimit = perPane;
  }
}

/** Remove only the size-report keys this attachment turned on; later changes to other keys survive. */
function removeAddedWindowOptions(attachment: Attachment): void {
  if (attachment.addedKeys.length === 0) return;
  try {
    const next: WindowOptions = { ...(attachment.terminal.options.windowOptions ?? {}) };
    for (const key of attachment.addedKeys) delete next[key];
    attachment.terminal.options.windowOptions = next;
  } catch {
    // terminal already disposed — nothing left to restore
  }
  attachment.addedKeys = [];
}

// ImageStorage internals (@xterm/addon-image 0.9.0, pinned exactly). Checked
// by a test so a version bump that renames them fails loudly.
interface StorageInternals { _lastId: number; _lowestId: number }
function storageOf(addon: ImageAddon): StorageInternals | null {
  const storage = (addon as unknown as { _storage?: StorageInternals })._storage;
  return storage && typeof storage._lastId === 'number' ? storage : null;
}

function teardown(attachment: Attachment): void {
  const { terminal, addon } = attachment;
  live.delete(attachment);
  attachment.addon = null;
  if (addon) {
    const storage = storageOf(addon);
    if (storage) idHighWater.set(terminal, Math.max(idHighWater.get(terminal) ?? 0, storage._lastId));
    try { addon.dispose(); } catch { /* already torn down with the terminal */ }
  }
  removeAddedWindowOptions(attachment);
  const sentinel = attachment.sentinel;
  attachment.sentinel = null;
  try { sentinel?.dispose(); } catch { /* already disposed */ }
  rebalanceStorage();
}

function activate(attachment: Attachment, mod: ImageAddonModule): void {
  const { terminal } = attachment;
  if (attachment.detached || attachments.get(terminal) !== attachment) return;
  // xterm 6 hands every Terminal the SAME default windowOptions object and the
  // addon mutates it in place, which would switch size reports on for every
  // terminal in the renderer (the remote mirror included) and make them
  // impossible to switch off per pane. Give this terminal its own copy first.
  const before: WindowOptions = { ...(terminal.options.windowOptions ?? {}) };
  terminal.options.windowOptions = before;
  attachment.addedKeys = SIZE_REPORT_KEYS.filter((k) => !before[k]);
  const addon = new mod.ImageAddon({ ...INLINE_IMAGE_ADDON_OPTIONS });
  attachment.addon = addon;
  try {
    terminal.loadAddon(addon);
    const storage = storageOf(addon);
    const floor = idHighWater.get(terminal) ?? 0;
    if (storage && floor > 0) {
      storage._lastId = floor;
      storage._lowestId = floor;
    }
    const sentinel: ITerminalAddon = {
      activate: () => {},
      dispose: () => {
        if (attachment.sentinel !== sentinel) return;
        attachment.sentinel = null;
        live.delete(attachment);
        attachments.delete(terminal);
        rebalanceStorage();
      },
    };
    attachment.sentinel = sentinel;
    terminal.loadAddon(sentinel);
    live.add(attachment);
    rebalanceStorage();
  } catch (err) {
    // A half-activated addon may already have registered its DA1/DCS
    // handlers and changed windowOptions; undo both.
    console.warn('[wmux:inline-images] addon load failed', err);
    attachments.delete(terminal);
    attachment.detached = true;
    teardown(attachment);
  }
}

/**
 * Attach the image addon to this terminal instance. Synchronous once the
 * chunk is loaded and probed (preloaded at renderer start), so the attach made
 * at mount lands before the pane's replay is parsed; otherwise it attaches
 * when the probe passes.
 */
export function attachInlineImages(terminal: Terminal): void {
  if (attachments.has(terminal) || probeState === 'failed' || !canCompileWasm()) return;
  const attachment: Attachment = { terminal, addon: null, sentinel: null, detached: false, addedKeys: [] };
  attachments.set(terminal, attachment);
  if (probeState === 'ok' && loadedModule) {
    activate(attachment, loadedModule);
    return;
  }
  void preloadInlineImageAddon().then((ok) => {
    if (ok && loadedModule) activate(attachment, loadedModule);
    else if (attachments.get(terminal) === attachment) attachments.delete(terminal);
  });
}

/** Dispose the addon (drops its canvas, image store and decoder) and undo its option changes. */
export function detachInlineImages(terminal: Terminal): void {
  const attachment = attachments.get(terminal);
  if (!attachment) return;
  attachments.delete(terminal);
  attachment.detached = true;
  teardown(attachment);
}

export function syncInlineImages(terminal: Terminal, enabled: boolean): void {
  if (enabled) attachInlineImages(terminal);
  else detachInlineImages(terminal);
}

/**
 * Setting changed. Off detaches every live addon — including terminals no
 * mounted pane is syncing right now (parked for adoption); on only warms the
 * chunk, since mounted panes attach through their own effect.
 */
export function applyInlineImagesSetting(enabled: boolean): void {
  if (enabled) {
    void preloadInlineImageAddon();
    return;
  }
  for (const attachment of [...live]) detachInlineImages(attachment.terminal);
}

/** Test hook: the live addon on this terminal, if any. */
export function getInlineImageAddon(terminal: Terminal): ImageAddon | null {
  return attachments.get(terminal)?.addon ?? null;
}
