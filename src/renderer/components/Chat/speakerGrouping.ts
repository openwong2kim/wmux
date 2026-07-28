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

/**
 * `flags[i]` = row i belongs to an agent turn and carries the left rail.
 *
 * The rail is the agent side's counterweight to the human's card: the human
 * turn is right-aligned and boxed, so without it the agent's turn had no edge
 * of its own and the two sides read as a styled message next to unstyled page
 * text. It follows the same rule as the label — machine evidence belongs to
 * whoever is currently speaking, so a tool run inside an agent turn is railed
 * with the prose around it and the turn reads as one block.
 */
export function agentRunFlags(rows: readonly ChatRowModel[]): boolean[] {
  const flags: boolean[] = [];
  let current: ChatSpeaker | null = null;
  for (const row of rows) {
    const speaker = rowSpeaker(row);
    if (speaker !== null) current = speaker;
    // Evidence ahead of any speaker (current === null) is nobody's turn yet.
    flags.push(current === 'agent');
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
