// F24: Claude Code's idle recap (`※ recap: …`), or the full repaint when a
// viewer attaches, reopened a hook-reporting pane's turn after its Stop, and
// nothing ever closed it. Replays the daemon's wiring: hooks go to
// `noteAgentStatus(status, true)`, every stdin write to `noteInput`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';

/**
 * Real bytes, captured live. The ring of the F24 pane (a WSL Claude Code
 * worker on Windows) kept only the tail of what it painted after the Stop:
 * the end of the turn's summary, `✻ Worked for 40s · done 8:09 AM`, the
 * `※ recap: …` block, `Checking for updates`, then the start of the
 * repaint drawn when a viewer attached. 1540 bytes, under the 2 KB activity
 * threshold on its own, so it is followed by a recap frame Claude Code
 * painted on another pane (macOS, 80 columns; 1534 bytes). Both were drawn
 * under the idle `✳` window title, with no hook after the Stop.
 */
const F24_PANE_TAIL = Buffer.from([
  'dmVuIHRob3VnaBtbMjBHdGhlG1syNEdnYXRlG1syOUdmYWlsZWQuG1szN0dJdHMbWzQxR3N1bW1hcnkbWzQ5R3NheXMbWzU0',
  'R3RoZRtbNThHZ2F0ZQ0bWzJDG1sxQiAbWzVHZmFpbGVkLCBxdW90ZXMbWzIwR3RoZSAbWzI1R3Jyb3IgYW5kIGdpdmVzIBtb',
  'NDFHaGUgUFIbWzQ3R2xpbmsuG1s1M0dJG1s1NUdhbHNvDRtbMkMbWzFCICBwb3N0ZWQgdGhlIHJlc3VsdCBpbiB0aGUgbWlz',
  'c2lvbiBjaGFubmVsLhtbSw0bWzRDG1sxQhtbSw0bWzJDG1sxQlBSICMzOCBlZGl0cxtbMTZHdBtbMjBHc2FtZSBsaW5lLBtb',
  'MzFHc28bWzM0R3doaWNoZXZlciBvZiB0aBtbNTBHIHR3byBtZXJnZXMbW0sNG1syQxtbMUJzZWNvbmQgd2lsbCBjb25mbGlj',
  'dC4bW0sNG1s0QxtbMUIbW0sNG1sxQhtbMzg7NTsyNDZt4py7G1szR1dvcmtlZCBmb3IgNDBzIMK3IGRvbmUgODowOSBBTRtb',
  'MzltG1tLDRtbMkIbWzM4OzU7MjQ2beKAuxtbM0cbWzFtcmVjYXA6IBtbMjJtG1szbVRoZSB0YXNrIHdhcyB0byBzZXQgbGlu',
  'ZSAxIG9mIGUyZS13aW4vaGVsbG8udHh0IHRvIA0bWzJDG1sxQiJ2aWV3IGNoZWNrIDIiLCBhbmQgaXQncyBkb25lIGluIFBS',
  'ICMzOTsgbnBtIHRlc3QgZmFpbGVkIGFzIA0bWzJDG1sxQnlvdSBleHBlY3RlZC4gTmV4dCwgbWVyZ2UgZWl0aGVyICMzOSBv',
  'ciAjMzgsIHNpbmNlIGJvdGggZWRpdCANG1sxQhtbMjNtG1szOW0gG1szRxtbMzg7NTsyNDZtG1szbXRoYXQgbGluZSBhbmQg',
  'd2lsbCBjb25mbGljdC4gKGRpc2FibGUgcmVjYXBzIGluIC9jb25maWcpG1syM20bWzM5bRtbNDQ7MUgbWzQyOzNIG1s/MjVo',
  'G1s/MjVsG1tIDRtbNDJDG1szOUIbWzM4OzU7MjQ2bUNoZWNraW5nIGZvciB1cGRhdGVzG1szOW0bWzQ0OzFIG1s0MjszSBtb',
  'PzI1aBtbPzI1bBtbSA0bWzQyQxtbMzlCG1tLG1s0NDsxSBtbNDI7M0gbWz8yNWgbWz8yNWwbW0gbWzNHG1s0ODs1OzIzN20b',
  'WzM4OzU7MjMxbXRvb2wgKHdtdXggZmV0Y2hlG1syMUcgb3JpZ2luJ3MgZGVmYXVsdCBicmFuY2ggYW5kIHlvdXIgYnJhbmNo',
  'IA0bWzJDG1sxQndpdGggaXRzIG93G1sxNUcgY3JlZGVudGlhbHMpLCB0aGVuIGBnaXQgbWUbWzQzR2dlG1s0NkdvcmlnaW4v',
  'PGRlG1s1N0dhdWx0IBtbMzltIA0bWzJDG1sxQhtbMzg7NTsyMzFtYnJhbmNoPmAuIE5ldmVyIGEbWzIxR2sgZm9yIGNyZWRl',
  'bnRpYRtbMzdHcxtbMzlHdG8gZmV0Y2guG1szOW0gICAgICAgICAgICAgIA0bWzFCG1s0OW0bW0sNG1sxQiAgG1szODs1OzI0',
  'Nm1SYW4gG1sxbTIbWzIybSBzaGVsbCBjb21tYW5kcyAbWzM5bRtbSw0bWzJCG1szODs1OzIzMW3il48bWzNHG1szOW1HYXRl',
  'IGZhaWxzIGFzIGV4cGVjdGVkLhtbMjdHQ29tbWl0dGluZxtbMzhHYW5kG1s0MkdwdXNoaW5nLg0bWzJCIBtbM0cbWzM4OzU7',
  'MjQ2bUxpc3RlZCAbWzFtMRtbMjJtIGRpcmVjdG9yeSwgY2FsbGVkIE1DUCAbWzFtMxtbMjJtIHRpbWVzLCByYW4gG1sxbTMb',
  'WzIybSBzaGVsbCBjb21tYW5kcyANG1syMkMbWzJCchtbMjVHbiAbWzFtMhtbMjJtIHNoZWxsG1szNUdjb21tYW5kcxtbNDRH',
  'G1szOW0bW0sbWzQ0OzFIG1s0MjszSBtbPzI1aA==',
].join(''), 'base64').toString('utf8');
const RECAP_FRAME = Buffer.from([
  'G1s/MjVsG1tIG1szRy0bWzVHG1sxbUZvciB0aGUgZGVza3RvcCB0cmFjazoNG1s0QxtbMUIbWzIybS0bWzdHVGhlG1sxMUd0',
  'YXJiYWxsIGhhcyBvbmUgdG9wLWxldmVsIGZvbGRlciBuYW1lZCAbWzM4OzI7MTc3OzE4NTsyNDltPHZlcj4vG1szOW0uG1tL',
  'DRtbNEMbWzFCLRtbN0dUaGUgbWluaW11bRtbMTlHZ2xpYmMbWzI1R2lzG1syOEcyLjM0LBtbMzRHc2V0G1szOEdieRtbNDFH',
  'bm9kZS1wdHkbWzUwR2J1aWx0G1s1NkdvbhtbNTlHVWJ1bnR1G1s2NkcyMi4wNDsbWzczR05vZGUNG1s2QxtbMUJhbG9uZSAb',
  'WzE0R2VlZHMgMi4yOC4bW0sNG1s0QxtbMUItG1s3RxtbMzg7MjsxNzc7MTg1OzI0OW1yZXNvdXJjZXMvZGFlbW9uLXdlYhtb',
  'MjhHG1szOW1hbHNvG1szM0dzaGlwcywbWzQwR2JleW9uZBtbNDdHdGhlG1s1MUdjb250cmFjdCdzG1s2MkdmaWxlG1s2N0ds',
  'aXN0Lg0bWzJDG1sxQiAbWzVHLSBUaGUgZnV0dXJlIG5hdGl2ZSBjb3JlG1szMEdnb2VzG1szNUdhdBtbMzhHG1szODsyOzE3',
  'NzsxODU7MjQ5bXJlc291cmNlcy93bXV4LW5hdGl2ZS9pbmRleC5janMbWzM5bS4NG1syQxtbMUItG1s1RxtbMW1EZXZpYXRp',
  'b246G1syMm0gSSBwdXNoZWQgdHdpY2UgYWZ0G1szNUdyG1szN0dtYXJraW5nIHRoG1s0OEcgUFIgcmVhZHksG1s1OUd3aGlj',
  'aBtbNjVHYnJlYWtzG1s3Mkd0aGUNG1s0QxtbMUJvbmUtcHVzaCBydWxlLiBUaGUgc2Vjb25kIHB1c2ggYWRkZWQgdGgbWzQ1',
  'RyB0YXJiYWxsLXZzLW1hbmlmZXN0G1s2NkdjaGVjayB0aGF0IGNhbWUNG1s0QxtbMUJvdXQgG1sxMEdmIHRoG1sxNUcgZmlu',
  'YWwgcmV2aWV3Lg0bWzJDG1sxQi0bWzVHG1sxbVN0YXR1czobWzIybSB0aGUgdGFzayBsZWRnZXIgaRtbMzFHIHNldCB0byAb',
  'WzM4OzI7MTc3OzE4NTsyNDltcmV2aWV3X3JlcXVlc3RlZBtbMzltIBtbNTdHbmQgdGhlIHIbWzY2R3BvcnQgaXMbWzc0R3Bv',
  'c3RlZA0bWzRDG1sxQmluIHRoZSBtaXNzaW8bWzE5RyBjaGFubmVsLiBJIHN0b3BwZWQgT3JiU3RhY2ssIHNpbmNlIEkgaGFk',
  'IHN0YXJ0ZWQgaXQuDRtbMkMbWzFCG1tLDRtbMUIbWzM4OzI7MTUzOzE1MzsxNTNt4py7G1szR1dvcmtlZCBmb3IgNTltIDQz',
  'cyDCtyBkb25lIDI6MDYgUE0bWzM5bRtbSw0bWzRDG1sxQhtbSw0bWzFCG1szODsyOzE1MzsxNTM7MTUzbeKAuxtbM0cbWzFt',
  'cmVjYXA6IBtbMjJtG1szbVBSICMyMTczIGlzIGdyZWVuIGFuZCB1bm1lcmdlZDsgaXQgYnVpbGRzIHRoZSBMaW51eCB3bXV4',
  'LXNlcnZlciAbWzIzbRtbMzltG1tLDRtbMkMbWzFCG1szODsyOzE1MzsxNTM7MTUzbRtbM21wYWNrYWdlcyB0aGF0ICJBZGQg',
  'UEMgb3ZlciBTU0giIGluc3RhbGxzLCBib3RoIGNoZWNrZWQgaW4gY2xlYW4gY29udGFpbmVycy4gDRtbMkMbWzFCTmV4dDog',
  'cnVuIGEgbm8tcHVibGlzaCB0cmlhbCBvZiB0aGUgcmVsZWFzZSB3b3JrZmxvdyBiZWZvcmUgbWVyZ2luZy4gKGRpc2FibGUg',
  'DRtbMUIbWzIzbRtbMzltIBtbM0cbWzM4OzI7MTUzOzE1MzsxNTNtG1szbXJlY2FwcyBpbiAvY29uZmlnKRtbMjNtG1szOW0b',
  'W0sbWzI0OzFIG1syMTszSBtbPzI1aA==',
].join(''), 'base64').toString('utf8');
const IDLE_TITLE = '\x1b]0;✳ Set e2e-win/hello.txt line 1\x07';
const RUNNING_TITLE = '\x1b]0;◐ Set e2e-win/hello.txt line 1\x07';
const BIG = 'x'.repeat(3000); // > ActivityMonitor's 2 KB active threshold

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

