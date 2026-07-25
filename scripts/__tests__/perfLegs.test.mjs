// Pure-logic tests for the confirmation re-run's leg model (#570). No packaged
// app, no spawning — collected by `npm test` via scripts/__tests__/**/*.test.mjs.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGS,
  scenarioRoot,
  legForGate,
  benchArgsForLegs,
  benchArgsForConfig,
  buildRetryPlan,
} from '../perf-legs.mjs';
import { GATES, BOOL_GATES } from '../perf-compare.mjs';

const ALL_GATES = [...GATES, ...BOOL_GATES];
const META = {
  mode: 'ci',
  commit: 'abc1234',
  config: {
    coldRuns: 3,
    inputSamples: 80,
    inputSamples8: 40,
    scrollbackLines: null,
    frameBudgetPanes: [4, 8, 16],
    hiddenFloodAgents: [4, 8],
    hiddenRetention: false,
  },
};

describe('leg mapping', () => {
  // The load-bearing one: a gate whose scenario belongs to no leg cannot be
  // re-measured, so adding a gate without touching LEGS must be caught here
  // rather than at 2am on a red main.
  it('maps every gated scenario to exactly one leg', () => {
    for (const gate of ALL_GATES) {
      expect(legForGate(gate), `gate ${gate.key} (${gate.scenarioPath})`).not.toBeNull();
    }
  });

  it('reads the scenario root out of a dot-path', () => {
    expect(scenarioRoot('scenarios.frameBudget.N8')).toBe('frameBudget');
    expect(scenarioRoot('scenarios.ram.panes8')).toBe('ram');
    expect(scenarioRoot('scenarios.ime')).toBe('ime');
    expect(scenarioRoot('meta.commit')).toBeNull();
    expect(scenarioRoot('scenarios.')).toBeNull();
    expect(scenarioRoot(undefined)).toBeNull();
  });

  it('puts the scenarios that share one app instance in one leg', () => {
    // ram.panes8 is sampled after inputLatency has typed into that instance, so
    // they cannot be re-run apart. Same for the three W2 scenarios.
    const a1 = LEGS.find((l) => l.key === 'a1');
    expect(a1.roots).toEqual(expect.arrayContaining(['ram', 'inputLatency', 'inputLatency8']));
    const w2 = LEGS.find((l) => l.key === 'w2');
    expect(w2.roots).toEqual(expect.arrayContaining(['ime', 'frameBudget', 'webglContextLoss']));
  });
});

describe('benchArgsForLegs', () => {
  it('skips every other leg and nothing of its own', () => {
    expect(benchArgsForLegs(['w2'])).toEqual([
      '--skip-cold',
      '--skip-ram',
      '--skip-input',
      '--skip-hidden-flood',
    ]);
    expect(benchArgsForLegs(['coldStart'])).toEqual([
      '--skip-ram',
      '--skip-input',
      '--skip-ime',
      '--skip-frame-budget',
      '--skip-webgl-recovery',
      '--skip-hidden-flood',
    ]);
  });

  it('re-runs both halves of a shared-instance leg, never one metric', () => {
    // The #570 contract: a retry narrowed to the failing metric measures a
    // different scenario. Asking for a1 must never emit --skip-ram or
    // --skip-input, whichever half went red.
    const args = benchArgsForLegs(['a1']);
    expect(args).not.toContain('--skip-ram');
    expect(args).not.toContain('--skip-input');
  });

  it('emits nothing when every leg is wanted, and rejects an unknown leg', () => {
    expect(benchArgsForLegs(LEGS.map((l) => l.key))).toEqual([]);
    expect(() => benchArgsForLegs(['nope'])).toThrow(/unknown leg/);
  });
});

describe('benchArgsForConfig', () => {
  it('reproduces the original run knobs rather than the defaults', () => {
    expect(benchArgsForConfig(META)).toEqual([
      '--mode', 'ci',
      '--cold-runs', '3',
      '--samples', '80',
      '--samples8', '40',
      '--frame-budget-panes', '4,8,16',
      '--hidden-flood-agents', '4,8',
    ]);
  });

  it('forwards a seeded scrollback and the retention A/B leg, but not their absence', () => {
    const seeded = benchArgsForConfig({
      ...META,
      config: { ...META.config, scrollbackLines: 1000, hiddenRetention: true, frameBudgetPanes: [4, 8] },
    });
    expect(seeded).toContain('--scrollback-lines');
    expect(seeded[seeded.indexOf('--scrollback-lines') + 1]).toBe('1000');
    expect(seeded).toContain('--hidden-retention');
    // A narrowed sweep must be reproduced too — a retry that measured N16 when
    // the run did not is not the same measurement.
    expect(seeded[seeded.indexOf('--frame-budget-panes') + 1]).toBe('4,8');
    expect(benchArgsForConfig(META)).not.toContain('--scrollback-lines');
    expect(benchArgsForConfig(META)).not.toContain('--hidden-retention');
  });

  it('falls back to a local-mode run when meta is empty, without inventing knobs', () => {
    expect(benchArgsForConfig(undefined)).toEqual(['--mode', 'local']);
  });
});

