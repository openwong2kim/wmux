// Speaker runs (speakerGrouping.ts) — pure, no DOM.
//
// The live defect: "Claude Code", a collapsed tool line, "Claude Code" again —
// one turn reading as two. A speaker label belongs to a RUN, and machine
// evidence between two of that speaker's events does not end the run.

import { describe, it, expect } from 'vitest';
import { foldToolRuns } from '../foldToolRuns';
import { speakerLabelFlags, trailingSpeaker, rowSpeaker } from '../speakerGrouping';
import type { TurnEvent } from '../../../../shared/transcript/turnEvents';

const rowsOf = (events: TurnEvent[]) => foldToolRuns(events);

describe('speakerLabelFlags', () => {
  it('labels a speaker change and nothing else', () => {
    const rows = rowsOf([
      { id: 'u1', kind: 'user_text', text: 'go' },
      { id: 'a1', kind: 'assistant_text', text: 'on it' },
      { id: 'a2', kind: 'assistant_text', text: 'and done' },
      { id: 'u2', kind: 'user_text', text: 'thanks' },
    ]);
    expect(speakerLabelFlags(rows)).toEqual([true, true, false, true]);
  });

  it('does NOT restart the agent label across a tool run', () => {
    const rows = rowsOf([
      { id: 'a1', kind: 'assistant_text', text: 'reading the file' },
      { id: 't1', kind: 'tool_use', toolUseId: 'x1', name: 'Read', argSummary: 'a.ts' },
      { id: 'r1', kind: 'tool_result', toolUseId: 'x1', ok: true, bytes: 12 },
      { id: 'a2', kind: 'assistant_text', text: 'patched it' },
    ]);
    // [assistant text, folded run, assistant text] → the label prints once.
    expect(rows).toHaveLength(3);
    expect(speakerLabelFlags(rows)).toEqual([true, false, false]);
  });

  it('does not let a meta line or a diff chip break a run either', () => {
    const rows = rowsOf([
      { id: 'a1', kind: 'assistant_text', text: 'first' },
      { id: 'm1', kind: 'meta', subtype: 'slash_command', label: '/clear' },
      { id: 't1', kind: 'tool_use', toolUseId: 'x1', name: 'Bash', argSummary: 'git diff' },
      { id: 'r1', kind: 'tool_result', toolUseId: 'x1', ok: true, bytes: 40, diffLike: true },
      { id: 'a2', kind: 'assistant_text', text: 'second' },
    ]);
    const flags = speakerLabelFlags(rows);
    expect(flags[0]).toBe(true);
    expect(flags.slice(1).some(Boolean)).toBe(false);
  });

  it('treats thinking as the agent speaking, not a third party', () => {
    const rows = rowsOf([
      { id: 'a1', kind: 'assistant_text', text: 'hmm', thinking: true },
      { id: 'a2', kind: 'assistant_text', text: 'here goes' },
    ]);
    expect(speakerLabelFlags(rows)).toEqual([true, false]);
  });

  it('reports no speaker for machine evidence', () => {
    const rows = rowsOf([
      { id: 't1', kind: 'tool_use', toolUseId: 'x1', name: 'Read', argSummary: 'a.ts' },
    ]);
    expect(rowSpeaker(rows[0])).toBeNull();
  });
});

describe('trailingSpeaker', () => {
  it('skips machine evidence to find who last spoke', () => {
    const rows = rowsOf([
      { id: 'u1', kind: 'user_text', text: 'go' },
      { id: 't1', kind: 'tool_use', toolUseId: 'x1', name: 'Read', argSummary: 'a.ts' },
    ]);
    expect(trailingSpeaker(rows)).toBe('you');
  });

  it('is null on an empty conversation', () => {
    expect(trailingSpeaker([])).toBeNull();
  });
});
