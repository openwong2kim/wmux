/**
 * #2030 review follow-ups for the prompt-mode guard's death edge
 * (`processGone()`):
 *
 *  1. An edge that lands while a probe is in flight (or out of retries) must
 *     not be lost to that probe's late, stale "alive" answer.
 *  2. The edge must reach agents without a resume binding: daemon.listSessions
 *     reports `agentProcessAlive` whether or not a binding surfaces.
 *  3. Where the agent tracker is the only process truth (POSIX, WSL, a failed
 *     CIM snapshot) the edge admits nothing a fresh prompt would not: the
 *     reset still needs the probe's `true`, read from the same tracker.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { installShellPromptModeReset, type ForegroundGoneProbe } from '../shellPromptModeReset';
import { AGENT_DEATH_LAG_MS, paneForegroundProbe } from '../../../renderer/terminal/paneForegroundProbe';

const ESC = '\x1b';
const BEL = '\x07';
const PROMPT = `${ESC}]133;D;0${BEL}${ESC}]133;A${BEL}$ ${ESC}]133;B${BEL}`;
const COMMAND = `${ESC}]133;C${BEL}`;
const AGENT_ARMS = `${ESC}[?1003h${ESC}[?1006h${ESC}[?1004h`;
const SGR_MOVE = `${ESC}[<35;114;8M`;

function deferredProbe() {
  const pending: ((gone: boolean | undefined) => void)[] = [];
  const probe: ForegroundGoneProbe = () => new Promise((resolve) => { pending.push(resolve); });
  return { probe, pending };
}

function make(probe: ForegroundGoneProbe, extra: { maxProbes?: number; now?: () => number } = {}) {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const guard = installShellPromptModeReset(term, {
    isForegroundGone: probe,
    setTimer: () => () => {},
    ...extra,
  });
  const feed = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await feed('');
  };
  return { term, guard, feed, settle };
}

describe('processGone() while the probe is still deciding (#2030 review 1)', () => {
  it('supersedes an in-flight probe: its late stale "alive" answer neither declines nor ends the drop', async () => {
    const { probe, pending } = deferredProbe();
    const { term, guard, feed, settle } = make(probe);
    await feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    expect(pending).toHaveLength(1);
    // The agent's death edge arrives while the first probe is in flight.
    guard.processGone();
    expect(pending).toHaveLength(2);
    // The first probe read the tracker before the edge: "alive".
    pending[0](false);
    await settle();
    expect(guard.dropping).toBe(true);
    expect(term.modes.mouseTrackingMode).toBe('any');
    expect(guard.dropsReport(SGR_MOVE)).toBe(true);
    // The fresh one reads it dead: the reset lands once.
    pending[1](true);
    await settle();
    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(guard.appliedCount).toBe(1);
    expect(guard.dropping).toBe(false);
  });

  it('restarts a resolution whose retries ran out', async () => {
    let answer: boolean | undefined;
    let asked = 0;
    const { term, guard, feed, settle } = make(() => { asked++; return answer; }, { maxProbes: 1 });
    await feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    await settle();
    expect(asked).toBe(1);
    expect(guard.dropping).toBe(true); // out of probes, still awaiting
    answer = true;
    guard.processGone();
    await settle();
    expect(asked).toBe(2);
    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(guard.appliedCount).toBe(1);
  });

  it('a fresh probe that still reads alive declines, and a later edge can re-ask', async () => {
    const { probe, pending } = deferredProbe();
    const { term, guard, feed, settle } = make(probe);
    await feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    guard.processGone();
    pending[0](true); // stale: superseded, ignored
    pending[1](false);
    await settle();
    expect(term.modes.mouseTrackingMode).toBe('any');
    expect(guard.dropping).toBe(false);
    expect(guard.appliedCount).toBe(0);
    guard.processGone();
    pending[2](true);
    await settle();
    expect(term.modes.mouseTrackingMode).toBe('none');
  });

  it('leaves a queued reset alone', async () => {
    let asked = 0;
    const { term, guard, feed, settle } = make(() => { asked++; return true; });
    await feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    // The reset is queued behind pending output; an edge now asks nothing.
    guard.processGone();
    await settle();
    expect(asked).toBe(1);
    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(guard.appliedCount).toBe(1);
  });
});

describe('tracker-only process truth (#2030 review 3)', () => {
  /** A WSL pane: no tree walk, the agent tracker decides. */
  function trackerPane() {
    let clock = 0;
    const tracker = { alive: true, commandRunning: false as boolean | undefined };
    const probe = paneForegroundProbe('p1', {
      resources: async () => { throw new Error('never asked for a WSL pane'); },
      list: async () => [{
        id: 'p1',
        wslTarget: { distro: 'Ubuntu' },
        ...(tracker.commandRunning !== undefined ? { commandRunning: tracker.commandRunning } : {}),
        agentProcessAlive: tracker.alive,
      }],
    }, () => clock);
    const pane = make(probe, { now: () => clock, maxProbes: 1 });
    const decline = async () => {
      await pane.feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
      clock += AGENT_DEATH_LAG_MS;
      pane.guard.processGone(); // re-ask now that the lag has passed: still alive
      await pane.settle();
      expect(pane.guard.dropping).toBe(false);
      expect(pane.term.modes.mouseTrackingMode).toBe('any');
    };
    return { ...pane, tracker, decline };
  }

  it('the edge alone resets nothing: a probe that cannot confirm keeps the mouse armed', async () => {
    const p = trackerPane();
    await p.decline();
    // The tracker's pick died, but the probe has no prompt-time proof
    // (commandRunning unknown): no `true`, no reset.
    p.tracker.alive = false;
    p.tracker.commandRunning = undefined;
    p.guard.processGone();
    await p.settle();
    expect(p.term.modes.mouseTrackingMode).toBe('any');
    expect(p.guard.appliedCount).toBe(0);
  });

  it('a dead tracker reading resets the same way through the edge as through a later prompt', async () => {
    // Through the death edge.
    const viaEdge = trackerPane();
    await viaEdge.decline();
    viaEdge.tracker.alive = false;
    viaEdge.guard.processGone();
    await viaEdge.settle();
    // Through a first ask at a prompt that arrives after the same reading.
    const viaPrompt = trackerPane();
    viaPrompt.tracker.alive = false;
    await viaPrompt.feed(PROMPT + COMMAND + AGENT_ARMS + PROMPT);
    await viaPrompt.settle();
    expect(viaEdge.term.modes.mouseTrackingMode).toBe('none');
    expect(viaPrompt.term.modes.mouseTrackingMode).toBe('none');
    expect(viaEdge.guard.appliedCount).toBe(viaPrompt.guard.appliedCount);
  });
});

describe('daemon.listSessions reports agent liveness without a binding (#2030 review 2)', () => {
  const SRC = readFileSync(path.resolve(process.cwd(), 'src/daemon/index.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = SRC.indexOf("pipeServer.onRpc('daemon.listSessions'");
  const end = SRC.indexOf('// Fix B: when includeSuspended', start);
  const BODY = SRC.slice(start, end);

  it('never returns before attaching agentProcessAlive when no binding surfaces', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(BODY).not.toMatch(/if \(!surfacedBinding\) return/);
    const aliveAt = BODY.indexOf('agentProcessTracker.statusFor(s.id)');
    const attachAt = BODY.indexOf('{ ...withPrompt, agentProcessAlive }');
    const returnAt = BODY.indexOf('return surfacedBinding ? { ...withAlive, resumeBinding: surfacedBinding } : withAlive;');
    expect(aliveAt).toBeGreaterThan(-1);
    expect(attachAt).toBeGreaterThan(aliveAt);
    expect(returnAt).toBeGreaterThan(attachAt);
  });
});
