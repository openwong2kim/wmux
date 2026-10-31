// The engine A/B workflow fails a run whose numbers cannot be compared
// (scripts/twenty-pane-ab-check.mjs); the harness itself exits 0 and only flags.
import { describe, expect, it } from 'vitest';
import { abRunProblems, abRunRow } from '../twenty-pane-ab-check.mjs';

const runtime = (effective) => ({ requested: effective, effective, rustAvailable: true, environmentOverride: false });
function summary(over = {}) {
  return {
    reason: 'completed',
    engine: { requested: 'rust', start: runtime('rust'), end: runtime('rust'), daemonPidStart: 11, daemonPidEnd: 11 },
    daemonRespawned: null,
    teardown: { appExited: true, daemonExited: true, removed: true, clean: true },
    daemonLingering: null,
    flags: [],
    keyboard: { dropped: 0, echoMs: { p95: 3.9 } },
    probes: { dropped: 1, idle: { echoMs: { p95: 14.1 } } },
    stalls: { episodes: 0 },
    memory: {
      daemonRss: { firstMiB: 101, lastMiB: 130, maxMiB: 135, growthMiBPerHour: -6.2 },
      processTree: { firstMiB: 512, lastMiB: 688, maxMiB: 751, growthMiBPerHour: null },
    },
    ...over,
  };
}

describe('an engine A/B run', () => {
  it('compares a completed run on the engine it asked for, whatever else it flags', () => {
    expect(abRunProblems(summary({ flags: ['12 samples throttled'] }), 'rust')).toEqual([]);
  });

  it('refuses a run on another engine, at the start or the end', () => {
    expect(abRunProblems(summary(), 'node')).toEqual([
      'the run asked for rust, not node',
      'the daemon ran rust at the start, not node',
      'the daemon ran rust at the end, not node',
    ]);
    const changed = summary({ engine: { requested: 'rust', start: runtime('rust'), end: runtime('node') } });
    expect(abRunProblems(changed, 'rust')).toEqual(['the daemon ran node at the end, not rust']);
    // Said once, though the harness also flags it.
    const unread = summary({ engine: { requested: 'rust', start: runtime('rust'), end: null }, flags: ["the daemon's terminal engine could not be read at the end"] });
    expect(abRunProblems(unread, 'rust')).toEqual(['the daemon ran an unknown engine at the end, not rust']);
  });

  it('refuses a run that did not complete or changed daemons', () => {
    expect(abRunProblems(summary({ reason: 'interrupted' }), 'rust')).toEqual(['the run ended "interrupted", not completed']);
    expect(abRunProblems(summary({ daemonRespawned: [{ atSec: 60 }] }), 'rust')).toEqual(['the daemon was respawned during the run']);
    const replaced = 'the daemon was replaced during the run (its pid changed)';
    expect(abRunProblems(summary({ flags: [replaced] }), 'rust')).toEqual([replaced]);
  });

  it('refuses a run that recorded no memory to compare', () => {
    expect(abRunProblems(summary({ memory: { daemonRss: null, processTree: { firstMiB: 1, lastMiB: 1, maxMiB: 1, growthMiBPerHour: null } } }), 'rust'))
      .toEqual(['the run recorded no daemon RSS, so it cannot be compared on memory']);
    expect(abRunProblems(summary({ memory: {} }), 'rust')).toEqual([
      'the run recorded no daemon RSS, so it cannot be compared on memory',
      'the run recorded no process tree RSS, so it cannot be compared on memory',
    ]);
  });

  it('refuses a run whose instance may run on into the next one', () => {
    const lingering = summary({ teardown: { removed: true, clean: false }, daemonLingering: { pid: 4242, pipeGone: false } });
    expect(abRunProblems(lingering, 'rust')).toEqual(['the instance was not torn down cleanly (its daemon, pid 4242, was still alive), so it may run on into the next run']);
    expect(abRunProblems(summary({ teardown: undefined }), 'rust')).toEqual(['the instance was not torn down cleanly, so it may run on into the next run']);
  });

  it('reports the numbers the A/B compares', () => {
    expect(abRunRow(summary(), 'rust')).toBe(
      '| rust | 101→130 (max 135) MiB, -6.2 MiB/h | 512→688 (max 751) MiB, - MiB/h | 3.9 ms | 14.1 ms | 0 / 1 / 0 |',
    );
  });
});
