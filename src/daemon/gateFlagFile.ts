/**
 * #1730 — mirrors "the permission gate can be answered right now" into a file
 * a WSL hook can test for the cost of one stat (WSL_GATE_FLAG_FILE in
 * src/shared/wslIntegration.ts). Without it, every tool call in a WSL pane
 * would start a Windows process to ask a gate that is almost always dormant.
 *
 * The file is a hint, never an authority: the daemon still decides each gate
 * over the authenticated pipe. A stale file (daemon crashed) costs a WSL pane
 * one bridge spawn per tool call, which then fails open; a missing one only
 * means the gate is off. The arming inputs change in several places (web
 * server start/stop/reconfigure, the runtime switch), so the state is polled
 * here rather than threaded through each of them; the switch also syncs at once.
 */
import fs from 'fs';

export class GateFlagFile {
  private last: boolean | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly file: string,
    private readonly armed: () => boolean,
    private readonly io: {
      write: (file: string) => void;
      remove: (file: string) => void;
    } = {
      write: (file) => fs.writeFileSync(file, ''),
      remove: (file) => fs.rmSync(file, { force: true }),
    },
  ) {}

  /** Write or remove the file when the armed state changed. The first call
   *  always acts, which clears a file a crashed daemon left behind. */
  sync(): void {
    let want: boolean;
    try {
      want = this.armed();
    } catch {
      want = false;
    }
    if (want === this.last) return;
    try {
      if (want) this.io.write(this.file);
      else this.io.remove(this.file);
      this.last = want;
    } catch {
      // Leave `last` unset so the next tick retries.
    }
  }

  start(intervalMs = 3_000): void {
    this.sync();
    if (this.timer) return;
    this.timer = setInterval(() => this.sync(), intervalMs);
    this.timer.unref?.();
  }

  /** Stop polling and remove the file (daemon shutdown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.io.remove(this.file);
    } catch {
      // Best effort; the next daemon's first sync clears it.
    }
    this.last = false;
  }
}
