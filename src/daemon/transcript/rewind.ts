// A Claude rewind (Esc Esc) writes nothing by itself. The next prompt is
// written as a sibling of the message the user rewound to: both name the same
// parent. The abandoned run, and every answer on it, stays in the file, so a
// linear projection kept showing it.
//
// The transcript is a tree even without a rewind: every parallel tool call
// forks (an `assistant` tool_use and a `user` tool_result share a parent), and
// on 2.1.29x-2.1.31x a compact boundary's `logicalParentUuid` can point FORWARD
// to an entry written after it. So the live conversation is NOT "the chain from
// the newest entry": that walk dropped live tool results and stopped at the
// last compaction. What is detected instead is the rewind's own signature,
// measured over 400 real transcripts: a new human prompt whose parent already
// has an earlier human prompt child (33 such forks, all of them two human
// prompts; no parallel-tool or hook fork matched). Only that earlier prompt and
// its descendants are hidden. Anything whose link cannot be followed stays
// visible: showing an abandoned row is a smaller harm than hiding a live one.
//
// Known gaps: a rewind to the very first message writes two prompts with no
// parent at all, which is not a fork, and is not detected. A rewind further
// back than the first scan (REWIND_FIRST_SCAN_BYTES before the end of the file
// when a pane is first read), or over a run longer than REWIND_RUN_MAX_BYTES,
// is not detected and its rows stay.

import { transcriptLineLink } from './parseEntry';
import { isLineBoundary, readRange, statTranscript } from './readTail';
import type { TurnEvent } from '../../shared/transcript/turnEvents';

/** A main-thread entry's place in the conversation tree. */
export interface EntryLink {
  uuid: string;
  parentUuid?: string;
  /** A compact boundary's link to the conversation before it (its `parentUuid` is null). */
  logicalParentUuid?: string;
  /** A `user` entry the operator typed: it projects to a `user_text` row. */
  prompt: boolean;
}

export interface RewindAnalysis {
  /** Entries on an abandoned branch. */
  abandoned: Set<string>;
  /** The prompts whose arrival abandoned a branch. */
  rewinds: Set<string>;
}

/** `links` in file order. Never loops: a link only reaches an entry written before it. */
export function analyzeRewinds(links: readonly EntryLink[]): RewindAnalysis {
  /** uuid → its parent, when that parent was read before it. */
  const parentOf = new Map<string, string | undefined>();
  const promptsUnder = new Map<string, string[]>();
  const roots = new Set<string>();
  const rewinds = new Set<string>();
  for (const link of links) {
    if (parentOf.has(link.uuid)) continue;
    // A forward `logicalParentUuid` names an entry not written yet: no link.
    const logical = link.logicalParentUuid !== undefined && parentOf.has(link.logicalParentUuid) ? link.logicalParentUuid : undefined;
    const key = link.parentUuid ?? logical;
    parentOf.set(link.uuid, key !== undefined && parentOf.has(key) ? key : undefined);
    if (!link.prompt || key === undefined) continue;
    const earlier = promptsUnder.get(key) ?? [];
    if (earlier.length) {
      for (const uuid of earlier) roots.add(uuid);
      rewinds.add(link.uuid);
    }
    promptsUnder.set(key, [...earlier, link.uuid]);
  }
  const abandoned = new Set<string>();
  if (!roots.size) return { abandoned, rewinds };
  const verdict = new Map<string, boolean>();
  for (const uuid of parentOf.keys()) {
    const path: string[] = [];
    let at: string | undefined = uuid;
    let hit = false;
    while (at !== undefined) {
      const known = verdict.get(at);
      if (known !== undefined) { hit = known; break; }
      path.push(at);
      if (roots.has(at)) { hit = true; break; }
      at = parentOf.get(at);
    }
    for (const step of path) verdict.set(step, hit);
    if (hit) for (const step of path) abandoned.add(step);
  }
  return { abandoned, rewinds };
}

/** How far back the first read of a transcript looks for prompts. */
export const REWIND_FIRST_SCAN_BYTES = 16 * 1024 * 1024;
/** The longest abandoned run read back to find its rows. */
export const REWIND_RUN_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const USER_KEY = Buffer.from('"type":"user"');
const TOOL_RESULT_KEY = Buffer.from('"type":"tool_result"');

/**
 * Each complete line in `[from, to)`, with its byte offset. A `from` inside a
 * line skips to the next one. Returns where the last complete line ended.
 */
