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
  private dailyActionCount = 0;

  constructor(config?: Partial<HumanBehaviorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getTypingDelay(): number {
    const { min, max } = this.config.typingDelay;
    return Math.random() * (max - min) + min;
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
    return Array.from({ length: text.length }, () => this.getTypingDelay());
  }
}
