// Confirmation re-run for a red perf gate (#570).
//
// A deterministic regression should reproduce on a second measurement of the
// same code; a runner-interference tail spike should not. So when the gate goes
// red, the failing LEGS are measured once more on the same runner and the red
// only stands if the failure reproduces. It costs extra CI time only on runs
// that are already red, and it touches no baseline — the "descriptive, not
// aspirational" policy in bench/README.md is unaffected.
//
// This is a module, not a second CI step and not a second CLI. perf-compare
// calls confirmGate() with the very objects it judged, which is what makes the
// confirmation provably about the run that went red: there is no second read of
// the result file, no window in which it could change underneath us, and no
// handshake file that could outlive its run and describe a different one.
//
// Three invariants, all enforced here rather than left as convention:
//
//   1. ONLY MEASUREMENTS ARE CONFIRMED. A red that includes a boolean
//      correctness gate (ime.pass, webglContextLoss.pass) stands immediately
//      and is never re-run: they are a pass/fail consistency check, not a
//      tail-prone measurement, and "it worked the second time" is not a reason
//      to ship a broken one. The same cuts the other way — a leg re-runs ALL of
//      its scenarios, so a correctness gate that fails in the re-run keeps the
//      red even though it is not what went red first.
//   2. THE FILES THE VERDICT RESTS ON SURVIVE. The re-run writes a file this
//      process creates atomically (`wx+`, so an existing name is refused and
//      never deleted), refuses a target that is the result file or the baseline
//      by any name, and holds the claimed file open until it verifies that the
//      path still has the same identity. The result file and the baseline are
//      compared byte for byte before and after the re-run — whatever happens,
//      including a crash — and put back if they moved. The result file is the
//      sample published to the trend, and replacing it with the calm retry
//      would quietly undo #606.
//   3. IT FAILS CLOSED. An unreadable file, a re-run that crashes, a commit or
//      schema mismatch, a gate that comes back SKIP because its leg died — all
//      of them are "could not confirm", and could-not-confirm keeps the red.
//      The only path to a green is an explicit PASS on every failing gate.
//
// NOTE: intentionally no shebang line (same repo gotcha as perf-compare.mjs —
// vitest imports this .mjs on Windows CI and a leading shebang throws).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GATES,
  BOOL_GATES,
  compareResults,
  compareBoolGates,
  getPath,
  fmtValue,
  tailRegressionNote,
} from './perf-compare.mjs';
import { LEGS, buildRetryPlan, legForGate } from './perf-legs.mjs';
import { sameFileReason, claimNewFile, fileIdentity } from './perf-paths.mjs';

const LEG_LABEL = new Map(LEGS.map((l) => [l.key, l.label]));
const BOOL_GATE_KEYS = new Set(BOOL_GATES.map((g) => g.key));
const ALL_GATES = [...GATES, ...BOOL_GATES];

/** Anything that makes a confirmation impossible. Callers treat it as red. */
export class UnconfirmableError extends Error {}

function unconfirmable(msg) {
  throw new UnconfirmableError(msg);
}

/**
 * What to re-run, from the verdict the gate just computed in this process.
 *
 * A failing boolean gate makes the whole red unconfirmable on purpose (see
 * invariant 1): its red stands regardless, so re-running the rest would spend
 * CI time to reach the same answer.
 */
export function planFromResults(results, meta) {
  const failedKeys = results.filter((r) => r.status === 'FAIL').map((r) => r.key);
  if (failedKeys.length === 0) unconfirmable('there is no failing gate to confirm');
  const failedBool = failedKeys.filter((k) => BOOL_GATE_KEYS.has(k));
  if (failedBool.length > 0) {
    unconfirmable(
      `${failedBool.join(', ')} is a correctness check, not a measurement — it is not re-run, and its failure stands`,
    );
  }
  const plan = buildRetryPlan({ failedKeys, gates: [...GATES, ...BOOL_GATES], meta });
  if (plan.unmappedGateKeys.length > 0) {
    unconfirmable(
      `these gates belong to no bench leg, so they cannot be re-measured: ${plan.unmappedGateKeys.join(', ')}. `
      + 'Add the scenario to a leg in scripts/perf-legs.mjs.',
    );
  }
  if (plan.legs.length === 0) unconfirmable('no bench leg to re-run');
  return plan;
}

/**
 * The re-run's target must be a file this process creates.
 *
 * `claimNewFile` is an atomic `wx+` create, so this refuses an existing file
 * without ever deleting one — a path typo is the likely way this is wrong, and
 * clearing whatever happened to be there would turn a typo into data loss — and
 * it closes the pre-create window an exists-then-write check leaves open. The
 * returned claim keeps the created file open until the caller checks its
 * identity after the bench, so a later name swap is detected and deleting the
 * original cannot make its inode reusable during the measurement window.
 */
