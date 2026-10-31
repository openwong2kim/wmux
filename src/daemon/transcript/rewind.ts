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
// its descendants are hidden. Anything whose link cannot be followed inside the
// read stays visible: showing an abandoned row is a smaller harm than hiding a
// live one.
//
// Known gap: a rewind to the very first message writes two prompts with no
// parent at all. That is not a fork, and it is not detected.

import type { TurnEvent } from '../../shared/transcript/turnEvents';
import type { ParsedTranscriptLine } from './parseEntry';

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
      if (roots.has(at)) { hit = true; path.push(at); break; }
      path.push(at);
      at = parentOf.get(at);
    }
    for (const step of path) verdict.set(step, hit);
    if (hit) for (const step of path) abandoned.add(step);
  }
  return { abandoned, rewinds };
}

/**
 * Wraps a line parser for one read: records each line's link and the rows it
 * produced, so the read's rows can be pruned once the whole window is known.
 * One recorder per read attempt.
 */
export function rewindRecorder(parse: (line: string, offset: number) => ParsedTranscriptLine) {
  const links: EntryLink[] = [];
  const owner = new Map<TurnEvent, string>();
  return {
    links,
    parseLine: (line: string, offset: number): TurnEvent[] => {
      const parsed = parse(line, offset);
      if (parsed.link) {
        links.push(parsed.link);
        for (const event of parsed.events) owner.set(event, parsed.link.uuid);
      }
      return parsed.events;
    },
    /** `events` without the rows of an abandoned branch. */
    prune(events: TurnEvent[], analysis = analyzeRewinds(links)): TurnEvent[] {
      if (!analysis.abandoned.size) return events;
      return events.filter((event) => !analysis.abandoned.has(owner.get(event) ?? ''));
    },
  };
}
