import { nativeImage, type BrowserWindow, type NativeImage } from 'electron';

/**
 * Windows taskbar status: the unread count (the macOS dock badge's number) as
 * an overlay icon on the taskbar button, and an indeterminate progress state while any agent runs.
 * Both are set on every main window, each of which owns its taskbar button.
 *
 * The overlay count is fed from updateUnreadBadge (tray.ts), the same call and
 * value that set the macOS dock badge, so the two can never disagree. The
 * running flag and the on/off setting come from the renderer
 * (NOTIFICATION_TASKBAR_STATE). Everything here is win32-only: on every other
 * platform the exported entry points return before touching a window
 * (setProgressBar also acts on macOS and Linux, so the gate is load-bearing).
 */

/** Overlay text for a count: null clears it, 1–9 as-is, anything above "9+". */
export function overlayBadgeText(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  return count > 9 ? '9+' : String(Math.floor(count));
}

/** Screen-reader description Windows reads for the overlay. */
export function overlayDescription(count: number): string {
  return count === 1 ? 'wmux: 1 unread notification' : `wmux: ${count > 999 ? '999+' : count} unread notifications`;
}

// 3x5 pixel glyphs, one string per row, '#' lit.
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '..#', '..#'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '+': ['...', '.#.', '###', '.#.', '...'],
};

// A neutral grey with white digits. The count is every unread notification,
// not only needs-you, so it does not spend the attention orange (DESIGN.md ›
// Colour grammar). The taskbar does not follow the app theme, so one fixed
// pair is used that reads on light and dark taskbars.
const FILL = [0x5a, 0x5a, 0x60] as const;
const INK = [0xff, 0xff, 0xff] as const;

/**
 * Draw a size×size badge (a filled circle with the text in pixel glyphs) as a
 * premultiplied BGRA buffer, the layout nativeImage.createFromBitmap takes on
 * Windows. `size` is 16 or 32; glyphs scale by size/16.
 */
export function renderBadgeBitmap(text: string, size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const scale = Math.max(1, Math.round(size / 16));
  const glyphs = [...text].map((ch) => GLYPHS[ch]).filter((g): g is readonly string[] => !!g);
  const textW = glyphs.length * 3 + Math.max(0, glyphs.length - 1);
  const ox = Math.floor((16 - textW) / 2) * scale;
  const oy = Math.floor((16 - 5) / 2) * scale;
  const lit = (x: number, y: number): boolean => {
    const gx = Math.floor((x - ox) / scale);
    const gy = Math.floor((y - oy) / scale);
    if (gy < 0 || gy >= 5 || gx < 0) return false;
    const idx = Math.floor(gx / 4);
    const col = gx % 4;
    return idx < glyphs.length && col < 3 && glyphs[idx][gy][col] === '#';
  };
  const r = size / 2;
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Circle coverage by 4x4 supersampling, for a smooth edge.
      let inside = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - r;
          const dy = y + (sy + 0.5) / SS - r;
          if (dx * dx + dy * dy <= r * r) inside++;
        }
      }
      const a = inside / (SS * SS);
      if (a === 0) continue;
      const [cr, cg, cb] = lit(x, y) ? INK : FILL;
      const o = (y * size + x) * 4;
      buf[o] = Math.round(cb * a);
      buf[o + 1] = Math.round(cg * a);
      buf[o + 2] = Math.round(cr * a);
      buf[o + 3] = Math.round(255 * a);
    }
  }
  return buf;
}

function badgeImage(text: string): NativeImage {
  const image = nativeImage.createFromBitmap(renderBadgeBitmap(text, 16), { width: 16, height: 16, scaleFactor: 1 });
  const hiDpi = nativeImage.createFromBitmap(renderBadgeBitmap(text, 32), { width: 32, height: 32, scaleFactor: 2 });
  image.addRepresentation({ scaleFactor: 2, buffer: hiDpi.toPNG({ scaleFactor: 2 }) });
  return image;
}

export interface TaskbarSink {
  setOverlay(text: string | null, description: string): void;
  setProgress(running: boolean): void;
}

export interface TaskbarTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** How long the running flag must hold before the progress state follows it. */
export const PROGRESS_DEBOUNCE_MS = 500;

