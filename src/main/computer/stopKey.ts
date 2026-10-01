// The computer-use stop key: a global shortcut held only while computer use
// is on. Electron-free so its lifecycle is unit-testable; index.ts hands it
// Electron's globalShortcut.
//
// Fail closed: the stop key is the person's last-resort control, so while it
// is not held (another app owns the chord, or registration threw) agents may
// not drive the desktop at all. ComputerService asks `arm()` before every
// input action and refuses with `stop_key_unavailable` when it returns false.

export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** `off`: not held because computer use is off. `unavailable`: wanted, but registration failed. */
export type StopKeyStatus = 'off' | 'held' | 'unavailable';

export class StopKey {
  private held = false;
  private failed = false;

  constructor(
    private readonly deps: {
      registry: ShortcutRegistry;
      accelerator: string;
      onPress: () => void;
      log?: (message: string) => void;
    },
  ) {}

  /**
   * Hold the shortcut if we do not already. Idempotent; a failed attempt is
   * retried on the next call, so closing the app that held the chord is
   * enough to recover. Returns whether the key is held now.
   */
  arm(): boolean {
    if (this.held) return true;
    let ok = false;
    try {
      ok = this.deps.registry.register(this.deps.accelerator, () => this.deps.onPress());
    } catch (err) {
      this.deps.log?.(`[computer] stop key registration threw: ${err instanceof Error ? err.message : String(err)}`);
      ok = false;
    }
    if (!ok && !this.failed) {
      this.deps.log?.(`[computer] could not register the stop key ${this.deps.accelerator}; computer input is refused until it can`);
    }
    this.held = ok;
    this.failed = !ok;
    return ok;
  }

  /** Give the shortcut back (switch turned off, app quitting). Safe to call when not held. */
  release(): void {
    this.failed = false;
    if (!this.held) return;
    this.held = false;
    try {
      this.deps.registry.unregister(this.deps.accelerator);
    } catch (err) {
      this.deps.log?.(`[computer] stop key unregister threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  status(): StopKeyStatus {
    if (this.held) return 'held';
    return this.failed ? 'unavailable' : 'off';
  }
}
