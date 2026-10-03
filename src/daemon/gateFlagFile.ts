/**
 * #1730 — mirrors "the permission gate can be answered right now" into a file
 * a WSL hook can test for the cost of one stat (WSL_GATE_FLAG_FILE in
 * src/shared/wslIntegration.ts). Without it, every tool call in a WSL pane
 * would start a Windows process to ask a gate that is almost always dormant.
 *
 * The file is a hint, never an authority: the daemon still decides each gate
 * over the authenticated pipe. A stale file (daemon crashed) costs a WSL pane
 * one bridge spawn per tool call, which then fails open; a missing one only
 * means the gate is off. The daemon syncs right after the web server starts,
 * stops or is restored and on the runtime switch; the poll is the backstop
 * for any other change.
 */
import fs from 'fs';
import path from 'path';

export class GateFlagFile {
  private last: boolean | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** A failure already reported, so a persistent one logs once, not per tick. */
  private failing = false;

  constructor(
    private readonly file: string,
    private readonly armed: () => boolean,
    private readonly log: (message: string) => void = () => undefined,
    private readonly io: {
      write: (file: string) => void;
      remove: (file: string) => void;
    } = {
      write: (file) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
      },
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
      if (this.failing) this.log(`WSL gate flag ${want ? 'written' : 'removed'} after earlier failures`);
      this.failing = false;
    } catch (err) {
      // Leave `last` unset so the next tick retries. A missing flag while the
      // gate is armed means WSL panes skip it, so this must not stay silent.
      if (!this.failing) {
        this.log(`could not ${want ? 'write' : 'remove'} the WSL gate flag ${this.file}: ${String(err)}`);
      }
      this.failing = true;
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
