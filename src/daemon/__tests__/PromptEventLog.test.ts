import { describe, it, expect } from 'vitest';
import { PromptEventLog, parseOsc133Payload } from '../PromptEventLog';

describe('parseOsc133Payload', () => {
  it('parses A as prompt_start', () => {
    const ev = parseOsc133Payload('A', 1000, 500);
    expect(ev).toEqual({ type: 'prompt_start', ts: 1000, byteOffset: 500 });
  });

  it('parses B as prompt_end', () => {
    const ev = parseOsc133Payload('B', 1001, 510);
    expect(ev).toEqual({ type: 'prompt_end', ts: 1001, byteOffset: 510 });
  });

  it('parses C as command_start', () => {
    const ev = parseOsc133Payload('C', 1002, 520);
    expect(ev).toEqual({ type: 'command_start', ts: 1002, byteOffset: 520 });
  });

  it('parses D;0 as command_end with exitCode 0', () => {
    const ev = parseOsc133Payload('D;0', 1003, 530);
    expect(ev).toEqual({ type: 'command_end', ts: 1003, byteOffset: 530, exitCode: 0 });
  });

  it('parses D;127 as command_end with exitCode 127', () => {
    const ev = parseOsc133Payload('D;127', 1004, 540);
    expect(ev).toEqual({ type: 'command_end', ts: 1004, byteOffset: 540, exitCode: 127 });
  });

  it('parses bare D as command_end with no exitCode', () => {
    const ev = parseOsc133Payload('D', 1005, 550);
    expect(ev).toEqual({ type: 'command_end', ts: 1005, byteOffset: 550 });
    expect(ev?.exitCode).toBeUndefined();
  });

  it('ignores extra ;k=v pairs in D payload', () => {
    // Ghostty/VS Code dialects sometimes append extra metadata.
    const ev = parseOsc133Payload('D;0;cwd=/home/user', 1006, 560);
    expect(ev).toEqual({ type: 'command_end', ts: 1006, byteOffset: 560, exitCode: 0 });
  });

  it('returns null for unknown subcommands', () => {
    expect(parseOsc133Payload('X', 1, 0)).toBeNull();
    expect(parseOsc133Payload('', 1, 0)).toBeNull();
  });

  it('returns command_end without exitCode when D carries a non-numeric tail', () => {
    const ev = parseOsc133Payload('D;abc', 1, 0);
    expect(ev?.type).toBe('command_end');
    expect(ev?.exitCode).toBeUndefined();
  });
});

describe('PromptEventLog', () => {
  it('records events in order', () => {
    const log = new PromptEventLog();
    log.append({ type: 'prompt_start', ts: 1, byteOffset: 0 });
    log.append({ type: 'prompt_end', ts: 2, byteOffset: 10 });
    expect(log.size).toBe(2);
    expect(log.snapshot().map((e) => e.type)).toEqual(['prompt_start', 'prompt_end']);
  });

  it('caps at capacity with FIFO eviction', () => {
    const log = new PromptEventLog(3);
    log.append({ type: 'prompt_start', ts: 1, byteOffset: 0 });
    log.append({ type: 'prompt_end', ts: 2, byteOffset: 10 });
    log.append({ type: 'command_start', ts: 3, byteOffset: 20 });
    log.append({ type: 'command_end', ts: 4, byteOffset: 30, exitCode: 0 });
    expect(log.size).toBe(3);
    expect(log.snapshot()[0].type).toBe('prompt_end'); // oldest got evicted
  });

  it('recent(n) returns the last N events', () => {
    const log = new PromptEventLog();
    for (let i = 0; i < 5; i++) {
      log.append({ type: 'command_end', ts: i, byteOffset: i * 10, exitCode: 0 });
    }
    expect(log.recent(2).map((e) => e.ts)).toEqual([3, 4]);
    expect(log.recent(0)).toEqual([]);
  });

  it('since(offset) filters by strict byteOffset', () => {
    const log = new PromptEventLog();
    log.append({ type: 'prompt_start', ts: 1, byteOffset: 10 });
    log.append({ type: 'command_start', ts: 2, byteOffset: 20 });
    log.append({ type: 'command_end', ts: 3, byteOffset: 30, exitCode: 0 });
    expect(log.since(15).map((e) => e.ts)).toEqual([2, 3]);
    expect(log.since(30)).toEqual([]);
  });

  it('lastCompletedCommandRange pairs the newest command_start/command_end', () => {
    const log = new PromptEventLog();
    log.append({ type: 'prompt_start', ts: 1, byteOffset: 0 });
    log.append({ type: 'prompt_end', ts: 2, byteOffset: 10 });
    log.append({ type: 'command_start', ts: 3, byteOffset: 20 });
    log.append({ type: 'command_end', ts: 4, byteOffset: 50, exitCode: 0 });
    log.append({ type: 'prompt_start', ts: 5, byteOffset: 60 });
    log.append({ type: 'prompt_end', ts: 6, byteOffset: 70 });
    log.append({ type: 'command_start', ts: 7, byteOffset: 80 });
    log.append({ type: 'command_end', ts: 8, byteOffset: 120, exitCode: 2 });

    expect(log.lastCompletedCommandRange()).toEqual({
      startOffset: 80,
      endOffset: 120,
      exitCode: 2,
    });
  });

  it('lastCompletedCommandRange returns null when no command_end is present', () => {
    const log = new PromptEventLog();
    log.append({ type: 'prompt_start', ts: 1, byteOffset: 0 });
    log.append({ type: 'command_start', ts: 2, byteOffset: 10 });
    expect(log.lastCompletedCommandRange()).toBeNull();
  });

  it('clear() resets events', () => {
    const log = new PromptEventLog();
    log.append({ type: 'prompt_start', ts: 1, byteOffset: 0 });
    log.clear();
    expect(log.size).toBe(0);
  });
});

describe('isCommandRunning (OSC 133 resume-chip gate)', () => {
  const A = { type: 'prompt_start' as const, ts: 1, byteOffset: 0 };
  const C = { type: 'command_start' as const, ts: 2, byteOffset: 10 };
  const D = { type: 'command_end' as const, ts: 3, byteOffset: 20, exitCode: 0 };

  it('empty log → false (no decisive marker; caller treats size 0 as unknown)', () => {
    expect(new PromptEventLog().isCommandRunning()).toBe(false);
  });

  it('command_start with no matching end → true (foreground command up)', () => {
    const log = new PromptEventLog();
    log.append(A); log.append(C);
    expect(log.isCommandRunning()).toBe(true);
  });

  it('command_start then command_end → false (back at prompt)', () => {
    const log = new PromptEventLog();
    log.append(A); log.append(C); log.append(D);
    expect(log.isCommandRunning()).toBe(false);
  });

  it('prompt_start after a finished command → false (shell ready for input)', () => {
    const log = new PromptEventLog();
    log.append(C); log.append(D); log.append(A);
    expect(log.isCommandRunning()).toBe(false);
  });

  it('re-launch (…D, A, C) → true again (second command running)', () => {
    const log = new PromptEventLog();
    log.append(C); log.append(D); log.append(A); log.append(C);
    expect(log.isCommandRunning()).toBe(true);
  });
});
