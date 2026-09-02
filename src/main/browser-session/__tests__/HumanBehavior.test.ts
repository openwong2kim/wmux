import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HumanBehavior } from '../HumanBehavior';

describe('HumanBehavior', () => {
  let behavior: HumanBehavior;

  beforeEach(() => {
    behavior = new HumanBehavior();
  });

  it('should create with default config', () => {
    const config = behavior.getConfig();
    expect(config.typingDelay).toEqual({ min: 50, max: 150 });
    expect(config.actionInterval).toEqual({ min: 2000, max: 5000 });
    expect(config.sessionWarmup).toBe(true);
    expect(config.dailyLimit).toBe(10);
    expect(config.activeHours).toEqual({ start: 8, end: 22 });
  });

  // The draw is log-normal around the band's midpoint with an occasional
  // longer pause, so it is no longer bounded by the band itself — only by the
  // rhythm module's clamp (0.6x min .. 5x max). Distribution shape is asserted
  // in shared/__tests__/humanRhythm.test.ts.
  it('should return getTypingDelay() inside the rhythm clamp', () => {
    for (let i = 0; i < 200; i++) {
      const delay = behavior.getTypingDelay();
      expect(delay).toBeGreaterThanOrEqual(50 * 0.6);
      // The clamp caps the base draw at 5x max; a thinking pause can add up to
      // another 700ms on top.
      expect(delay).toBeLessThanOrEqual(150 * 5 + 700);
    }
  });

  it('should return getActionInterval() within 2000-5000ms range', () => {
    for (let i = 0; i < 100; i++) {
      const interval = behavior.getActionInterval();
      expect(interval).toBeGreaterThanOrEqual(2000);
      expect(interval).toBeLessThan(5000);
    }
  });

  describe('isActiveHours()', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return true during active hours', () => {
      vi.spyOn(Date.prototype, 'getHours').mockReturnValue(12);
      expect(behavior.isActiveHours()).toBe(true);
    });

    it('should return false outside active hours', () => {
      vi.spyOn(Date.prototype, 'getHours').mockReturnValue(3);
      expect(behavior.isActiveHours()).toBe(false);
    });

    it('should return true at the start boundary (hour 8)', () => {
      vi.spyOn(Date.prototype, 'getHours').mockReturnValue(8);
      expect(behavior.isActiveHours()).toBe(true);
    });

    it('should return false at the end boundary (hour 22)', () => {
      vi.spyOn(Date.prototype, 'getHours').mockReturnValue(22);
      expect(behavior.isActiveHours()).toBe(false);
    });
  });

  it('should return true from canPerformAction() within daily limit', () => {
    expect(behavior.canPerformAction()).toBe(true);
  });

  it('should return false from canPerformAction() when daily limit exceeded', () => {
    for (let i = 0; i < 10; i++) {
      behavior.incrementActionCount();
    }
    expect(behavior.canPerformAction()).toBe(false);
  });

  it('should increment action count via incrementActionCount()', () => {
    expect(behavior.canPerformAction()).toBe(true);
    for (let i = 0; i < 10; i++) {
      behavior.incrementActionCount();
    }
    expect(behavior.canPerformAction()).toBe(false);
  });

  it('should reset count via resetDailyCount()', () => {
    for (let i = 0; i < 10; i++) {
      behavior.incrementActionCount();
    }
    expect(behavior.canPerformAction()).toBe(false);
    behavior.resetDailyCount();
    expect(behavior.canPerformAction()).toBe(true);
  });

  it('should return delay array matching text length from generateTypingSchedule()', () => {
    const text = 'hello';
    const schedule = behavior.generateTypingSchedule(text);
    expect(schedule).toHaveLength(text.length);
    // Bounded by the rhythm clamp, not by the band — see the getTypingDelay
    // test above.
    for (const delay of schedule) {
      expect(delay).toBeGreaterThanOrEqual(50 * 0.6);
      expect(delay).toBeLessThanOrEqual(150 * 5 + 700);
    }
  });

  it('should return empty array for empty string from generateTypingSchedule()', () => {
    const schedule = behavior.generateTypingSchedule('');
    expect(schedule).toHaveLength(0);
  });

  it('should update config via updateConfig()', () => {
    behavior.updateConfig({ dailyLimit: 50 });
    const config = behavior.getConfig();
    expect(config.dailyLimit).toBe(50);
    // Other fields unchanged
    expect(config.typingDelay).toEqual({ min: 50, max: 150 });
  });

  it('should create with custom config', () => {
    const custom = new HumanBehavior({
      typingDelay: { min: 10, max: 20 },
      dailyLimit: 100,
    });
    const config = custom.getConfig();
    expect(config.typingDelay).toEqual({ min: 10, max: 20 });
    expect(config.dailyLimit).toBe(100);
    // Defaults preserved for unset fields
    expect(config.actionInterval).toEqual({ min: 2000, max: 5000 });
  });
});