function forEachLine(transcriptPath: string, from: number, to: number, midLine: boolean,
  fn: (line: Buffer, offset: number, end: number) => void): number {
  let at = from;
  let skip = midLine;
  let carry: Buffer = Buffer.alloc(0);
  let carryStart = from;
  let end = from;
  while (at < to) {
    const chunk = readRange(transcriptPath, at, Math.min(CHUNK_BYTES, to - at));
    if (!chunk || chunk.length === 0) break;
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, start)) {
      if (!skip) fn(buf.subarray(start, nl), carryStart + start, carryStart + nl + 1);
      skip = false;
      start = nl + 1;
      end = carryStart + start;
    }
    carry = buf.subarray(start);
    carryStart += start;
    at += chunk.length;
  }
  return end;
}

/**
 * The abandoned branches of one transcript, kept as the file grows so every
 * reader (snapshot, older page, delta, push, search) gives the same verdict
 * on the same row. Only `user` prompt lines are parsed while scanning; a
 * run's lines are parsed once, when a later prompt abandons it.
 */
export class RewindIndex {
  private ino = -1;
  private scanned = 0;
  /** Parent uuid → the prompts written under it, with their line offsets. */
  private prompts = new Map<string, Array<{ uuid: string; offset: number }>>();
  /** Prompt uuids already counted. */
  private seen = new Set<string>();
  /** Each rewind: the abandoned prompt's offset and the replacing prompt's line end. */
  private rewinds: Array<{ from: number; at: number }> = [];
  private abandoned = new Set<string>();

  constructor(private readonly transcriptPath: string) {}

  /** Reads the lines written since the last call. */
  update(): void {
    const stat = statTranscript(this.transcriptPath);
    if (!stat) return;
    // A replaced file, or one rewritten in place (the scan point is no longer
    // a line start), is scanned afresh.
    if (stat.ino !== this.ino || stat.size < this.scanned || this.scanned > 0 && !isLineBoundary(this.transcriptPath, this.scanned)) {
      this.ino = stat.ino;
      this.scanned = Math.max(0, stat.size - REWIND_FIRST_SCAN_BYTES);
      this.prompts = new Map();
      this.seen = new Set();
      this.rewinds = [];
      this.abandoned = new Set();
      this.scanned = this.scan(this.scanned, stat.size, this.scanned > 0);
      return;
    }
    if (stat.size > this.scanned) this.scanned = this.scan(this.scanned, stat.size, false);
  }

  private scan(from: number, to: number, midLine: boolean): number {
    return forEachLine(this.transcriptPath, from, to, midLine, (line, offset, end) => {
      // Only a `user` line that is not a tool result can be a prompt; the rest
      // (most of the bytes) are not decoded here. Quotes inside a message are
      // escaped in the JSON, so these keys match only the entry's own fields.
      if (line.indexOf(USER_KEY) < 0 || line.indexOf(TOOL_RESULT_KEY) >= 0) return;
      const link = transcriptLineLink(line.toString('utf8'), offset);
      const key = link?.prompt ? link.parentUuid ?? link.logicalParentUuid : undefined;
      // The same entry written twice is one prompt, not a rewind.
      if (!link || key === undefined || this.seen.has(link.uuid)) return;
      this.seen.add(link.uuid);
      const earlier = this.prompts.get(key) ?? [];
      for (const prior of earlier) this.abandon(prior.offset, end);
      this.prompts.set(key, [...earlier, { uuid: link.uuid, offset }]);
    });
  }

  /**
   * Reads the run from the abandoned prompt through the one that replaced it,
   * once. A run longer than REWIND_RUN_MAX_BYTES is left visible: its rows
   * cannot be proven to descend from the abandoned prompt without reading it.
   */
  private abandon(from: number, at: number): void {
    if (at - from > REWIND_RUN_MAX_BYTES) return;
    this.rewinds.push({ from, at });
    const links: EntryLink[] = [];
    forEachLine(this.transcriptPath, from, at, false, (line, offset) => {
      const link = transcriptLineLink(line.toString('utf8'), offset);
      if (link) links.push(link);
    });
    for (const uuid of analyzeRewinds(links).abandoned) this.abandoned.add(uuid);
  }

  /**
   * Whether a reader whose rows end at `offset` holds part of a branch a later
   * prompt abandoned: it read the abandoned prompt but not its replacement.
   */
  heldAbandoned(offset: number): boolean {
    return this.rewinds.some((r) => r.from < offset && offset < r.at);
  }

  /** Whether a row (by its event id: the entry uuid, `#n` for a later row of it) is abandoned. */
  isAbandoned(eventId: string): boolean {
    if (!this.abandoned.size) return false;
    const hash = eventId.indexOf('#');
    return this.abandoned.has(hash < 0 ? eventId : eventId.slice(0, hash));
  }

  /** `events` without the rows of an abandoned branch. */
  prune(events: TurnEvent[]): TurnEvent[] {
    return this.abandoned.size ? events.filter((event) => !this.isAbandoned(event.id)) : events;
  }
}
