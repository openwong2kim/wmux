import { describe, it, expect } from 'vitest';
import { isShareHostDown, selectDownHostIds, SHARE_DROP_FAILED_POLLS } from '../pcRail';
import type { PcRailHostFeed } from '../../../../shared/pcRail';
import type { RemoteHostStatus } from '../../../../shared/remoteHosts';

const feed = (failedTicks: number): PcRailHostFeed => ({ workspaces: [], fetchedAt: 1, failedTicks });

describe('isShareHostDown / selectDownHostIds — the one "this PC is gone" rule', () => {
  it('needs the rail\'s unreachable status AND two failed polls in a row', () => {
    expect(SHARE_DROP_FAILED_POLLS).toBe(2);
    expect(isShareHostDown(undefined, undefined)).toBe(false); // no first round yet
    expect(isShareHostDown('unreachable', 1)).toBe(false);
    expect(isShareHostDown('unreachable', 2)).toBe(true);
    expect(isShareHostDown('reachable', 5)).toBe(false);
    // A refused credential is not "unreachable": it never counts as down here.
    expect(isShareHostDown('needs-repair', 5)).toBe(false);
  });

  it('lists the down hosts and keeps the same Set while its members do not change', () => {
    const at = (status: Record<string, RemoteHostStatus>, feeds: Record<string, PcRailHostFeed>) =>
      selectDownHostIds({ pcRailHostStatus: status, pcRailFeeds: feeds });
    const a = at({ h1: 'unreachable', h2: 'reachable' }, { h1: feed(2), h2: feed(0) });
    expect([...a]).toEqual(['h1']);
    // A later tick that only moves h1's count keeps the identity.
    expect(at({ h1: 'unreachable', h2: 'reachable' }, { h1: feed(3), h2: feed(0) })).toBe(a);
    expect([...at({ h1: 'reachable' }, { h1: feed(0) })]).toEqual([]);
  });
});
