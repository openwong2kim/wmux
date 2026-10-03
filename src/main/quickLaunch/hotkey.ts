// The quick-launch chord. Electron-free so its lifecycle is unit-testable;
// index.ts hands it Electron's globalShortcut.
//
// The rebind order (claim the new chord before releasing the old one, so a
// refused edit leaves the working shortcut in place) is adapted from MonoCode
// (hardbeat920/monocode@6bd432ca, src-tauri/src/quick_composer.rs,
// quick_composer_set_enabled), MIT License, Copyright (c) 2026 Nick.

import type { ShortcutRegistry } from '../computer/stopKey';
import type { QuickLaunchSettingsPayload } from '../../shared/quickLaunch';

export class QuickLaunchHotkey {
  /** The accelerator currently registered, if any. */
  private held: string | null = null;
  /** The accelerator that was wanted and refused, with why. */
  private failure: { accelerator: string; error: string } | null = null;

  constructor(
    private readonly deps: {
      registry: ShortcutRegistry;
      onPress: () => void;
      log?: (message: string) => void;
    },
  ) {}

  /**
   * Make `accelerator` the held chord (or hold nothing when `enabled` is
   * false). Idempotent, and a failed attempt is retried on the next call, so
   * closing the app that held the chord and reopening Settings recovers.
   * Returns whether the wanted chord is held now.
   */
  apply(enabled: boolean, accelerator: string): boolean {
    if (!enabled) {
      this.release();
      return true;
    }
    if (this.held === accelerator) {
      // Back on the chord already held (a refused edit was rolled back).
      this.failure = null;
      return true;
    }
    let ok = false;
    let error = 'another app or the system already uses this shortcut';
    try {
      ok = this.deps.registry.register(accelerator, () => this.deps.onPress());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (!ok) {
      // Keep the previous chord: a refused edit must not strand the composer.
      if (this.failure?.accelerator !== accelerator) {
        this.deps.log?.(`[quick-launch] could not register ${accelerator}: ${error}`);
      }
      this.failure = { accelerator, error };
      return false;
    }
    const previous = this.held;
    this.held = accelerator;
    this.failure = null;
    if (previous) this.unregister(previous);
    return true;
  }

  /**
   * Hold nothing and report `accelerator` as not registered: it is wanted but
   * may not be taken (it would shadow another wmux shortcut).
   */
  block(accelerator: string, reason: string): void {
    this.release();
    this.failure = { accelerator, error: reason };
  }

  /** Give the chord back (switched off, app quitting). Safe when not held. */
  release(): void {
    this.failure = null;
    if (!this.held) return;
    const previous = this.held;
    this.held = null;
    this.unregister(previous);
  }

  status(): QuickLaunchSettingsPayload['status'] {
    if (this.failure) return 'unavailable';
    return this.held ? 'held' : 'off';
  }

  /** Why the wanted chord is not held, while it is not. */
  failureReason(): string | undefined {
    return this.failure?.error;
  }

  private unregister(accelerator: string): void {
    try {
      this.deps.registry.unregister(accelerator);
    } catch (err) {
      this.deps.log?.(`[quick-launch] unregister ${accelerator} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
