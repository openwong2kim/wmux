import { describe, expect, it } from 'vitest';
import { OrderedSessionLocationProjection } from '../orderedSessionLocationProjection';
import type { SessionLocationSnapshot } from '../sessionLocation';

function snapshot(
  generation: number,
  revision: number,
  cwd = `/${generation}/${revision}`,
): SessionLocationSnapshot {
  return {
    generation,
    revision,
    location: { domain: 'wsl', cwd, shell: 'wsl.exe' },
  };
}

function begin(projection: OrderedSessionLocationProjection, id = 's1') {
  const discovery = projection.beginDiscovery();
  const lease = projection.begin(id, discovery);
  projection.finishDiscovery(discovery);
  if (!lease) throw new Error(`Failed to begin ${id}`);
  return lease;
}

describe('OrderedSessionLocationProjection', () => {
  it('owns the generation and revision decision table', () => {
    const projection = new OrderedSessionLocationProjection();
    const lease = begin(projection);

    expect(projection.accept('s1', snapshot(4, 2), lease)).toBe(true);
    expect(projection.accept('s1', snapshot(4, 2), lease)).toBe(false);
    expect(projection.accept('s1', snapshot(4, 1), lease)).toBe(false);
    expect(projection.accept('s1', snapshot(3, 99), lease)).toBe(false);
    expect(projection.accept('s1', snapshot(4, 3), lease)).toBe(true);
    expect(projection.accept('s1', snapshot(5, 1), lease)).toBe(true);
    expect(projection.get('s1')).toEqual(snapshot(5, 1));
  });

  it.each([
    ['older', 4, false, true, 5],
    ['current', 5, true, false, undefined],
    ['newer', 6, true, false, undefined],
  ] as const)('retires an exact %s generation', (
    _label,
    retired,
    retiresCurrent,
    remains,
    generation,
  ) => {
    const projection = new OrderedSessionLocationProjection();
    const lease = begin(projection);
    projection.accept('s1', snapshot(5, 1), lease);

    expect(projection.retire('s1', retired, lease)).toBe(retiresCurrent);
    expect(projection.get('s1')?.generation).toBe(generation);
    expect(projection.accept('s1', snapshot(retired, 99), lease)).toBe(false);
    expect(projection.retire('s1', retired, lease)).toBe(retiresCurrent);
    expect(projection.get('s1') !== undefined).toBe(remains);
  });

  it('retires before the first snapshot and permits only a newer generation', () => {
    const projection = new OrderedSessionLocationProjection();
    const lease = begin(projection);

    expect(projection.retire('s1', 4, lease)).toBe(true);
    expect(projection.accept('s1', snapshot(4, 99), lease)).toBe(false);
    expect(projection.accept('s1', snapshot(5, 1), lease)).toBe(true);
  });

  it('rejects transitions without a current lease', () => {
    const projection = new OrderedSessionLocationProjection();
    const staleLease = begin(projection);
    projection.reset();

    expect(projection.accept('s1', snapshot(1, 1), staleLease)).toBe(false);
    expect(projection.retire('s1', 1, staleLease)).toBe(false);
    expect(projection.release('s1', staleLease)).toBe(false);
  });

  it('reset fences old work and permits lower generations through new authority', () => {
    const projection = new OrderedSessionLocationProjection();
    const oldDiscovery = projection.beginDiscovery();
    const oldLease = projection.begin('s1', oldDiscovery);
    if (!oldLease) throw new Error('missing old lease');
    projection.accept('s1', snapshot(100, 5), oldLease);

    projection.reset();
    expect(projection.begin('late', oldDiscovery)).toBeUndefined();
    expect(
      projection.resolveDiscoverySnapshot('s1', snapshot(1, 1), oldDiscovery),
    ).toBeUndefined();
    expect(projection.retainedSize()).toBe(0);
    expect(projection.accept('s1', snapshot(1, 1), oldLease)).toBe(false);

    const newLease = begin(projection);
    expect(projection.accept('s1', snapshot(1, 1), newLease)).toBe(true);
  });

  it('release fences delayed work without retaining the closed id', () => {
    const projection = new OrderedSessionLocationProjection();
    const inFlight = projection.beginDiscovery();
    const lease = begin(projection);
    projection.accept('s1', snapshot(4, 1), lease);

    expect(projection.release('s1', lease)).toBe(true);
    expect(projection.retainedSize()).toBe(0);
    expect(projection.begin('s1', inFlight)).toBeUndefined();
    expect(
      projection.resolveDiscoverySnapshot('s1', snapshot(4, 2), inFlight),
    ).toBeUndefined();
    expect(projection.retainedSize()).toBe(0);
    expect(projection.accept('s1', snapshot(4, 2), lease)).toBe(false);

    const reusedLease = begin(projection);
    expect(projection.accept('s1', snapshot(5, 1), reusedLease)).toBe(true);
  });

  it.each([
    ['equal', 2],
    ['older', 1],
  ] as const)('resolves an %s discovery candidate to the newest snapshot', (
    _label,
    candidateRevision,
  ) => {
    const projection = new OrderedSessionLocationProjection();
    const discovery = projection.beginDiscovery();
    const eventLease = begin(projection);
    expect(projection.accept('s1', snapshot(4, 2), eventLease)).toBe(true);

    expect(
      projection.resolveDiscoverySnapshot(
        's1',
        snapshot(4, candidateRevision),
        discovery,
      ),
    ).toEqual(snapshot(4, 2));
  });

  it('resolves a newer discovery candidate as the newest snapshot', () => {
    const projection = new OrderedSessionLocationProjection();
    const discovery = projection.beginDiscovery();
    const eventLease = begin(projection);
    expect(projection.accept('s1', snapshot(4, 2), eventLease)).toBe(true);

    expect(
      projection.resolveDiscoverySnapshot('s1', snapshot(4, 3), discovery),
    ).toEqual(snapshot(4, 3));
  });

  it('resolves a discovery without a candidate to the retained snapshot', () => {
    const projection = new OrderedSessionLocationProjection();
    const discovery = projection.beginDiscovery();
    const eventLease = begin(projection);
    expect(projection.accept('s1', snapshot(4, 2), eventLease)).toBe(true);

    expect(
      projection.resolveDiscoverySnapshot('s1', undefined, discovery),
    ).toEqual(snapshot(4, 2));
  });

  it('does not allocate projection state for a snapshot-less discovery', () => {
    const projection = new OrderedSessionLocationProjection();
    const discovery = projection.beginDiscovery();

    expect(
      projection.resolveDiscoverySnapshot('s1', undefined, discovery),
    ).toBeUndefined();
    expect(projection.retainedSize()).toBe(0);
  });

  it('does not resolve a candidate from a finished discovery', () => {
    const projection = new OrderedSessionLocationProjection();
    const lease = begin(projection);
    expect(projection.accept('s1', snapshot(4, 2), lease)).toBe(true);
    const discovery = projection.beginDiscovery();
    projection.finishDiscovery(discovery);

    expect(
      projection.resolveDiscoverySnapshot('s1', snapshot(4, 3), discovery),
    ).toBeUndefined();
    expect(projection.get('s1')).toEqual(snapshot(4, 2));
    expect(projection.retainedSize()).toBe(1);
  });

  it('does not resolve a candidate from a retired generation', () => {
    const projection = new OrderedSessionLocationProjection();
    const lease = begin(projection);
    expect(projection.retire('s1', 4, lease)).toBe(true);
    const discovery = projection.beginDiscovery();

    expect(
      projection.resolveDiscoverySnapshot('s1', snapshot(4, 99), discovery),
    ).toBeUndefined();
    expect(projection.get('s1')).toBeUndefined();
  });

  it('release blocks only its id in unrelated in-flight discovery', () => {
    const projection = new OrderedSessionLocationProjection();
    const mixedList = projection.beginDiscovery();
    const aLease = begin(projection, 'a');

    expect(projection.release('a', aLease)).toBe(true);
    expect(projection.begin('a', mixedList)).toBeUndefined();
    const bLease = projection.begin('b', mixedList);
    expect(bLease).toBeDefined();
    expect(projection.accept('b', snapshot(1, 1), bLease!)).toBe(true);
  });

  it('finished discovery cannot mint leases', () => {
    const projection = new OrderedSessionLocationProjection();
    const discovery = projection.beginDiscovery();
    projection.finishDiscovery(discovery);

    expect(projection.begin('s1', discovery)).toBeUndefined();
  });

  it('does not retain state for repeatedly closed unique ids', () => {
    const projection = new OrderedSessionLocationProjection();
    for (let index = 0; index < 100; index += 1) {
      const id = `session-${index}`;
      const lease = begin(projection, id);
      projection.accept(id, snapshot(index + 1, 1), lease);
      expect(projection.release(id, lease)).toBe(true);
    }

    expect(projection.retainedSize()).toBe(0);
    expect(projection.snapshots()).toEqual([]);
  });
});
