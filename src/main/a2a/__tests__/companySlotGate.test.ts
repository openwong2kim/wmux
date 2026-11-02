// The per-PC cap's gate: one decision at a time, and a seat let in holds a
// slot until its taker releases it.
import { describe, expect, it } from 'vitest';
import { CompanySlotGate, decideCompanySlot, type CompanyWorkingCount, type CompanyWorkingSeat } from '../CompanyReleaseBridge';

const seat = (paneId: string): CompanyWorkingSeat => ({ workspaceId: 'ws-a', paneId, name: `#${paneId}` });

function countOf(staff: string[], working: string[]): CompanyWorkingCount {
  return {
    staff: new Map(staff.map((id) => [id, { workspaceId: 'ws-a', name: `#${id}`, alive: true }])),
    working: working.map(seat),
  };
}

describe('decideCompanySlot', () => {
  it('a seat that works already takes no new slot', () => {
    expect(decideCompanySlot({ working: [seat('a')], reserved: [], paneId: 'a', cap: 1 })).toEqual({ kind: 'working' });
    expect(decideCompanySlot({ working: [], reserved: [seat('a')], paneId: 'a', cap: 1 })).toEqual({ kind: 'working' });
  });

  it('counts working and reserved seats once each against the cap', () => {
    expect(decideCompanySlot({ working: [seat('a')], reserved: [seat('a')], paneId: 'b', cap: 2 })).toEqual({ kind: 'free' });
    expect(decideCompanySlot({ working: [seat('a')], reserved: [seat('c')], paneId: 'b', cap: 2 }))
      .toEqual({ kind: 'full', holders: [seat('a'), seat('c')] });
  });
});

describe('CompanySlotGate', () => {
  it('lets one of two takes have the last slot, and gives it back on release', async () => {
    const gate = new CompanySlotGate({ read: async () => countOf(['a', 'b', 'c'], ['a']), cap: () => 2 });
    const [b, c] = await Promise.all([gate.take({ workspaceId: 'ws-a', paneId: 'b' }), gate.take({ workspaceId: 'ws-a', paneId: 'c' })]);
    expect(b.kind).toBe('go');
    expect(c).toEqual({ kind: 'full', cap: 2, holders: [seat('a'), seat('b')] });
    if (b.kind === 'go') b.release();
    expect((await gate.take({ workspaceId: 'ws-a', paneId: 'c' })).kind).toBe('go');
  });

  it('lets a seat that works already go at the cap', async () => {
    const gate = new CompanySlotGate({ read: async () => countOf(['a', 'b'], ['a']), cap: () => 1 });
    expect((await gate.take({ workspaceId: 'ws-a', paneId: 'a' })).kind).toBe('go');
    expect((await gate.take({ workspaceId: 'ws-a', paneId: 'b' })).kind).toBe('full');
  });

  it('counts nothing for a pane that is no staff seat of that workspace', async () => {
    const gate = new CompanySlotGate({ read: async () => countOf(['a'], ['a']), cap: () => 1 });
    expect((await gate.take({ workspaceId: 'ws-a', paneId: 'ceo' })).kind).toBe('go');
    expect((await gate.take({ workspaceId: 'ws-b', paneId: 'a' })).kind).toBe('go');
  });

  it('answers unknown when the count cannot be read, and keeps deciding after a read that threw', async () => {
    let fail = true;
    const gate = new CompanySlotGate({
      read: async () => {
        if (fail) throw new Error('renderer gone');
        return countOf(['a'], []);
      },
      cap: () => 1,
    });
    expect(await gate.take({ workspaceId: 'ws-a', paneId: 'a' })).toEqual({ kind: 'unknown' });
    fail = false;
    expect((await gate.take({ workspaceId: 'ws-a', paneId: 'a' })).kind).toBe('go');
  });

  it('reads the cap at each decision', async () => {
    let cap = 1;
    const gate = new CompanySlotGate({ read: async () => countOf(['a', 'b'], ['a']), cap: () => cap });
    expect((await gate.take({ workspaceId: 'ws-a', paneId: 'b' })).kind).toBe('full');
    cap = 2;
    expect((await gate.take({ workspaceId: 'ws-a', paneId: 'b' })).kind).toBe('go');
  });
});
