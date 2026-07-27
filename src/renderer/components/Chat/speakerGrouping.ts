// Speaker grouping for Chat View rows — pure, no React.
//
// A single agent turn is normally MANY events (text, a tool run, more text).
// Labelling each of them printed "Claude Code" twice around a collapsed tool
// line and the one turn read as two. So the label is printed once per SPEAKER
// RUN: a row shows it only when the speaker differs from the previous
// speaker-bearing row.
//
// Machine evidence — tool runs, diff chips, meta lines — carries no speaker and
// therefore never interrupts a run: it is what the current speaker was doing,
// not someone else talking.

import type { ChatRowModel } from './foldToolRuns';

export type ChatSpeaker = 'you' | 'agent';

/** The speaker a row belongs to, or null when the row is machine evidence. */
export function rowSpeaker(row: ChatRowModel): ChatSpeaker | null {
  if (row.kind !== 'event') return null;
  if (row.event.kind === 'user_text') return 'you';
  if (row.event.kind === 'assistant_text') return 'agent';
  return null;
}

/** `flags[i]` = row i opens a new speaker run and prints the label. */
export function speakerLabelFlags(rows: readonly ChatRowModel[]): boolean[] {
  const flags: boolean[] = [];
  let current: ChatSpeaker | null = null;
  for (const row of rows) {
    const speaker = rowSpeaker(row);
    if (speaker === null) {
      flags.push(false);
      continue;
    }
    flags.push(speaker !== current);
    current = speaker;
  }
  return flags;
}

/** Speaker of the last speaker-bearing row — what an optimistic echo follows. */
export function trailingSpeaker(rows: readonly ChatRowModel[]): ChatSpeaker | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const speaker = rowSpeaker(rows[i]);
    if (speaker !== null) return speaker;
  }
  return null;
}
