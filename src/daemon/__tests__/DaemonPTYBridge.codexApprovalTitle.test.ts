// Codex keeps `[ ! ] Action Required | …` in its window title while an
// approval box waits (blinking with `[ . ]`, captured on 0.163.0). Without the
// PermissionRequest hook that title is the dependable sign: the question on
// screen wraps on a narrow pane and arrives in cursor-addressed pieces.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import { PromptEventLog } from '../PromptEventLog';

const BANNER = '\x1b[9;1H│ >_ OpenAI Codex (v0.163.0)            │\r\n';
const CODEX_MODES = '\x1b[?2004h\x1b[?1049h';
const title = (t: string) => `\x1b]0;${t}\x07`;

function makeFakePty(): { pty: IPty; feed: (data: string) => void } {
  let dataHandler: ((data: string) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

describe('DaemonPTYBridge — a Codex approval title reads as waiting on a human', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let agentEvents: Array<{ status: string; agent: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
    bridge.noteAgentProcess({ slug: 'codex', alive: true });
    feed(CODEX_MODES + BANNER);
    vi.advanceTimersByTime(6_000);
    agentEvents = [];
    bridge.on('agent', (e: { event: { status: string; agent: string } }) => agentEvents.push(e.event));
    // A turn is running.
    bridge.noteInput('create hello.txt\r');
    feed('working\r\n');
    feed(title('⠙ Create hello.txt | work'));
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  const blink = (seconds: number) => {
    for (let i = 0; i < seconds * 2; i++) {
      feed(title(`[ ${i % 2 ? '.' : '!'} ] Action Required | Create hello.txt | work`));
      vi.advanceTimersByTime(500);
    }
  };

  it('raises awaiting_input once while the title blinks, and the answer clears it', () => {
    blink(10);
    expect(agentEvents.filter((e) => e.status === 'awaiting_input')).toEqual([
      expect.objectContaining({ status: 'awaiting_input', agent: 'Codex CLI' }),
    ]);
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
    // The human approves with `y`, which no keystroke rule reads as an
    // answer; the title dropping the box does, and the spinner reports running.
    bridge.noteInput('y');
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
    feed(title('⠹ Create hello.txt | work'));
    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
    // A second approval in the same turn is raised again.
    blink(2);
    expect(agentEvents.filter((e) => e.status === 'awaiting_input')).toHaveLength(2);
  });

  it('the title dropping the box releases it as an answered dialog', () => {
    const answered: Array<{ reason?: string }> = [];
    bridge.on('answered', (e: { reason?: string }) => answered.push(e));
    blink(2);
    feed(title('Create hello.txt | work'));
    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
    expect(answered).toEqual([expect.objectContaining({ reason: 'screen-cleared' })]);
  });

  it('a box withdrawn with its turn (no spinner, no more output) settles, never stuck running', () => {
    blink(2);
    feed(title('Create hello.txt | work'));
    vi.advanceTimersByTime(600_000);
    expect(bridge.getAgentStatus()).not.toBe('running');
    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
    expect(bridge.isTurnOpen()).toBe(false);
  });

  it('a turn the spinner opened stays the spinner\'s through an approval, and ends when the frame drops', () => {
    bridge.noteAgentStatus('complete'); // a detector settle closes the submitted turn
    vi.advanceTimersByTime(7_000);
    feed(title('⠋ Create hello.txt | work'));
    feed(title('⠙ Create hello.txt | work')); // the title opens a turn
    expect(bridge.isTurnOpen()).toBe(true);
    blink(2);
    feed(title('⠹ Create hello.txt | work')); // approved, still working
    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
    feed(title('Create hello.txt | work')); // done
    vi.advanceTimersByTime(10_000);
    expect(bridge.isTurnOpen()).toBe(false);
  });

  it('answering with a key the bridge reads (Esc, Enter) keeps a spinner-opened turn the spinner\'s', () => {
    bridge.noteAgentStatus('complete');
    vi.advanceTimersByTime(7_000);
    feed(title('⠋ Create hello.txt | work'));
    feed(title('⠙ Create hello.txt | work'));
    blink(2);
    bridge.noteInput('\x1b'); // denied with Esc
    feed(title('⠹ Create hello.txt | work'));
    feed(title('Create hello.txt | work'));
    vi.advanceTimersByTime(10_000);
    expect(bridge.isTurnOpen()).toBe(false);
  });

  it('a later detector match of the same box keeps the title answering for it', () => {
    blink(1);
    bridge.noteAgentStatus('awaiting_input'); // the question line completes in a later chunk
    feed(title('⠹ Create hello.txt | work'));
    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
  });

  it('a detector match after the hook does not hand a hook\'s dialog to the title', () => {
    blink(1);
    bridge.noteAgentStatus('awaiting_input', true);
    bridge.noteAgentStatus('awaiting_input');
    feed(title('⠹ Create hello.txt | work'));
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
  });

  it('a dialog the detector raised first also ends when the title drops the box', () => {
    bridge.noteAgentStatus('awaiting_input'); // the detector matched the question line
    blink(2);
    bridge.noteInput('y');
    feed(title('⠹ Create hello.txt | work'));
    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
  });

  it('a dialog a hook raised is not ended by the title', () => {
    blink(1);
    bridge.noteAgentStatus('awaiting_input', true); // the PermissionRequest hook for the same box
    feed(title('⠹ Create hello.txt | work'));
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
  });

  it('the question line matching after the title raised the box adds no second approval event', () => {
    blink(1);
    feed('\x1b[20;1H  Would you like to run the following command?\r\n');
    blink(2);
    expect(agentEvents.filter((e) => e.status === 'awaiting_input')).toHaveLength(1);
  });

  it('a `y` that answered the box leaves no draft in the composer, and a real draft survives', () => {
    blink(1);
    bridge.noteInput('y');
    feed(title('⠹ Create hello.txt | work'));
    expect(bridge.hasDraft()).toBe(false);
    bridge.noteInput('half a thought');
    blink(1);
    bridge.noteInput('p');
    feed(title('⠹ Create hello.txt | work'));
    expect(bridge.hasDraft()).toBe(true);
    // Text typed once the box is gone is the composer's again.
    bridge.noteInput('\x15');
    blink(1);
    bridge.noteInput('y');
    feed(title('⠹ Create hello.txt | work'));
    bridge.noteInput('next');
    expect(bridge.hasDraft()).toBe(true);
  });

  it('reads the title only for a pane the process tracker attributes to Codex', () => {
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    blink(4);
    bridge.noteAgentProcess({ slug: 'codex', alive: false });
    blink(4);
    expect(agentEvents.filter((e) => e.status === 'awaiting_input')).toHaveLength(0);
  });

  it('adds nothing when the PermissionRequest hook already raised the dialog', () => {
    bridge.noteAgentStatus('awaiting_input', true);
    blink(4);
    expect(agentEvents.filter((e) => e.status === 'awaiting_input')).toHaveLength(0);
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
  });
});
