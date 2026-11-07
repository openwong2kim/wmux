// The approval check, the chat bridge, automation and readSessionText read a
// pane's screen in the shared snapshot queue, and reads of the same pane that
// are still waiting share one parse (#2602). A session id is not a pane's
// identity: a supervised restart re-creates a dead pane under the same id. A
// read must answer for the session it was asked about, never for the one that
// took its id while it waited.
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../RingBuffer';
import { enqueueSnapshotJob, type TextSnapshotOutcome } from '../HeadlessSnapshot';
import { queuedScreenText, queuedTextSnapshot, type TextReadSession, type TextReadSessions } from '../queuedSessionText';
import { resetScreenReadCounters, screenParseCounters, snapshotQueueCounters } from '../screenReadCache';

function session(text: string): TextReadSession {
  const ringBuffer = new RingBuffer(64 * 1024);
  ringBuffer.write(Buffer.from(text));
  return { meta: { cols: 80, rows: 24 }, ringBuffer, bridge: { outputModes: null } };
}

function sessionTable(): TextReadSessions & { map: Map<string, TextReadSession>; lookups: number } {
  const map = new Map<string, TextReadSession>();
  const table = { map, lookups: 0, getSession: (id: string) => { table.lookups++; return map.get(id); } };
  return table;
}

/** Another pane's snapshot holds the queue until `release`. */
function holdQueue(): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { release, done: enqueueSnapshotJob(() => held) };
}

function lines(outcome: TextSnapshotOutcome | null): string[] | null {
  if (!outcome) return null;
  if (!outcome.ok) throw new Error(`parse failed: ${outcome.reason}`);
  return outcome.rows.map((r) => r.text.trimEnd()).filter((t) => t.length > 0);
}