export function claimRetryTarget(retryJson, ...protectedPaths) {
  for (const guarded of protectedPaths.filter(Boolean)) {
    const why = sameFileReason(retryJson, guarded);
    if (why) {
      unconfirmable(`the re-run would write over '${guarded}' (${why}), which this run depends on`);
    }
  }
  try {
    return claimNewFile(retryJson);
  } catch (err) {
    unconfirmable(
      err.code === 'EEXIST'
        ? `'${retryJson}' already exists — the re-run writes a fresh file and will not overwrite one`
        : err.code === 'ENOTSUP'
          ? `cannot verify the identity of '${retryJson}': ${err.message}`
          : `could not create '${retryJson}': ${err.message}`,
    );
    return null; // unreachable; keeps the control flow obvious
  }
}

/**
 * Judge everything the re-run actually measured, against the same baseline.
 *
 * Not just the gates that failed the first time: a leg re-runs all of its
 * scenarios, so the w2 retry measures ime and webglContextLoss alongside
 * frameBudget, and a correctness check that fails there is a failure whichever
 * run surfaced it. Clearing a job while the re-run itself is red would be the
 * worst possible reading of "did not reproduce".
 *
 * Gates from legs that were not selected are excluded — their absence says
 * nothing. Within a selected leg, however, every scenario that the first run
 * measured must appear again. Otherwise a retry could clear one recovered
 * metric by silently dropping a sibling correctness check.
 *
 * Fail closed: the job clears only when every judged gate is an explicit PASS.
 * A leg that crashed reports SKIP or drops the metric, and "we could not
 * measure it again" is not "it was fine".
 */
export function judgeRetry(
  retry,
  baseline,
  failedGateKeys,
  { original = null, plannedLegs = [] } = {},
) {
  const selected = new Set(plannedLegs);
  const required = new Set(failedGateKeys);
  for (const gate of ALL_GATES) {
    if (selected.has(legForGate(gate)) && getPath(original, gate.scenarioPath) != null) {
      required.add(gate.key);
    }
  }

  const measured = ALL_GATES.filter((g) => getPath(retry, g.scenarioPath) != null);
  const measuredKeys = new Set(measured.map((g) => g.key));
  const missing = [...required].filter((k) => !measuredKeys.has(k));
  if (missing.length > 0) {
    unconfirmable(`the re-run did not measure ${missing.join(', ')}, so its failure is not answered`);
  }
  const verdicts = [
    ...compareResults(retry, baseline, measured.filter((g) => !BOOL_GATE_KEYS.has(g.key))),
    ...compareBoolGates(retry, measured.filter((g) => BOOL_GATE_KEYS.has(g.key))),
  ];
  const unresolved = verdicts.filter((v) => v.status !== 'PASS');
  return { verdicts, unresolved, reproduced: unresolved.length > 0 };
}

/** Gate metadata (numeric or boolean) by key. */
function gateByKey(key) {
  return GATES.find((g) => g.key === key) ?? BOOL_GATES.find((g) => g.key === key) ?? null;
}

export function renderConfirmationMarkdown({ plan, verdicts, original, reproduced }) {
  const legs = plan.legs.map((k) => `\`${k}\` (${LEG_LABEL.get(k) ?? 'unknown leg'})`).join(', ');
  const lines = [
    '',
    '## Perf gate — confirmation re-run (#570)',
    '',
    `The gate went red, so the failing legs were measured once more on this runner: ${legs}.`,
    'The first run\'s result file is untouched — it is the sample published to the perf trend.',
    'Every metric those legs measure is listed, not only the ones that went red:',
    'a leg re-runs all of its scenarios, and a failure among them counts.',
    '',
    '| Metric | Baseline | First run | Re-run | Verdict |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  const wentRed = new Set(plan.failedGateKeys ?? []);
  for (const v of verdicts) {
    const gate = gateByKey(v.key);
    const unit = v.unit ?? gate?.unit;
    const first = gate ? getPath(original, gate.path) : undefined;
    const firstText = first === undefined ? '—' : fmtValue(first === null ? null : first, unit);
    const verdict = v.status === 'PASS'
      ? (wentRed.has(v.key) ? 'did not reproduce' : 'ok')
      : `still ${v.status}`;
    lines.push(
      `| ${wentRed.has(v.key) ? `**${v.label}**` : v.label} | ${fmtValue(v.baseline, unit)} | ${firstText} `
      + `| ${fmtValue(v.current, unit)} | ${verdict} |`,
    );
  }
  lines.push('');
  lines.push(
    reproduced
      ? '**Reproduced on the same runner — the gate stands red.** The same metric failed on a second measurement of the same code, taken on the machine that produced the first one. That separates a transient tail spike from a repeatable one; it cannot distinguish a code regression from a runner degraded for its whole lifetime (#940).'
      : '**Not reproduced — the gate is cleared.** Every failing metric came back within bounds on a second measurement of the same code. The first run\'s numbers are still in the trend and in this run\'s artifact; if this keeps happening on one metric, that is a calibration problem worth its own issue rather than a re-run.',
  );
  lines.push('');
  return lines.join('\n');
}

// --- IO, injectable so the decision path is testable without a packaged app --

export function defaultDeps(benchScript) {
  const bench = benchScript
    ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'perf-bench.mjs');
  return {
    // Raw bytes, for the before/after integrity check. Null when unreadable —
    // which the caller treats as "it moved", never as "it is fine".
    readBytes(file) {
      try {
        return fs.readFileSync(file);
      } catch {
        return null;
      }
    },
    writeBytes(file, bytes) {
      fs.writeFileSync(file, bytes);
    },
    remove(file) {
      fs.rmSync(file, { force: true });
    },
    runBench(args) {
      const res = spawnSync(process.execPath, [bench, ...args], { stdio: 'inherit' });
      if (res.error) throw new UnconfirmableError(`could not start the re-run: ${res.error.message}`);
      if (res.signal) throw new UnconfirmableError(`the re-run was killed by ${res.signal}`);
      return res.status ?? 1;
    },
    claimRetryTarget,
    identify: fileIdentity,
    log(msg) {
      process.stdout.write(msg);
    },
  };
}

