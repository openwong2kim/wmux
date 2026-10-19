// F26 — has the shell read a line since the pane started?
import { describe, it, expect } from 'vitest';
import { promptLineState, IDLE_PROMPT_SLACK_BYTES } from '../promptLineState';

// bash's first prompt: `D;$? A` from PROMPT_COMMAND, then PS1 ending in B.
const firstPrompt = [
  { type: 'command_end', byteOffset: 40 },
  { type: 'prompt_start', byteOffset: 40 },
  { type: 'prompt_end', byteOffset: 180 },
];

describe('promptLineState', () => {
  it('a shell at its first prompt that wrote nothing since is idle', () => {
    expect(promptLineState(firstPrompt, 180)).toBe('idle-at-prompt');
    expect(promptLineState(firstPrompt, 180 + IDLE_PROMPT_SLACK_BYTES)).toBe('idle-at-prompt');
  });

  it('the first D before any prompt is not a read', () => {
    expect(promptLineState(firstPrompt.slice(0, 1), 40)).toBe('unknown');
  });

  it('a command-start is a read', () => {
    expect(promptLineState([...firstPrompt, { type: 'command_start', byteOffset: 260 }], 260)).toBe('read');
  });

  it('a return to the prompt after a line is a read, even without a command-start', () => {
    // bash could not parse the line: no PS0, but D;2 and a new prompt.
    expect(
      promptLineState(
        [...firstPrompt, { type: 'command_end', byteOffset: 300 }, { type: 'prompt_start', byteOffset: 300 }, { type: 'prompt_end', byteOffset: 400 }],
        400,
      ),
    ).toBe('read');
  });

  it('output after the prompt is no evidence (an echoed line, or a program under a bash without PS0)', () => {
    expect(promptLineState(firstPrompt, 180 + IDLE_PROMPT_SLACK_BYTES + 1)).toBe('unknown');
    // A caller that judges stillness over time itself allows any amount.
    expect(promptLineState(firstPrompt, 5_000, Number.POSITIVE_INFINITY)).toBe('idle-at-prompt');
  });

  it('no markers, or a prompt not drawn yet, is unknown', () => {
    expect(promptLineState([], 1_000)).toBe('unknown');
    expect(promptLineState(firstPrompt.slice(0, 2), 40)).toBe('unknown');
  });
});
