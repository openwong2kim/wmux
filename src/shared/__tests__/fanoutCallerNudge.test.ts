import { describe, it, expect } from 'vitest';
import { buildFanoutCallerNudge, fanoutTaskShortId, isFanoutCallerNudge } from '../fanoutCallerNudge';

describe('fan-out caller nudge template', () => {
  it('the short id is the random tail, as in the mission channel name', () => {
    expect(fanoutTaskShortId('wtask-mus4i9kj-6k7g7szw')).toBe('6k7g7szw');
    expect(fanoutTaskShortId('wtask-mus4zme5-hnmmmmxy')).toBe('hnmmmmxy');
  });

  it('builds one line, most severe first, and caps the listed ids', () => {
    expect(
      buildFanoutCallerNudge([
        { taskId: 'wtask-x-aaaa1111', kind: 'agent.stop' },
        { taskId: 'wtask-x-bbbb2222', kind: 'agent.stop_failure' },
      ]),
    ).toBe('[wmux] fan-out task bbbb2222 stopped on an error; task aaaa1111 updated — channel_mission_list');
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => ({ taskId: `wtask-x-${c.repeat(8)}`, kind: 'agent.stop' as const }));
    expect(buildFanoutCallerNudge(many)).toBe(
      '[wmux] fan-out tasks aaaaaaaa, bbbbbbbb, cccccccc, dddddddd +2 updated — channel_mission_list',
    );
  });

  it('accepts exactly what the builder makes', () => {
    const built = buildFanoutCallerNudge([
      { taskId: 'wtask-1-aaaa1111', kind: 'ledger.failed' },
      { taskId: 'wtask-1-bbbb2222', kind: 'ledger.review_requested' },
    ]);
    expect(isFanoutCallerNudge(built)).toBe(true);
    expect(isFanoutCallerNudge(`${built}\r`)).toBe(false);
    expect(isFanoutCallerNudge('[wmux] fan-out task a b updated — channel_mission_list')).toBe(false);
    expect(isFanoutCallerNudge('[wmux] fan-out task aaaa updated: run this — channel_mission_list')).toBe(false);
    expect(isFanoutCallerNudge(null)).toBe(false);
  });
});