describe('DaemonPTYBridge — output after a hook Stop (F24)', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let active: number;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    bridge.setupDataForwarding(fake.pty, new RingBuffer(262144), 'sess-1', new PromptEventLog());
    active = 0;
    bridge.on('active', () => { active += 1; });
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  /** A worker's turn: submit, hooks, its output, the Stop and the idle title. */
  function finishedHookTurn(): string {
    bridge.noteInput('set line 1\r');
    bridge.noteAgentStatus('running', true); // UserPromptSubmit
    feed(RUNNING_TITLE + BIG);
    const id = bridge.getTurn('running').id;
    bridge.noteAgentStatus('complete', true); // Stop
    feed(IDLE_TITLE);
    expect(bridge.isTurnOpen()).toBe(false);
    return id;
  }

  it('the recap and the attach repaint under the idle title do not reopen the turn', () => {
    const id = finishedHookTurn();
    vi.advanceTimersByTime(48 * 60_000);
    const before = active;
    feed(F24_PANE_TAIL);
    feed(RECAP_FRAME);
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.getAgentStatus()).toBe('complete');
    expect(active).toBe(before);

    // A viewer attaches and the pane is redrawn again, past the resize guard.
    bridge.noteResize();
    vi.advanceTimersByTime(3100);
    feed(F24_PANE_TAIL + RECAP_FRAME);
    vi.advanceTimersByTime(30_000);
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.getTurn(bridge.getAgentStatus())).toMatchObject({ id, state: 'idle' });
    expect(active).toBe(before);
  });

  it('a prompt submitted after the recap opens a new turn', () => {
    const id = finishedHookTurn();
    vi.advanceTimersByTime(60_000);
    feed(F24_PANE_TAIL + RECAP_FRAME);
    bridge.noteInput('merge #39\r');
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getTurn('running').id).not.toBe(id);
  });

  it('a UserPromptSubmit hook after the recap opens a new turn', () => {
    const id = finishedHookTurn();
    vi.advanceTimersByTime(60_000);
    feed(F24_PANE_TAIL + RECAP_FRAME);
    bridge.noteAgentStatus('running', true);
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getTurn('running').id).not.toBe(id);
  });

  it('a real autonomous turn (running title) still opens from bytes, and closes on its Stop', () => {
    const id = finishedHookTurn();
    vi.advanceTimersByTime(60_000);
    // A background task finished and the agent picked up: the spinner title
    // comes ahead of the burst that crosses the threshold.
    feed(RUNNING_TITLE);
    feed(BIG);
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getAgentStatus()).toBe('running');
    const auto = bridge.getTurn('running').id;
    expect(auto).not.toBe(id);
    bridge.noteAgentStatus('running', true); // PreToolUse
    expect(bridge.getTurn('running').id).toBe(auto);
    bridge.noteAgentStatus('complete', true); // Stop
    expect(bridge.isTurnOpen()).toBe(false);
  });

  it('a spinner title in the same chunk as the burst counts; a burst ahead of it is held, the next opens', () => {
    finishedHookTurn();
    vi.advanceTimersByTime(60_000);
    feed(RUNNING_TITLE + BIG); // measured before its titles are parsed
    expect(bridge.isTurnOpen()).toBe(true);
    bridge.noteAgentStatus('complete', true);
    feed(IDLE_TITLE);

    vi.advanceTimersByTime(60_000);
    feed(BIG); // the turn's first paint, before its spinner title
    expect(bridge.isTurnOpen()).toBe(false);
    feed(RUNNING_TITLE);
    vi.advanceTimersByTime(1000);
    feed(BIG);
    expect(bridge.isTurnOpen()).toBe(true);
  });

  it('a hook-less pane still opens an autonomous turn from bytes alone (#935)', () => {
    bridge.noteInput('go\r');
    feed(BIG);
    bridge.noteAgentStatus('complete'); // detector settle, no hook ever
    feed(IDLE_TITLE);
    expect(bridge.isTurnOpen()).toBe(false);
    vi.advanceTimersByTime(6100);
    feed(BIG);
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getAgentStatus()).toBe('running');
  });

  it('a hook pane with no idle title: a byte-opened turn no hook confirms closes once the bytes stop', () => {
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('running', true);
    feed(BIG);
    bridge.noteAgentStatus('complete', true); // Stop, and this agent sets no title
    vi.advanceTimersByTime(6100);
    feed(BIG);
    expect(bridge.isTurnOpen()).toBe(true);
    const promoted = bridge.getTurn('running').id;
    vi.advanceTimersByTime(5200); // byte silence: the cycle goes idle
    expect(bridge.isTurnOpen()).toBe(false);
    // Read wrong (a quiet stretch of a real turn): its next hook resumes the same episode.
    bridge.noteAgentStatus('running', true);
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getTurn('running').id).toBe(promoted);
  });

  it('a byte-opened turn a hook confirmed is closed only by its Stop', () => {
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('running', true);
    feed(BIG);
    bridge.noteAgentStatus('complete', true);
    vi.advanceTimersByTime(6100);
    feed(BIG);
    bridge.noteAgentStatus('running', true); // the autonomous turn's PreToolUse
    vi.advanceTimersByTime(30_000); // a long quiet tool call
    expect(bridge.isTurnOpen()).toBe(true);
    bridge.noteAgentStatus('complete', true);
    expect(bridge.isTurnOpen()).toBe(false);
  });

  it('a byte-opened turn blocked on an approval is never closed by silence', () => {
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('running', true);
    feed(BIG);
    bridge.noteAgentStatus('complete', true);
    vi.advanceTimersByTime(6100);
    feed(BIG);
    bridge.noteAgentStatus('awaiting_input', true); // PermissionRequest
    vi.advanceTimersByTime(60_000);
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.isAwaitingHuman()).toBe(true);
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
  });

  it('a byte-opened turn whose approval a human answered is a confirmed turn', () => {
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('running', true);
    feed(BIG);
    bridge.noteAgentStatus('complete', true);
    vi.advanceTimersByTime(6100);
    feed(BIG);
    const id = bridge.getTurn('running').id;
    bridge.noteAgentStatus('awaiting_input', true); // PermissionRequest
    bridge.noteInput('1'); // allowed
    feed(BIG); // the dialog closes
    vi.advanceTimersByTime(30_000); // the approved tool runs quietly
    expect(bridge.isTurnOpen()).toBe(true);
    bridge.noteInput('then this\r'); // queued into the same turn
    expect(bridge.getTurn('running').id).toBe(id);
  });

  it('a burst held under the idle title opens the turn when the spinner title follows it', () => {
    const id = finishedHookTurn();
    vi.advanceTimersByTime(60_000);
    const burstAt = Date.now();
    feed(BIG); // the autonomous turn's first paint, before its spinner title
    expect(bridge.isTurnOpen()).toBe(false);
    vi.advanceTimersByTime(500);
    feed(RUNNING_TITLE); // the spinner alone never crosses the byte threshold
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getTurn('running').id).not.toBe(id);
    expect(bridge.getTurn('running').startedAt).toBe(burstAt);
    expect(bridge.getAgentStatus()).toBe('running');
    vi.advanceTimersByTime(1000);
    feed('\x1b]0;◑ Set e2e-win/hello.txt line 1\x07');
    expect(bridge.getAgentStatus()).toBe('running');
    bridge.noteAgentStatus('complete', true);
    expect(bridge.isTurnOpen()).toBe(false);
  });

  it('a spinner title inside the settle cool-down (the Stop hook still running) opens nothing', () => {
    finishedHookTurn();
    vi.advanceTimersByTime(500);
    feed(RUNNING_TITLE);
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.getAgentStatus()).toBe('complete');
  });

  it('a dialog after a soft close resumes the episode: one id from the approval to the Stop', () => {
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('running', true);
    feed(BIG);
    bridge.noteAgentStatus('complete', true); // this agent sets no title
    vi.advanceTimersByTime(6100);
    feed(BIG); // an autonomous turn, from bytes alone
    const id = bridge.getTurn('running').id;
    bridge.noteAgentStatus('waiting'); // detector: the `bypass permissions on` footer
    expect(bridge.isTurnOpen()).toBe(false);
    bridge.noteAgentStatus('awaiting_input', true); // PermissionRequest
    expect(bridge.getTurn(bridge.getAgentStatus())).toMatchObject({ id, state: 'running' });
    bridge.noteInput('1'); // allowed
    feed(BIG); // the approved tool runs
    expect(bridge.getTurn(bridge.getAgentStatus())).toMatchObject({ id, state: 'running' });
    bridge.noteInput('then this\r'); // queued into the running turn
    expect(bridge.getTurn(bridge.getAgentStatus())).toMatchObject({ id, state: 'running' });
    bridge.noteAgentStatus('complete', true);
    expect(bridge.getTurn(bridge.getAgentStatus())).toMatchObject({ id, state: 'idle' });
  });

  it('a spinner-opened turn under an unchanged idle footer keeps running and its id', () => {
    const footer = '\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\r\n';
    feed('Claude Code v2.1.301\r\n'); // the detector names the agent
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('running', true);
    feed(RUNNING_TITLE + BIG + footer);
    bridge.noteAgentStatus('complete', true);
    feed(IDLE_TITLE);
    vi.advanceTimersByTime(60_000);
    feed(BIG + footer); // held: still under the idle title
    vi.advanceTimersByTime(500);
    feed(RUNNING_TITLE); // opens the turn
    vi.advanceTimersByTime(500);
    feed(BIG + footer); // the autonomous turn paints; the footer did not change
    expect(bridge.getAgentStatus()).toBe('running');
    const id = bridge.getTurn('running').id;
    expect(bridge.isTurnOpen()).toBe(true);
    bridge.noteInput('queued\r');
    expect(bridge.getTurn(bridge.getAgentStatus())).toMatchObject({ id, state: 'running' });
  });

  it('a slow Stop hook that keeps the spinner up past the cool-down opens nothing', () => {
    bridge.noteInput('go\r');
    bridge.noteAgentStatus('running', true);
    feed(RUNNING_TITLE + BIG);
    const id = bridge.getTurn('running').id;
    bridge.noteAgentStatus('complete', true); // Stop; another Stop hook is still running
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(1000);
      feed(i % 2 ? RUNNING_TITLE : '\x1b]0;◑ Set e2e-win/hello.txt line 1\x07');
      expect(bridge.isTurnOpen()).toBe(false);
    }
    feed(IDLE_TITLE); // the hooks are done
    expect(bridge.isTurnOpen()).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(bridge.isTurnOpen()).toBe(false);
    bridge.noteInput('next task\r');
    expect(bridge.getTurn('running').id).not.toBe(id);
    expect(bridge.getTurn('running').startedAt).toBe(Date.now());
  });

  it('a spinner-opened turn the idle title ends (no hook) is settled again: a later repaint opens nothing', () => {
    const id = finishedHookTurn();
    vi.advanceTimersByTime(60_000);
    feed(BIG);
    vi.advanceTimersByTime(300);
    feed(RUNNING_TITLE);
    expect(bridge.isTurnOpen()).toBe(true);
    vi.advanceTimersByTime(300);
    feed(IDLE_TITLE); // an Esc, with no hook
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.getAgentStatus()).toBe('complete');
    vi.advanceTimersByTime(6000);
    feed(F24_PANE_TAIL + RECAP_FRAME);
    vi.advanceTimersByTime(10_000);
    expect(bridge.isTurnOpen()).toBe(false);
    bridge.noteInput('again\r');
    expect(bridge.getTurn('running').id).not.toBe(id);
  });
});