/**
 * Measure the failing legs again and judge them.
 *
 * `current`, `baseline` and `results` are the objects the gate judged, passed
 * in rather than re-read: a second read of the same path is a second run's
 * worth of trust, and that is the gap a confirmation must not have.
 */
export function runConfirmation({
  current, baseline, results, currentJson, currentBytes, baselineJson, baselineBytes, retryJson, deps,
}) {
  const plan = planFromResults(results, current?.meta);
  if (currentBytes == null) unconfirmable(`no original bytes were captured for '${currentJson}'`);
  const claim = deps.claimRetryTarget(retryJson, currentJson, baselineJson);

  // Every file this run depends on, with the bytes it had before this process
  // wrote anything.
  const guarded = [[currentJson, currentBytes], [baselineJson, baselineBytes]]
    .filter(([file, bytes]) => file && bytes);

  const benchArgs = [...plan.benchArgs, '--json', retryJson];
  let status;
  const damaged = [];
  let removeEmptyTarget = false;
  let retryBytes = null;
  let retryReadError = null;
  try {
    status = deps.runBench(benchArgs);
  } finally {
    try {
      // Whatever happened — a clean run, a nonzero exit, a throw — the files
      // this verdict rests on have to be on disk, unchanged, when this returns.
      for (const [file, before] of guarded) {
        const after = deps.readBytes(file);
        if (after != null && after.equals(before)) continue;
        damaged.push(file);
        let restored = false;
        try {
          deps.writeBytes(file, before);
          restored = true;
        } catch { /* reported either way */ }
        deps.log(
          `::error::The re-run changed '${file}', which this run's verdict rests on. `
          + `${restored ? 'It has been restored from memory.' : 'It could NOT be restored.'}\n`,
        );
      }
      // The target must still be the file this process created. Its original
      // handle remains open here, so a deleted inode cannot be reused to fool
      // this comparison.
      const now = deps.identify(retryJson);
      if (now !== claim.identity) {
        damaged.push(retryJson);
        deps.log(`::error::'${retryJson}' is no longer the file this run created — the re-run's output went somewhere else.\n`);
      } else {
        try {
          // These are the bytes the verdict will parse. Read them through the
          // still-open handle that `wx+` created, not by reopening the path
          // after checking it — that would add a final name-swap window.
          retryBytes = claim.readBytes();
          removeEmptyTarget = retryBytes.length === 0;
        } catch (err) {
          retryReadError = err;
        }
      }
    } finally {
      claim.release();
    }
    if (removeEmptyTarget) {
      // The bench wrote nothing, so the file here is the empty one this process
      // claimed. Release its handle, then take it back out of the way: leaving
      // it would make the next run refuse a target that was never really used.
      try {
        deps.remove(retryJson);
      } catch { /* harmless — the next run will say the target exists */ }
    }
  }
  if (damaged.length > 0) unconfirmable(`the re-run wrote to ${damaged.join(', ')}`);
  if (status !== 0) {
    unconfirmable(`the re-run exited ${status} — treating the original red as authoritative`);
  }

  if (retryReadError) {
    unconfirmable(`could not read '${retryJson}' through the file this run claimed: ${retryReadError.message}`);
  }
  let retry;
  try {
    retry = JSON.parse(retryBytes.toString('utf8'));
  } catch (err) {
    unconfirmable(`could not parse '${retryJson}': ${err.message}`);
  }
  // `JSON.parse('null')` succeeds, so a file holding `null` would reach the
  // schemaVersion read below and throw a TypeError — escaping the
  // UnconfirmableError contract and surfacing as a crash rather than the red
  // this gate is supposed to keep. Same guard shape as `--current` uses.
  if (retry === null || typeof retry !== 'object' || Array.isArray(retry)) {
    unconfirmable(`'${retryJson}' is not a result object`);
  }

  // The re-run has to be the same code and the same schema, or it is answering
  // a different question than the one the gate asked.
  if (baseline && retry.schemaVersion !== baseline.schemaVersion) {
    unconfirmable(`the re-run's schemaVersion (${retry.schemaVersion}) does not match the baseline's (${baseline.schemaVersion})`);
  }
  const firstCommit = current?.meta?.commit ?? null;
  const retryCommit = retry?.meta?.commit ?? null;
  if (firstCommit !== retryCommit) {
    unconfirmable(`the re-run measured commit ${retryCommit ?? 'unknown'} but the gate ran on ${firstCommit ?? 'unknown'}`);
  }

  const judged = judgeRetry(retry, baseline, plan.failedGateKeys, {
    original: current,
    plannedLegs: plan.legs,
  });
  return { plan, ...judged, retry, benchArgs };
}

