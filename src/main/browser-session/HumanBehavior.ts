import {
  generateKeyHolds,
  generateKeystrokeSchedule,
  generateTypingDelays,
  typingDelayFor,
  type KeystrokeSchedule,
} from '../../shared/humanRhythm';

export interface HumanBehaviorConfig {
  typingDelay: { min: number; max: number };
  actionInterval: { min: number; max: number };
  sessionWarmup: boolean;
  dailyLimit: number;
  activeHours: { start: number; end: number };
}

const DEFAULT_CONFIG: HumanBehaviorConfig = {
  typingDelay: { min: 50, max: 150 },
  actionInterval: { min: 2000, max: 5000 },
  sessionWarmup: true,
  dailyLimit: 10,
  activeHours: { start: 8, end: 22 },
};

export class HumanBehavior {
  private config: HumanBehaviorConfig;
  private dailyActionCount: number = 0;

  constructor(config?: Partial<HumanBehaviorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * The pause after one keystroke. `char` is the character just typed, which
   * lengthens the pause after punctuation and word breaks; omit it for a
   * context-free draw. The distribution lives in `shared/humanRhythm` so this
   * lane and the MCP lane stay identical.
   */
  getTypingDelay(char?: string): number {
    const { min, max } = this.config.typingDelay;
    return typingDelayFor(char, { minDelay: min, maxDelay: max });
  }

  getActionInterval(): number {
    const { min, max } = this.config.actionInterval;
    return Math.random() * (max - min) + min;
  }

  isActiveHours(): boolean {
    const hour = new Date().getHours();
    const { start, end } = this.config.activeHours;
    return hour >= start && hour < end;
  }

  canPerformAction(): boolean {
    return this.dailyActionCount < this.config.dailyLimit;
  }

  incrementActionCount(): void {
    this.dailyActionCount++;
  }

  resetDailyCount(): void {
    this.dailyActionCount = 0;
  }

  updateConfig(config: Partial<HumanBehaviorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): HumanBehaviorConfig {
    return { ...this.config };
  }

  generateTypingSchedule(text: string): number[] {
    const { min, max } = this.config.typingDelay;
    return generateTypingDelays(text, { minDelay: min, maxDelay: max });
  }

  /**
   * How long each key is held DOWN, as opposed to the gap after it that
   * `generateTypingSchedule` returns. A caller executing the schedule with a
   * press-and-release per character produces a ~1 ms dwell time, which is a
   * keystroke-dynamics signature of its own; this is the other half of the
   * schedule it needs.
   */
  generateHoldSchedule(text: string): number[] {
    return generateKeyHolds(text);
  }

  /**
   * Both halves of the keystroke stream, drawn against one budget.
   *
   * Taking the two schedules separately double-counted the time: the gap cap
   * was applied to the gaps alone and every dwell was then added on top. A
   * caller that reports or reserves a duration needs the pair that actually
   * fits.
   */
  generateKeystrokeSchedule(text: string): KeystrokeSchedule {
    const { min, max } = this.config.typingDelay;
    return generateKeystrokeSchedule(text, { minDelay: min, maxDelay: max });
  }
}
