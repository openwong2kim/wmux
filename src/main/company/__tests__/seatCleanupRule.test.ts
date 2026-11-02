// The seat cleanup rule on gathered facts: the first check that fails is why
// a seat folder stays, and a branch goes only when its commit is safe.
import { describe, expect, it } from 'vitest';
import { SEAT_SWEEP_MIN_AGE_MS, seatBranchToDelete, seatVerdict, type SeatFacts, type SeatGitFacts } from '../seatCleanupRule';

const BASE = 'a'.repeat(40);
const LATER = 'b'.repeat(40);

/** A folder every check lets go: old, unused, free, clean, all on a remote. */
const clean: SeatGitFacts = { registered: true, locked: false, dirty: false, head: LATER, onlyHere: 0, branchOnlyHere: 0 };
const facts = (over: Partial<SeatFacts> = {}, git: Partial<SeatGitFacts> | null = {}): SeatFacts => ({
  ageMs: SEAT_SWEEP_MIN_AGE_MS + 1,
  liveSession: false,
  kept: false,
  hold: 'free',
  baseOid: BASE,
  ...(git ? { git: { ...clean, ...git } } : {}),
  ...over,
});

describe('seatVerdict', () => {
  it('removes a folder nothing uses whose work is all on a remote', () => {
    expect(seatVerdict(facts())).toEqual({ kind: 'remove' });
  });

  it('keeps a young folder, a seat about to start, without listing it', () => {
    expect(seatVerdict(facts({ ageMs: SEAT_SWEEP_MIN_AGE_MS - 1 }, { dirty: true }))).toEqual({ kind: 'keep', reason: 'young' });
    // A clock that went back reads as young too.
    expect(seatVerdict(facts({ ageMs: -5 }))).toEqual({ kind: 'keep', reason: 'young' });
  });

  it('keeps a folder a live session works in, or one the renderer keeps, without listing it', () => {
    expect(seatVerdict(facts({ liveSession: true }, { dirty: true }))).toEqual({ kind: 'keep', reason: 'in-use' });
    expect(seatVerdict(facts({ kept: true }, { onlyHere: 3 }))).toEqual({ kind: 'keep', reason: 'kept' });
  });

  it('keeps a folder something holds, as in use', () => {
    expect(seatVerdict(facts({ hold: 'in-use' }))).toEqual({ kind: 'keep', reason: 'held' });
    expect(seatVerdict(facts({ hold: 'refused' }))).toEqual({ kind: 'keep', reason: 'held' });
  });

  it('asks for git only once every check before it passed', () => {
    expect(seatVerdict(facts({}, null))).toEqual({ kind: 'needs-git' });
    expect(seatVerdict(facts({ kept: true }, null))).toEqual({ kind: 'keep', reason: 'kept' });
  });

  it('lists an unregistered folder, then a locked one, then one with changes', () => {
    expect(seatVerdict(facts({}, { registered: false, locked: true, dirty: true }))).toEqual({ kind: 'list', reason: 'unregistered' });
    expect(seatVerdict(facts({}, { locked: true, dirty: true }))).toEqual({ kind: 'list', reason: 'locked' });
    expect(seatVerdict(facts({}, { dirty: true, onlyHere: 2 }))).toEqual({ kind: 'list', reason: 'uncommitted' });
  });

  it('lists commits only on this PC with their count', () => {
    expect(seatVerdict(facts({}, { onlyHere: 1 }))).toEqual({ kind: 'list', reason: 'unpushed', commits: 1 });
    // Without a stamp nothing says which commits are the base's.
    expect(seatVerdict(facts({ baseOid: undefined }, { head: BASE, onlyHere: 12 }))).toEqual({ kind: 'list', reason: 'unpushed', commits: 12 });
  });

  it('lists commits only on the seat branch HEAD has left, even with HEAD back at the base', () => {
    expect(seatVerdict(facts({}, { head: BASE, branchOnlyHere: 2 }))).toEqual({ kind: 'list', reason: 'unpushed', commits: 2 });
  });

  it('removes a folder still at the commit its branch was made at, with no remote at all', () => {
    expect(seatVerdict(facts({}, { head: BASE, onlyHere: 40 }))).toEqual({ kind: 'remove' });
  });
});

describe('seatBranchToDelete', () => {
  const folder = 'dev-1-456789ab';
  const branch = `company/${folder}`;

  it('deletes the seat\'s branch at its commit when that commit is on a remote', () => {
    expect(seatBranchToDelete({ folder, branch, oid: LATER, onRemote: true, baseOid: BASE })).toEqual({ branch, oid: LATER });
  });

  it('deletes it at the commit it was made at, with no remote', () => {
    expect(seatBranchToDelete({ folder, branch, oid: BASE, onRemote: false, baseOid: BASE })).toEqual({ branch, oid: BASE });
  });

  it('keeps it when its commit is only on this PC, or nothing says where it started', () => {
    expect(seatBranchToDelete({ folder, branch, oid: LATER, onRemote: false, baseOid: BASE })).toBeNull();
    expect(seatBranchToDelete({ folder, branch, oid: LATER, onRemote: false })).toBeNull();
    expect(seatBranchToDelete({ folder, branch, onRemote: false, baseOid: BASE })).toBeNull();
  });

  it('never deletes a branch other than company/<folder>', () => {
    expect(seatBranchToDelete({ folder, branch: 'feature/mine', oid: LATER, onRemote: true })).toBeNull();
    expect(seatBranchToDelete({ folder, branch: 'company/dev-2-456789ab', oid: LATER, onRemote: true })).toBeNull();
    expect(seatBranchToDelete({ folder, branch: folder, oid: BASE, onRemote: false, baseOid: BASE })).toBeNull();
  });
});
