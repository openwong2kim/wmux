/**
 * The just-stashed highlight has to turn OFF (#977).
 *
 * The first version consumed the pulse and owned its timeout in one effect, and
 * that is self-defeating: `clearStashPulse()` nulls the derived `pulsedPaneId`
 * on the very next render, the effect re-runs, its cleanup clears the pending
 * timeout, and `setPulsingPaneId(null)` never fires. The row keeps a background
 * identical to the FOCUSED style — permanently, on a pane that is not focused
 * and not even on screen. Two effects: one consumes, one owns the timer keyed on
 * what it is timing.
 *
 * A source-scan guard, in the house style (Sidebar.companyMode, appLayout
 * invariants): the store-connected roster has no render fixture here, and the
 * bug is a hook-dependency shape rather than a value any assertion could read.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/Sidebar/WorkspaceAgentRoster.tsx'),
  'utf8',
);

/** The effect whose dependency array is exactly `[dep]`. */
function effectKeyedOn(dep: string): string {
  const marker = `}, [${dep}]);`;
  const end = source.indexOf(marker);
  expect(end, `no effect keyed on [${dep}]`).toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf('useEffect(() => {', end);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, end + marker.length);
}

describe('WorkspaceAgentRoster — stash pulse', () => {
  it('consumes the pulse in an effect that owns no timeout', () => {
    const consume = effectKeyedOn('pulsedPaneId');
    expect(consume).toContain('clearStashPulse()');
    expect(consume).toContain('setOpen(true)');
    expect(consume).toContain('setPulsingPaneId(pulsedPaneId)');
    // The trap: clearStashPulse re-runs this effect immediately, so a timeout
    // registered here would be cleaned up before it could ever fire.
    expect(consume).not.toContain('setTimeout');
  });

  it('owns the timeout in a separate effect keyed on what it is timing', () => {
    const timer = effectKeyedOn('pulsingPaneId');
    expect(timer).toContain('setTimeout');
    expect(timer).toContain('setPulsingPaneId(null)');
    expect(timer).toContain('clearTimeout');
    // …and it must not consume the pulse, or the two re-enter each other.
    expect(timer).not.toContain('clearStashPulse');
  });

  it('bounds the highlight to a duration a human reads as a flash', () => {
    expect(source).toMatch(/const STASH_PULSE_MS = \d{3,4};/);
    const ms = Number(/const STASH_PULSE_MS = (\d+);/.exec(source)?.[1]);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(3000);
  });
});