/**
 * Taskbar state machine, free of Electron so tests can drive it. Nothing is
 * applied until the renderer has sent the setting once: the store's default is
 * on until the session loads, and applying before that would flash an overlay
 * for someone who turned it off.
 */
export class TaskbarStatus {
  private count = 0;
  private running = false;
  private enabled: boolean | null = null;
  // Every main window, each with its own taskbar button. Windows draws a
  // grouped button from its windows' own states, so each one carries both.
  private readonly sinks = new Set<TaskbarSink>();
  private shownText: string | null = null;
  private shownDescription = '';
  private shownProgress = false;
  private timer: unknown = null;

  constructor(private readonly timers: TaskbarTimers, private readonly debounceMs = PROGRESS_DEBOUNCE_MS) {}

  /** Bind (or re-bind) a window sink and re-apply the current state. */
  bind(sink: TaskbarSink): void {
    this.sinks.add(sink);
    if (!this.enabled) return;
    this.applyOverlay(true);
    this.cancelTimer();
    this.applyProgress(true);
  }

  /** Drop `sink` alone: the other windows keep their binding. */
  unbind(sink: TaskbarSink): void {
    this.sinks.delete(sink);
  }

  setCount(count: number): void {
    this.count = count;
    this.applyOverlay(false);
  }

  setState(state: { enabled: boolean; running: boolean }): void {
    const wasEnabled = this.enabled;
    this.enabled = state.enabled;
    this.running = state.running;
    if (!state.enabled) {
      this.cancelTimer();
      this.clearAll(wasEnabled !== false);
      return;
    }
    if (wasEnabled !== true) {
      // First enable (or re-enable): show the current state at once.
      this.applyOverlay(true);
      this.cancelTimer();
      this.applyProgress(true);
      return;
    }
    this.scheduleProgress();
  }

  private applyOverlay(force: boolean): void {
    if (this.sinks.size === 0 || !this.enabled) return;
    const text = overlayBadgeText(this.count);
    // The description carries the exact count, so "9+" from 12 to 15 still
    // re-applies for screen readers.
    const description = text ? overlayDescription(this.count) : '';
    if (!force && text === this.shownText && description === this.shownDescription) return;
    this.shownText = text;
    this.shownDescription = description;
    for (const sink of this.sinks) sink.setOverlay(text, description);
  }

  private scheduleProgress(): void {
    this.cancelTimer();
    if (this.running === this.shownProgress) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.applyProgress(false);
    }, this.debounceMs);
  }

  private applyProgress(force: boolean): void {
    if (this.sinks.size === 0 || !this.enabled) return;
    if (!force && this.running === this.shownProgress) return;
    this.shownProgress = this.running;
    for (const sink of this.sinks) sink.setProgress(this.running);
  }

  private clearAll(wasShowing: boolean): void {
    if (this.sinks.size === 0 || !wasShowing) return;
    this.shownText = null;
    this.shownDescription = '';
    this.shownProgress = false;
    for (const sink of this.sinks) {
      sink.setOverlay(null, '');
      sink.setProgress(false);
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}

const status = new TaskbarStatus({
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function windowSink(win: BrowserWindow): TaskbarSink {
  return {
    setOverlay(text, description) {
      if (win.isDestroyed()) return;
      win.setOverlayIcon(text ? badgeImage(text) : null, description);
    },
    setProgress(running) {
      if (win.isDestroyed()) return;
      if (running) win.setProgressBar(2, { mode: 'indeterminate' });
      else win.setProgressBar(-1);
    },
  };
}

/** Attach the main window. Re-applies on show, since restoring from the tray
 *  recreates the taskbar button. No-op off Windows. */
export function bindTaskbarWindow(win: BrowserWindow): void {
  if (process.platform !== 'win32') return;
  const sink = windowSink(win);
  status.bind(sink);
  win.on('show', () => status.bind(sink));
  win.once('closed', () => status.unbind(sink));
}

/** The unread count, the same value the dock badge gets. No-op off Windows. */
export function updateTaskbarNeedsYou(count: number): void {
  if (process.platform !== 'win32') return;
  status.setCount(count);
}

/** The renderer's setting and running flag. No-op off Windows. */
export function updateTaskbarState(state: { enabled: boolean; running: boolean }): void {
  if (process.platform !== 'win32') return;
  status.setState(state);
}