describe('queued screen reads', () => {
  it('a read waiting while its pane closes and another session takes the id answers as closed', async () => {
    const sessions = sessionTable();
    sessions.map.set('pane-a', session('old pane screen'));
    sessions.map.set('pane-b', session('closed pane screen'));
    const queue = holdQueue();
    const screen = queuedScreenText(sessions, 'pane-a');
    const undimmed = queuedScreenText(sessions, 'pane-a', true);
    const text = queuedTextSnapshot(sessions, 'pane-a', 100);
    const closed = queuedScreenText(sessions, 'pane-b');

    sessions.map.set('pane-a', session('new pane screen'));
    sessions.map.delete('pane-b');
    queue.release();
    await queue.done;

    expect(await screen).toBeNull();
    expect(await undimmed).toBeNull();
    expect(await text).toBeNull();
    expect(await closed).toBeNull();
  });

  it('a read made after the id was taken reads the new session, not the old one still waiting', async () => {
    const sessions = sessionTable();
    sessions.map.set('pane-a', session('old pane screen'));
    const queue = holdQueue();
    const oldScreen = queuedScreenText(sessions, 'pane-a');
    const oldText = queuedTextSnapshot(sessions, 'pane-a', 100);

    sessions.map.set('pane-a', session('new pane screen'));
    const newScreen = queuedScreenText(sessions, 'pane-a');
    const newText = queuedTextSnapshot(sessions, 'pane-a', 100);
    queue.release();
    await queue.done;

    expect(await oldScreen).toBeNull();
    expect(await oldText).toBeNull();
    expect(lines(await newScreen)).toEqual(['new pane screen']);
    expect(lines(await newText)).toEqual(['new pane screen']);
  });

  it('two reads of the same live session still share one parse', async () => {
    const sessions = sessionTable();
    const pane = session('live pane screen');
    sessions.map.set('pane-a', pane);
    const queue = holdQueue();
    const first = queuedScreenText(sessions, 'pane-a');
    const second = queuedScreenText(sessions, 'pane-a');
    const firstText = queuedTextSnapshot(sessions, 'pane-a', 100);
    const secondText = queuedTextSnapshot(sessions, 'pane-a', 100);
    expect(second).toBe(first);
    expect(secondText).toBe(firstText);
    const lookupsBeforeTurn = sessions.lookups;
    queue.release();
    await queue.done;

    expect(lines(await first)).toEqual(['live pane screen']);
    expect(lines(await firstText)).toEqual(['live pane screen']);
    // One job ran per kind of read (screen, text), not one per caller: each
    // job looks its session up once at its turn.
    expect(sessions.lookups - lookupsBeforeTurn).toBe(2);
  });

  // Pollers re-read a quiet pane many times a second (the chat bridge, the
  // automation engine, FleetView): while its ring and size have not moved, the
  // last answer stands without queueing a whole-ring parse again.
  it('a read of a pane whose ring and size have not moved reuses the last answer without queueing', async () => {
    const sessions = sessionTable();
    const pane = session('quiet pane');
    sessions.map.set('pane-a', pane);
    const first = await queuedScreenText(sessions, 'pane-a');
    const queue = holdQueue();
    // The queue is held, so only a reused answer can settle now.
    expect(lines(await queuedScreenText(sessions, 'pane-a'))).toEqual(['quiet pane']);
    expect(await queuedScreenText(sessions, 'pane-a')).toBe(first);

    pane.ringBuffer.write(Buffer.from(' grew'));
    const grown = queuedScreenText(sessions, 'pane-a');
    // Resized while the read waits: at its turn it reads at the new size.
    pane.meta.cols = 100;
    queue.release();
    await queue.done;
    const atTurn = await grown;
    expect(lines(atTurn)).toEqual(['quiet pane grew']);
    // Kept under the size it read at, not the size it was asked at: back at
    // the old size the answer is read again.
    expect(await queuedScreenText(sessions, 'pane-a')).toBe(atTurn);
    pane.meta.cols = 80;
    expect(await queuedScreenText(sessions, 'pane-a')).not.toBe(atTurn);
  });

  it('counts one parse per read that replayed the ring: not a reused answer, not a joined waiter', async () => {
    resetScreenReadCounters();
    const table = sessionTable();
    table.map.set('s1', session('hello'));
    const { release, done } = holdQueue();
    const waiting = [queuedScreenText(table, 's1'), queuedScreenText(table, 's1')];
    release();
    await Promise.all([done, ...waiting]);
    await queuedScreenText(table, 's1');
    await queuedTextSnapshot(table, 's1', 160);
    const parses = screenParseCounters();
    expect(parses.screen.parses).toBe(1);
    expect(parses.screen.bytes).toBeGreaterThan(0);
    expect(parses['text<=300'].parses).toBe(1);
    // The holder and the two parses each took a turn on the queue.
    const queue = snapshotQueueCounters();
    expect(queue.jobs).toBe(3);
    expect(queue.waitMsMax).toBeGreaterThanOrEqual(0);
    expect(queue.runMsTotal).toBeGreaterThanOrEqual(0);
  });

  it('a session that took a closed pane\'s id never gets the closed pane\'s kept answer', async () => {
    const sessions = sessionTable();
    sessions.map.set('pane-a', session('same bytes'));
    const old = await queuedScreenText(sessions, 'pane-a');
    sessions.map.set('pane-a', session('same bytes'));
    const fresh = await queuedScreenText(sessions, 'pane-a');
    expect(fresh).not.toBe(old);
    expect(lines(fresh)).toEqual(['same bytes']);
  });

  it('a pane whose mode tracker was dropped (its shell exited) reads again', async () => {
    const sessions = sessionTable();
    const pane = session('exited shell');
    const modes = { preamble: () => '' };
    (pane.bridge as { outputModes: typeof modes | null }).outputModes = modes;
    sessions.map.set('pane-a', pane);
    const before = await queuedScreenText(sessions, 'pane-a');
    expect(await queuedScreenText(sessions, 'pane-a')).toBe(before);
    (pane.bridge as { outputModes: typeof modes | null }).outputModes = null;
    expect(await queuedScreenText(sessions, 'pane-a')).not.toBe(before);
  });
});
