// Orchestrator wave 2 — the brain is told to press with `approval_press`, not
// with keystrokes.
//
// This is the sentence that produced the behaviour wave 1 measured: the prompt
// said "you MAY press it with terminal_send_key", so the brain typed. Typing at
// a recorded prompt is now REFUSED for a commander (input.rpc.ts), which would
// make the old wording an instruction to make a call the substrate rejects. The
// assertions below pin the tool name, the pane id it must carry, and the
// next-step contract — the three things a brain needs to act without guessing.

import { describe, it, expect } from 'vitest';
import { buildEventPrompt, type BufferedEvent } from '../CommanderEventCoalescer';
import { DEFAULT_AUTONOMY } from '../deckAutonomyStore';

const BUDGET = { remaining: 5, total: 5 };
const PRESS_ON = { ...DEFAULT_AUTONOMY, approvalPress: true };

function awaiting(over: Partial<BufferedEvent> = {}): BufferedEvent {
  return {
    ptyId: 'pty-worker',
    kind: 'agent.awaiting_input',
    source: 'hook',
    agent: 'claude',
    seq: 1,
    ts: 0,
    ...over,
  };
}

describe('the awaiting_input verdict', () => {
  it('names approval_press with the pane, the status, and the task to wait on', () => {
    const prompt = buildEventPrompt(
      [awaiting({ task: { taskId: 'wtask-7', taskWorkspaceId: 'ws-task' } })],
      PRESS_ON,
      BUDGET,
    );

    expect(prompt).toContain('worker-task=wtask-7');
    expect(prompt).toContain('status=awaiting_input');
    expect(prompt).toContain('approval_press({ ptyId: "pty-worker", decision: "approve" })');
    // The next-step contract: press, then stop — the worker's own event wakes
    // the brain again, so it must not sit on the pane burning the turn.
    expect(prompt).toContain('END YOUR TURN — task wtask-7 runs on');
    // And the move it replaces is gone from this verdict.
    expect(prompt).not.toContain('press it with terminal_send_key');
  });

  it('still makes a regex-detected prompt be VERIFIED first, and explains the detector-only refusal', () => {
    const prompt = buildEventPrompt([awaiting({ source: 'detector' })], PRESS_ON, BUDGET);

    expect(prompt).toContain('VERIFY THEN PRESS');
    expect(prompt).toContain('terminal_read this pane first');
    expect(prompt).toContain('approval_press({ ptyId: "pty-worker", decision: "approve" })');
    expect(prompt).toContain('detector-only');
  });

  it('is unchanged when the workspace may not press: notify only, no tool named', () => {
    const prompt = buildEventPrompt(
      [awaiting()],
      { ...DEFAULT_AUTONOMY, approvalPress: false },
      BUDGET,
    );

    expect(prompt).toContain('(NOTIFY ONLY, do NOT approve)');
    expect(prompt).not.toContain('approval_press');
  });
});

describe('the blocked-on-a-question verdict', () => {
  it('sends a recorded prompt to approval_press and keeps terminal_send for a printed one', () => {
    const prompt = buildEventPrompt(
      [
        {
          ptyId: 'pty-worker',
          kind: 'agent.stop',
          source: 'hook',
          agent: 'claude',
          seq: 1,
          ts: 0,
          lastMessage: { text: 'Which branch should I use?', endsWithQuestion: true },
        },
      ],
      { ...PRESS_ON, continueInstruction: true },
      BUDGET,
    );

    expect(prompt).toContain('approval_press({ptyId, decision})');
    expect(prompt).toContain('typing at a recorded prompt is refused');
    // A question the pane merely PRINTED has no approval record, so the typed
    // path is the only one that exists for it and must survive.
    expect(prompt).toContain('terminal_send({text, submit:true})');
  });
});