function appendSummary(file, text, log) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(file, text, 'utf8');
  } catch (err) {
    // The verdict is the return value; a summary that would not write must not
    // change it in either direction.
    log(`::warning::could not append to the perf summary '${file}': ${err.message}\n`);
  }
}

/**
 * The entry perf-compare calls on a red. Returns `{ cleared, escalation }` —
 * never throws for an expected failure, because every one of them means the
 * same thing: the red stands.
 *
 * `escalation` is non-null on exactly one outcome: the re-run RAN and the
 * failure REPRODUCED on this runner. That is the one case a same-runner
 * measurement cannot settle (#940 — it separates a transient spike from a
 * repeatable one, but not a code regression from a machine degraded for its
 * whole lifetime), so it is the only case worth handing to a fresh-runner
 * confirmation job. Everything else stays null on purpose:
 *   - cleared: the red was a transient blip, absorbed here, nothing to escalate;
 *   - unconfirmable: a correctness-gate red or an infrastructure failure —
 *     "could not measure it again" must fail closed HERE, not ride to another
 *     machine as if it were a measurement question.
 */
export function confirmGate({
  current, baseline, results, currentJson, currentBytes, baselineJson, baselineBytes, retryJson,
  benchScript, summaryPath, deps = defaultDeps(benchScript),
}) {
  let outcome;
  try {
    deps.log(`Perf gate is red — confirming it with a re-run into '${retryJson}'.\n`);
    outcome = runConfirmation({
      current, baseline, results, currentJson, currentBytes, baselineJson, baselineBytes, retryJson, deps,
    });
  } catch (err) {
    if (!(err instanceof UnconfirmableError)) throw err;
    const msg = `Perf gate: not confirmed by a re-run (${err.message}). The gate stays red.`;
    deps.log(`::error::${msg}\n`);
    appendSummary(summaryPath, `\n## Perf gate — confirmation re-run (#570)\n\n> [!CAUTION]\n> ${msg}\n`, deps.log);
    return { cleared: false, escalation: null };
  }

  appendSummary(summaryPath, renderConfirmationMarkdown({
    plan: outcome.plan,
    verdicts: outcome.verdicts,
    original: current,
    reproduced: outcome.reproduced,
  }), deps.log);

  if (outcome.reproduced) {
    const which = outcome.unresolved.map((v) => `${v.label} (${v.status})`).join(', ');
    deps.log(`::error::Perf gate: the failure reproduced on the same runner — ${which}\n`);
    return {
      cleared: false,
      escalation: {
        failedGateKeys: outcome.plan.failedGateKeys,
        legs: outcome.plan.legs,
        benchArgs: outcome.plan.benchArgs,
      },
    };
  }
  // A green earned through this re-run must not report LESS than a plain green
  // would have: the first-run path prints tailRegressionNote when the median
  // regressed while the gated fastest boot did not, so the retry that clears a
  // red gets the same check on ITS numbers. Reported, never gating — same
  // contract as on the first run.
  const tailNote = tailRegressionNote(outcome.retry, baseline);
  if (tailNote) {
    deps.log(`::warning::${tailNote}\n`);
    appendSummary(summaryPath, `\n> [!NOTE]\n> ${tailNote}\n`, deps.log);
  }
  const which = outcome.verdicts.map((v) => v.label).join(', ');
  deps.log(
    `::warning::Perf gate: ${which} failed once and passed on an immediate re-run of the same code — `
    + 'recorded as CI noise, not a regression (#570). The original sample is in the trend and in this run\'s artifact.\n',
  );
  return { cleared: true, escalation: null };
}
