/**
 * Structured prompt/command event log populated from OSC 133 shell
 * integration markers. Designed as a companion to RingBuffer: RingBuffer
 * stores raw bytes; PromptEventLog stores the semantic boundaries that let
 * AI agents ask for "last command output" instead of parsing a viewport.
 *
 * Capacity is bounded (default 256 events) and eviction is FIFO. Offsets
 * are cumulative-bytes counters supplied by the caller (typically a
 * RingBuffer that tracks totalBytesWritten), so callers can correlate an
 * event to a position in the raw stream.
 */

export type PromptEventType =
  | 'prompt_start'    // OSC 133 ; A  — shell is ready for user input
  | 'prompt_end'      // OSC 133 ; B  — prompt drawn, before user input
  | 'command_start'   // OSC 133 ; C  — user pressed Enter, output follows
  | 'command_end';    // OSC 133 ; D  — command finished (exitCode set)

export interface PromptEvent {
  type: PromptEventType;
  /** epoch ms when the event was observed */
  ts: number;
  /** monotonic byte offset (total bytes written to the PTY stream so far) */
  byteOffset: number;
  /** only present on 'command_end' */
  exitCode?: number;
}

export class PromptEventLog {
  private events: PromptEvent[] = [];
  private readonly capacity: number;

  constructor(capacity = 256) {
    if (capacity <= 0 || !Number.isInteger(capacity)) {
      throw new Error('capacity must be a positive integer');
    }
    this.capacity = capacity;
  }

  append(event: PromptEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      // FIFO eviction — drop oldest
      this.events.splice(0, this.events.length - this.capacity);
    }
  }

  /** Return the N most recent events, oldest-first. */
  recent(n: number): PromptEvent[] {
    if (n <= 0) return [];
    return this.events.slice(-n);
  }

  /** Return all events with byteOffset strictly greater than `offset`. */
  since(offset: number): PromptEvent[] {
    return this.events.filter((e) => e.byteOffset > offset);
  }

  /**
   * Return the [startOffset, endOffset] byte range bracketing the most
   * recently completed command, or null if no fully-finished command is
   * present (need matching command_start / command_end).
   */
  lastCompletedCommandRange(): { startOffset: number; endOffset: number; exitCode: number | null } | null {
    // Walk backwards for the newest command_end, then pair with its command_start
    for (let i = this.events.length - 1; i >= 0; i--) {
      const end = this.events[i];
      if (end.type !== 'command_end') continue;
      // Find nearest command_start preceding this end
      for (let j = i - 1; j >= 0; j--) {
        const start = this.events[j];
        if (start.type === 'command_start') {
          return {
            startOffset: start.byteOffset,
            endOffset: end.byteOffset,
            exitCode: end.exitCode ?? null,
          };
        }
      }
      return null;
    }
    return null;
  }

  /**
   * Whether a FOREGROUND command is currently running in the shell (OSC 133).
   * True between a `command_start` (C) and its `command_end` (D) — i.e. an
   * interactive agent like `claude` is up, or any other command is executing.
   * False when the shell is at a prompt waiting for input (last decisive marker
   * is `command_end` / `prompt_start` / `prompt_end`).
   *
   * Used as the AUTHORITATIVE resume-chip gate: typing a resume command while a
   * foreground command owns the PTY would land in that command's stdin, not a
   * shell, so the chip must stay hidden until we are back at a prompt. Only
   * meaningful when shell integration actually emits markers — callers check
   * `size > 0` first and treat an empty log as "unknown" (heuristic fallback).
   */
  isCommandRunning(): boolean {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const t = this.events[i].type;
      if (t === 'command_start') return true;
      if (t === 'command_end' || t === 'prompt_start' || t === 'prompt_end') return false;
    }
    return false; // no decisive marker yet → assume at prompt
  }

  get size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
  }

  /** Test / debugging aid — returns a shallow copy. */
  snapshot(): PromptEvent[] {
    return this.events.slice();
  }
}

/**
 * Parse an OSC 133 payload (the portion after "133;") into a PromptEvent
 * shape. Returns null for unrecognized subcommands.
 *
 * Accepted forms:
 *   A            → prompt_start
 *   B            → prompt_end
 *   C            → command_start
 *   D            → command_end (exitCode unknown)
 *   D;<int>      → command_end with exitCode
 *
 * Ghostty / VS Code dialects sometimes attach extra ;k=v pairs; we ignore
 * anything past what we understand rather than rejecting.
 */
export function parseOsc133Payload(
  payload: string,
  now: number,
  byteOffset: number,
): PromptEvent | null {
  if (!payload || payload.length === 0) return null;
  const parts = payload.split(';');
  const subcommand = parts[0];
  switch (subcommand) {
    case 'A':
      return { type: 'prompt_start', ts: now, byteOffset };
    case 'B':
      return { type: 'prompt_end', ts: now, byteOffset };
    case 'C':
      return { type: 'command_start', ts: now, byteOffset };
    case 'D': {
      const raw = parts[1];
      if (raw === undefined || raw.length === 0) {
        return { type: 'command_end', ts: now, byteOffset };
      }
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) {
        return { type: 'command_end', ts: now, byteOffset };
      }
      return { type: 'command_end', ts: now, byteOffset, exitCode: parsed };
    }
    default:
      return null;
  }
}
