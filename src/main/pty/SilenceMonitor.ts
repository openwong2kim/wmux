export class SilenceMonitor {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private fired = new Set<string>();
  private callbacks: ((ptyId: string) => void)[] = [];
  private timeoutMs = 30_000;

  setTimeout(seconds: number): void {
    this.timeoutMs = seconds * 1000;
  }

  onSilence(callback: (ptyId: string) => void): void {
    this.callbacks.push(callback);
  }

  start(ptyId: string): void {
    this.arm(ptyId);
  }

  reset(ptyId: string): void {
    this.fired.delete(ptyId);
    this.arm(ptyId);
  }

  stop(ptyId: string): void {
    const timer = this.timers.get(ptyId);
    if (timer) clearTimeout(timer);
    this.timers.delete(ptyId);
    this.fired.delete(ptyId);
  }

  private arm(ptyId: string): void {
    const existing = this.timers.get(ptyId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      ptyId,
      setTimeout(() => {
        if (!this.fired.has(ptyId)) {
          this.fired.add(ptyId);
          this.callbacks.forEach((cb) => cb(ptyId));
        }
      }, this.timeoutMs),
    );
  }
}
