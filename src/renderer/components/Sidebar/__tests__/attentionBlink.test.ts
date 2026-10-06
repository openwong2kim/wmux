import { describe, it, expect } from 'vitest';
import {
  attentionPulseClass,
  resolveAttentionBlink,
  resolveAttentionBlinkFinished,
  resolveAttentionRemindMs,
  type AttentionPulseInput,
} from '../attentionBlink';

const base: AttentionPulseInput = {
  needsYou: true, done: false, visible: false, reducedMotion: false,
  mode: 'remind', remindMs: 60_000, finished: 'dot',
};

describe('attentionPulseClass', () => {
  it('maps each mode to its class', () => {
    expect(attentionPulseClass({ ...base, mode: 'off' })).toBe('');
    expect(attentionPulseClass({ ...base, mode: 'once' })).toBe('sidebar-row-pulse sidebar-row-pulse-once');
    expect(attentionPulseClass({ ...base, mode: 'remind', remindMs: 300_000 })).toBe('sidebar-row-pulse sidebar-row-pulse-remind-300s');
    expect(attentionPulseClass({ ...base, mode: 'continuous' })).toBe('sidebar-row-pulse sidebar-row-pulse-continuous');
  });

  it('spends "once" and defers "remind" after the wait was on screen', () => {
    expect(attentionPulseClass({ ...base, mode: 'once', seenThisWait: true })).toBe('');
    expect(attentionPulseClass({ ...base, seenThisWait: true })).toContain('sidebar-row-pulse-deferred');
  });

  it('never pulses under reduced motion or on screen', () => {
    expect(attentionPulseClass({ ...base, mode: 'continuous', reducedMotion: true })).toBe('');
    expect(attentionPulseClass({ ...base, mode: 'continuous', visible: true })).toBe('');
    expect(attentionPulseClass({ ...base, needsYou: false, done: true, finished: 'pulse', reducedMotion: true })).toBe('');
  });

  it('a finished turn pulses once only when asked to', () => {
    const done = { ...base, needsYou: false, done: true };
    expect(attentionPulseClass(done)).toBe('');
    expect(attentionPulseClass({ ...done, finished: 'pulse' })).toBe('sidebar-row-pulse sidebar-row-pulse-done');
  });
});

describe('persisted values are whitelisted', () => {
  it('falls back to the defaults', () => {
    expect(resolveAttentionBlink('blink-forever')).toBe('remind');
    expect(resolveAttentionBlink('off')).toBe('off');
    expect(resolveAttentionRemindMs(12_345)).toBe(60_000);
    expect(resolveAttentionRemindMs(300_000)).toBe(300_000);
    expect(resolveAttentionBlinkFinished(undefined)).toBe('dot');
    expect(resolveAttentionBlinkFinished('pulse')).toBe('pulse');
  });
});
