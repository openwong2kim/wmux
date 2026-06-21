import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LanLinkInbox } from '../inbox';
import * as atomicWrite from '../../util/atomicWrite';
import { isInboxFile } from '../../../shared/lanlink';

// Disk-IO tests → `.runtime.test.ts` so they run serially (vitest.runtime.config
// sets fileParallelism:false) and temp-file rotations don't race.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanlink-inbox-'));
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const file = (): string => path.join(dir, 'lanlink-inbox.json');

describe('LanLinkInbox — durable store', () => {
  it('U2: cursor monotonic — poll returns seq>cursor; nextCursor never rewinds', () => {
    const ib = new LanLinkInbox(dir);
    ib.injectSynthetic({ peerName: 'A', text: 'm1' });
    ib.injectSynthetic({ peerName: 'A', text: 'm2' });
    ib.injectSynthetic({ peerName: 'A', text: 'm3' });

    const all = ib.poll(0);
    expect(all.items.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(all.nextCursor).toBe(3);

    const tail = ib.poll(2);
    expect(tail.items.map((r) => r.seq)).toEqual([3]);
    expect(tail.nextCursor).toBe(3);

    // poll past the end echoes the cursor (never rewinds, no throw)
    const none = ib.poll(3);
    expect(none.items).toEqual([]);
    expect(none.nextCursor).toBe(3);

    // a bogus cursor degrades gracefully
    expect(ib.poll(-5).items.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(ib.poll(NaN).nextCursor).toBe(3);
  });

  it('U5: append is durable BEFORE it returns — a fresh instance sees it immediately (no flush)', () => {
    const ib = new LanLinkInbox(dir);
    const { seq } = ib.injectSynthetic({ id: 'fixed-1', peerName: 'A', text: 'durable' });
    expect(seq).toBe(1);
    // No flushSync/dispose — the synchronous atomic write already completed
    // before append returned its seq (the ACK), so a brand-new instance reading
    // the same path observes the record. This is the ack-after-durable proof.
    const reopened = new LanLinkInbox(dir);
    const got = reopened.poll(0);
    expect(got.items).toHaveLength(1);
    expect(got.items[0].id).toBe('fixed-1');
    expect(got.items[0].text).toBe('durable');
  });

  it('seq + nextSeq survive a daemon restart (monotonic across reopen, never reset)', () => {
    const ib = new LanLinkInbox(dir);
    ib.injectSynthetic({ peerName: 'A', text: 'm1' });
    ib.injectSynthetic({ peerName: 'A', text: 'm2' });
    const reopened = new LanLinkInbox(dir);
    const { seq } = reopened.injectSynthetic({ peerName: 'A', text: 'm3' });
    expect(seq).toBe(3);
  });

  it('length-clamps peerName and body on inject', () => {
    const ib = new LanLinkInbox(dir);
    ib.injectSynthetic({ peerName: 'P'.repeat(500), text: 'B'.repeat(10_000) });
    const [r] = ib.poll(0).items;
    expect(r.peerName.length).toBe(100); // PEER_NAME_MAX
    expect(r.text.length).toBe(4000); // BODY_MAX
  });

  it('U1: a corrupt (non-JSON) primary falls back to the .bak last-good on load', () => {
    const ib = new LanLinkInbox(dir);
    ib.injectSynthetic({ peerName: 'A', text: 'first' }); // writes primary
    ib.injectSynthetic({ peerName: 'A', text: 'second' }); // rotates primary→.bak, new primary
    fs.writeFileSync(file(), '{ this is not valid json');
    const reopened = new LanLinkInbox(dir);
    const got = reopened.poll(0);
    expect(got.items.length).toBeGreaterThanOrEqual(1);
    expect(got.items[0].text).toBe('first'); // recovered from .bak
  });

  it('U3: an ARRAY-shaped (corrupt) primary fails the validator and falls back to .bak', () => {
    const ib = new LanLinkInbox(dir);
    ib.injectSynthetic({ peerName: 'A', text: 'first' });
    ib.injectSynthetic({ peerName: 'A', text: 'second' });
    // Overwrite the primary with a JSON ARRAY — valid JSON, NOT a healthy inbox
    // file (#269 trap). isInboxFile must reject it → .bak recovery.
    fs.writeFileSync(
      file(),
      JSON.stringify([{ id: 'x', seq: 1, origin: 'remote', peerName: 'P', text: 'x', receivedAt: 1 }]),
    );
    const reopened = new LanLinkInbox(dir);
    const got = reopened.poll(0);
    expect(got.items[0].text).toBe('first'); // recovered from .bak, not the array
  });

  it('U6: FIFO bound — oldest evicted, seq keeps climbing (never reused)', () => {
    // Inject a small cap so the FIFO invariant is exercised without thousands of
    // synchronous disk writes (515 appends timed out CI's 5s default). The prod
    // cap is INBOX_CAP=512; the eviction logic under test is cap-agnostic.
    const cap = 5;
    const ib = new LanLinkInbox(dir, cap);
    for (let i = 0; i < cap + 3; i++) ib.injectSynthetic({ peerName: 'A', text: `m${i}` });
    expect(ib.size).toBe(cap);
    const items = ib.poll(0).items;
    // oldest 3 (seq 1,2,3) evicted → first surviving seq is 4, last is cap+3
    expect(items[0].seq).toBe(4);
    expect(items[items.length - 1].seq).toBe(cap + 3);
  });

  it('never persists a file it cannot load (own validator passes on the on-disk bytes)', () => {
    const ib = new LanLinkInbox(dir);
    ib.injectSynthetic({ peerName: 'A', text: 'm' });
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(isInboxFile(onDisk)).toBe(true);
  });

  it('append write throw leaves in-memory state unchanged (snapshot-then-commit, no phantom)', () => {
    const ib = new LanLinkInbox(dir);
    ib.injectSynthetic({ peerName: 'A', text: 'first' }); // seq 1, durable
    // Force the next durable write to throw (ENOSPC/EACCES/Windows-lock class).
    const spy = vi
      .spyOn(atomicWrite, 'atomicWriteJSONSync')
      .mockImplementationOnce(() => {
        throw new Error('simulated write failure');
      });
    expect(() => ib.injectSynthetic({ peerName: 'A', text: 'second' })).toThrow();
    spy.mockRestore();
    // Snapshot-then-commit: this.file (poll/size/nextSeq) stays byte-identical to
    // the last durable state — no phantom record is pollable, no seq is leaked.
    expect(ib.size).toBe(1);
    expect(ib.poll(0).items.map((r) => r.seq)).toEqual([1]);
    // nextSeq was NOT consumed by the failed append — the next success reuses 2.
    const { seq } = ib.injectSynthetic({ peerName: 'A', text: 'third' });
    expect(seq).toBe(2);
    expect(ib.poll(0).items.map((r) => r.text)).toEqual(['first', 'third']);
  });
});
