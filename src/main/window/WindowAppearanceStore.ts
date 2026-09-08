import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type WindowAppearancePrefs,
  DEFAULT_WINDOW_APPEARANCE,
  normalizeWindowAppearance,
} from '../../shared/windowAppearance';

/**
 * Main-owned persistence for the window transparency prefs (#1133).
 *
 * Same shape and rationale as BrowserBackendStore: the consumer is window
 * creation in the main process, which runs before the renderer exists, so the
 * value is read synchronously at construction — the very first window is
 * created with the right `transparent` flag with no settled gate or race.
 * The renderer Settings UI reads/writes over IPC and keeps only a mirror.
 */
export class WindowAppearanceStore {
  private readonly filePath: string;
  private prefs: WindowAppearancePrefs = DEFAULT_WINDOW_APPEARANCE;
  // Trailing debounce for the disk write: the Settings slider fires a set()
  // per tick, and each persist is a synchronous mkdir+write+rename on the
  // MAIN process — a 30→100 drag must not become ~70 sequential sync writes.
  // The in-memory value (what window creation reads) is always immediate.
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly persistDebounceMs: number;

  constructor(userDataDir: string, persistDebounceMs = 150) {
    this.persistDebounceMs = persistDebounceMs;
    this.filePath = join(userDataDir, 'window-appearance.json');
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const value = (parsed as { appearance?: unknown } | null)?.appearance;
      this.prefs = normalizeWindowAppearance(value);
      // Unknown/corrupt content degrades per-field to the defaults — a broken
      // opacity must never take an opaque-window user by surprise.
    } catch {
      /* missing or unreadable file → defaults (today's opaque behaviour) */
    }
  }

  get(): WindowAppearancePrefs {
    return this.prefs;
  }

  set(prefs: WindowAppearancePrefs): void {
    this.prefs = normalizeWindowAppearance(prefs);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    const flush = (): void => {
      this.persistTimer = null;
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
        // Atomic write (tmp + rename): a crash mid-write must not leave a
        // truncated file that boots the next window opaque (or translucent)
        // contrary to what the user chose.
        const tmpPath = `${this.filePath}.tmp`;
        writeFileSync(tmpPath, JSON.stringify({ appearance: this.prefs }), 'utf8');
        renameSync(tmpPath, this.filePath);
      } catch (err) {
        // In-memory value still applies for this session; persistence failures
        // are logged, not swallowed.
        console.error('[WindowAppearanceStore] persist failed:', err);
      }
    };
    if (this.persistDebounceMs <= 0) {
      flush();
      return;
    }
    this.persistTimer = setTimeout(flush, this.persistDebounceMs);
    // The debounced write must not be lost to process exit — a quit while a
    // drag's trailing write is pending would silently roll the choice back.
    (this.persistTimer as { unref?: () => void }).unref?.();
  }
}