// A flag name this module gets wrong is invisible to every test above and to
// the type-checker, and perf-bench answers an unknown flag by printing its help
// and exiting 0 — a re-run that measured NOTHING and reported success. So parse
// the real parser out of perf-bench.mjs and run the generated argv through it.
// One mechanical extraction, no hand-copied duplicate of the flag table.
describe('the argv perf-bench actually receives', () => {
  const BENCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'perf-bench.mjs');
  const OPEN = 'function parseArgs(argv) {';
  const CLOSE = '\nconst ARGS = parseArgs(process.argv.slice(2));';

  function realParseArgs() {
    const src = fs.readFileSync(BENCH, 'utf8').replace(/\r\n/g, '\n');
    expect(src.split(OPEN)).toHaveLength(2);
    expect(src.split(CLOSE)).toHaveLength(2);
    const body = src.slice(src.indexOf(OPEN), src.indexOf(CLOSE)).trim();
    // The extracted declaration closes on its own brace; anything else means
    // the anchors moved and this test is reading the wrong slice.
    expect(body.endsWith('}')).toBe(true);
    return new Function(`${body}; return parseArgs;`)();
  }

  it('is accepted flag for flag, and disables exactly the other legs', () => {
    const parseArgs = realParseArgs();
    const args = parseArgs([
      ...benchArgsForConfig(META),
      ...benchArgsForLegs(['w2']),
      '--json', 'out/perf-retry.json',
    ]);
    // help=true is how perf-bench reports an unknown flag, so this assertion is
    // the one that catches a renamed or mistyped switch.
    expect(args.help).toBe(false);
    expect(args).toMatchObject({
      mode: 'ci',
      coldRuns: 3,
      samples: 80,
      samples8: 40,
      frameBudgetPanes: [4, 8, 16],
      hiddenFloodAgents: [4, 8],
      skipCold: true,
      skipRam: true,
      skipInput: true,
      skipHiddenFlood: true,
      skipIme: false,
      skipFrameBudget: false,
      skipWebglRecovery: false,
      json: 'out/perf-retry.json',
    });
  });

  it('leaves each leg standing on its own', () => {
    const parseArgs = realParseArgs();
    const enabled = (legKey) => {
      const a = parseArgs([...benchArgsForConfig(META), ...benchArgsForLegs([legKey])]);
      expect(a.help).toBe(false);
      return {
        coldStart: !a.skipCold,
        a1: !a.skipRam || !a.skipInput,
        w2: !a.skipIme || !a.skipFrameBudget || !a.skipWebglRecovery,
        hiddenFlood: !a.skipHiddenFlood,
      };
    };
    for (const leg of LEGS) {
      const on = enabled(leg.key);
      expect(Object.entries(on).filter(([, v]) => v).map(([k]) => k)).toEqual([leg.key]);
    }
  });

  it('can tell a bad flag from a good one', () => {
    // Negative control: without this, the assertions above would pass even if
    // perf-bench had stopped reporting unknown flags.
    expect(realParseArgs()(['--skip-nonexistent']).help).toBe(true);
  });
});

describe('buildRetryPlan', () => {
  const base = { gates: ALL_GATES, meta: META };

  it('collapses failing metrics to their legs and builds a runnable argv', () => {
    const plan = buildRetryPlan({ ...base, failedKeys: ['frameBudgetP95Ms_N8', 'frameBudgetP95Ms_N16'] });
    expect(plan.legs).toEqual(['w2']);
    expect(plan.unmappedGateKeys).toEqual([]);
    expect(plan.benchArgs).toEqual([
      '--mode', 'ci',
      '--cold-runs', '3',
      '--samples', '80',
      '--samples8', '40',
      '--frame-budget-panes', '4,8,16',
      '--hidden-flood-agents', '4,8',
      '--skip-cold', '--skip-ram', '--skip-input', '--skip-hidden-flood',
    ]);
  });

  it('re-runs several legs at once, in a stable order', () => {
    const plan = buildRetryPlan({ ...base, failedKeys: ['hiddenFloodEchoP95Ms_N4', 'coldFirstPtyDataMs'] });
    expect(plan.legs).toEqual(['coldStart', 'hiddenFlood']);
    expect(plan.benchArgs).toContain('--skip-input');
    expect(plan.benchArgs).not.toContain('--skip-cold');
    expect(plan.benchArgs).not.toContain('--skip-hidden-flood');
  });

  it('re-runs the whole a1 leg when only one of its metrics failed', () => {
    const plan = buildRetryPlan({ ...base, failedKeys: ['ram8Bytes'] });
    expect(plan.legs).toEqual(['a1']);
    expect(plan.benchArgs).not.toContain('--skip-input');
  });

  it('covers the boolean gates too', () => {
    const plan = buildRetryPlan({ ...base, failedKeys: ['imePass'] });
    expect(plan.legs).toEqual(['w2']);
  });

  it('reports an unmappable gate instead of silently dropping it', () => {
    const plan = buildRetryPlan({
      ...base,
      gates: [...ALL_GATES, { key: 'futureGate', scenarioPath: 'scenarios.somethingNew' }],
      failedKeys: ['futureGate', 'ram8Bytes'],
    });
    expect(plan.unmappedGateKeys).toEqual(['futureGate']);
    expect(plan.legs).toEqual(['a1']);
  });

  it('reports a key that matches no gate at all', () => {
    const plan = buildRetryPlan({ ...base, failedKeys: ['typoKey'] });
    expect(plan.unmappedGateKeys).toEqual(['typoKey']);
    expect(plan.legs).toEqual([]);
  });
});
