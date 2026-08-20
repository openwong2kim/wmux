// Fresh-runner confirmation for an escalated perf red (#940).
//
// The in-job confirmation (#570 → #632, perf-confirm.mjs) separates a
// transient tail spike from a repeatable one — but it re-measures on the SAME
// machine, so it cannot distinguish a code regression from a runner that is
// degraded for its whole lifetime. All three real activations of the gate on
// `main` showed exactly that split: a red that reproduced on an immediate
// re-run was not reproducible on another machine 20 minutes later, and the
// only thing that told those cases apart was a human clicking "re-run all
// jobs".
//
// This CLI is that click, made a machine step. perf.yml runs it in a
// DEPENDENT JOB — a different runner by construction — and only when
// perf-compare wrote an escalation file, which it does in exactly one case:
// the same-runner confirmation ran to completion and the failure REPRODUCED.
// This job then re-measures the failing legs on its own machine and carries
// the gate's verdict:
//
//   - every escalated gate passes here  → exit 0. Two machines disagree, one
//     of them twice; the sample that cannot be reproduced elsewhere is
//     runner-health noise. The original sample is already in the trend — the
//     trend records what was measured, not what was excused (#606).
//   - anything fails here               → exit 1. The regression reproduced on
//     a SECOND machine, which is the strongest claim this pipeline can make.
//   - anything cannot be verified       → exit 1. Fail closed, same contract
//     as perf-confirm.mjs: "could not measure it again" is not "it was fine".
//
// CROSS-JOB HANDSHAKE, STATED HONESTLY. The in-job confirmation exists partly
// to avoid a handshake file that could describe a different run. A dependent
// job cannot avoid one — so instead of pretending otherwise, the handshake is
// bound to the one identity that matters: the COMMIT. The escalation file
// carries the short SHA the gate measured; this job refuses to run unless that
// SHA equals the HEAD it checked out itself, and refuses the verdict unless
// the re-run's own recorded SHA matches too. A stale artifact, a moved PR
// base, or a replayed escalation from another run all fail closed on the same
// check.
//
// NOTE: intentionally no shebang line (same repo gotcha as perf-compare.mjs —
// vitest imports this .mjs on Windows CI and a leading shebang throws).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GATES,
  BOOL_GATES,
  getPath,
  fmtValue,
} from './perf-compare.mjs';
import {
  UnconfirmableError,
  judgeRetry,
  claimRetryTarget,
} from './perf-confirm.mjs';
import { LEGS } from './perf-legs.mjs';

const ALL_GATES = [...GATES, ...BOOL_GATES];
const LEG_KEYS = new Set(LEGS.map((l) => l.key));

function unconfirmable(msg) {
  throw new UnconfirmableError(msg);
}

function parseArgs(argv) {
  const args = {
    escalation: null, current: null, baseline: null, json: null,
    summary: null, bench: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--escalation') args.escalation = argv[++i];
    else if (a === '--current') args.current = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--summary') args.summary = argv[++i];
    else if (a === '--bench') args.bench = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/perf-confirm-fresh.mjs --escalation <json> --current <json> \\',
    '       --baseline <json> --json <out-json> [--summary <md>] [--bench <script>]',
    '',
    'Runs the escalated bench legs on THIS machine and carries the perf gate\'s',
    'verdict (#940). Exit 0 only when every escalated gate passes here; any',
    'failure, and anything that cannot be verified, exits 1.',
  ].join('\n');
}

function readJson(file, what) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    unconfirmable(`could not read the ${what} '${file}': ${err.message}`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    unconfirmable(`could not parse the ${what} '${file}': ${err.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    unconfirmable(`the ${what} '${file}' is not an object`);
  }
  return { value, bytes };
}

/** The escalation payload perf-compare wrote, validated field by field. */
export function parseEscalation(payload) {
  if (payload.schemaVersion !== 1) {
    unconfirmable(`unknown escalation schemaVersion ${JSON.stringify(payload.schemaVersion)}`);
  }
  const { commit, failedGateKeys, legs, benchArgs } = payload;
  if (typeof commit !== 'string' || commit.length === 0) {
    unconfirmable('the escalation names no commit, so it cannot be bound to this checkout');
  }
  const gateKeys = new Set(ALL_GATES.map((g) => g.key));
  if (!Array.isArray(failedGateKeys) || failedGateKeys.length === 0
      || !failedGateKeys.every((k) => gateKeys.has(k))) {
    unconfirmable('the escalation\'s failedGateKeys are empty or name unknown gates');
  }
  if (!Array.isArray(legs) || legs.length === 0 || !legs.every((k) => LEG_KEYS.has(k))) {
    unconfirmable('the escalation\'s legs are empty or name unknown bench legs');
  }
  if (!Array.isArray(benchArgs) || !benchArgs.every((a) => typeof a === 'string')) {
    unconfirmable('the escalation\'s benchArgs are not a list of strings');
  }
  return { commit, failedGateKeys, legs, benchArgs };
}

export function defaultDeps(benchScript) {
  const bench = benchScript
    ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'perf-bench.mjs');
  return {
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
      if (res.error) throw new UnconfirmableError(`could not start the bench: ${res.error.message}`);
      if (res.signal) throw new UnconfirmableError(`the bench was killed by ${res.signal}`);
      return res.status ?? 1;
    },
    headCommit() {
      // The same command and the same cwd convention as perf-bench.mjs uses to
      // stamp meta.commit, so the two identities are comparable by equality.
      try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
          encoding: 'utf8',
        }).trim();
      } catch {
        return null;
      }
    },
    claimRetryTarget,
    log(msg) {
      process.stdout.write(msg);
    },
  };
}

function renderMarkdown({ escalation, verdicts, original, reproduced }) {
  const wentRed = new Set(escalation.failedGateKeys);
  const lines = [
    '',
    '## Perf gate — fresh-runner confirmation (#940)',
    '',
    `The red reproduced on the first job's runner, so its failing legs (${escalation.legs.map((k) => `\`${k}\``).join(', ')})`,
    'were measured again on THIS machine — a different runner by construction.',
    'Every metric those legs measure is listed, not only the ones that went red:',
    '',
    '| Metric | Baseline | First runner | This runner | Verdict |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  for (const v of verdicts) {
    const gate = ALL_GATES.find((g) => g.key === v.key) ?? null;
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
      ? '**Reproduced on a second machine — the gate is red.** The same code failed the same '
      + 'gate on two different runners, one of them twice. This is the strongest claim the '
      + 'pipeline can make, and it is not runner health.'
      : '**Not reproduced on a fresh runner — the gate is green.** The failure was measured '
      + 'twice on one machine and could not be measured at all on another; that is the '
      + 'signature of a runner degraded for its lifetime, not of the code. The first '
      + 'runner\'s sample is already in the trend and in its run\'s artifact — the trend '
      + 'records what was measured, not what was excused.',
  );
  lines.push('');
  return lines.join('\n');
}

function appendSummary(file, text, log) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(file, text, 'utf8');
  } catch (err) {
    log(`::warning::could not append to the perf summary '${file}': ${err.message}\n`);
  }
}

/**
 * The whole verdict, throwing UnconfirmableError for everything that fails
 * closed. Split from main() so tests drive it with injected deps and no
 * packaged app.
 */
export function runFreshConfirmation({ escalation: escalationPath, currentJson, baselineJson, retryJson, deps }) {
  const escalation = parseEscalation(readJson(escalationPath, 'escalation file').value);
  const { value: current, bytes: currentBytes } = readJson(currentJson, 'first-run result');
  const { value: baseline, bytes: baselineBytes } = readJson(baselineJson, 'baseline');

  // Identity, three ways, all fail-closed (see the header): the artifact must
  // describe the commit the FIRST job measured, and this job must have checked
  // out that exact commit itself.
  const firstCommit = current?.meta?.commit ?? null;
  if (firstCommit !== escalation.commit) {
    unconfirmable(
      `the escalation is for commit ${escalation.commit} but the first-run result measured ${firstCommit ?? 'unknown'}`,
    );
  }
  const head = deps.headCommit();
  if (head === null) {
    unconfirmable('could not read this checkout\'s HEAD, so the escalation cannot be bound to it');
  }
  if (head !== escalation.commit) {
    unconfirmable(
      `this job checked out ${head} but the escalation is for ${escalation.commit} — refusing to confirm a different commit`,
    );
  }

  const claim = deps.claimRetryTarget(retryJson, currentJson, baselineJson, escalationPath);
  const guarded = [[currentJson, currentBytes], [baselineJson, baselineBytes]];
  const benchArgs = [...escalation.benchArgs, '--json', retryJson];
  let status;
  const damaged = [];
  let retryBytes = null;
  let retryReadError = null;
  let removeEmptyTarget = false;
  try {
    status = deps.runBench(benchArgs);
  } finally {
    try {
      // Same contract as perf-confirm.mjs invariant 2: whatever happened, the
      // files this verdict rests on are back on disk, unchanged, and the
      // re-run's output is still the file this process created.
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
          `::error::The bench changed '${file}', which this verdict rests on. `
          + `${restored ? 'It has been restored from memory.' : 'It could NOT be restored.'}\n`,
        );
      }
      try {
        retryBytes = claim.readBytes();
        removeEmptyTarget = retryBytes.length === 0;
      } catch (err) {
        retryReadError = err;
      }
    } finally {
      claim.release();
    }
    if (removeEmptyTarget) {
      try {
        deps.remove(retryJson);
      } catch { /* harmless — the next run will say the target exists */ }
    }
  }
  if (damaged.length > 0) unconfirmable(`the bench wrote to ${damaged.join(', ')}`);
  if (status !== 0) unconfirmable(`the bench exited ${status}`);
  if (retryReadError) {
    unconfirmable(`could not read '${retryJson}' through the file this run claimed: ${retryReadError.message}`);
  }

  let retry;
  try {
    retry = JSON.parse(retryBytes.toString('utf8'));
  } catch (err) {
    unconfirmable(`could not parse '${retryJson}': ${err.message}`);
  }
  if (retry === null || typeof retry !== 'object' || Array.isArray(retry)) {
    unconfirmable(`'${retryJson}' is not a result object`);
  }
  if (baseline && retry.schemaVersion !== baseline.schemaVersion) {
    unconfirmable(`this run's schemaVersion (${retry.schemaVersion}) does not match the baseline's (${baseline.schemaVersion})`);
  }
  const retryCommit = retry?.meta?.commit ?? null;
  if (retryCommit !== escalation.commit) {
    unconfirmable(`this run measured commit ${retryCommit ?? 'unknown'} but the escalation is for ${escalation.commit}`);
  }

  const judged = judgeRetry(retry, baseline, escalation.failedGateKeys, {
    original: current,
    plannedLegs: escalation.legs,
  });
  return { escalation, ...judged, retry, current };
}

/** CLI verdict: 0 only on an explicit full PASS; 1 for everything else. */
export function freshConfirmGate({ escalation, currentJson, baselineJson, retryJson, summaryPath, deps }) {
  let outcome;
  try {
    deps.log(`Fresh-runner confirmation (#940): re-measuring the escalated legs into '${retryJson}'.\n`);
    outcome = runFreshConfirmation({ escalation, currentJson, baselineJson, retryJson, deps });
  } catch (err) {
    if (!(err instanceof UnconfirmableError)) throw err;
    const msg = `Perf gate: the fresh-runner confirmation could not run (${err.message}). Failing closed — the red stands.`;
    deps.log(`::error::${msg}\n`);
    appendSummary(summaryPath, `\n## Perf gate — fresh-runner confirmation (#940)\n\n> [!CAUTION]\n> ${msg}\n`, deps.log);
    return 1;
  }

  appendSummary(summaryPath, renderMarkdown({
    escalation: outcome.escalation,
    verdicts: outcome.verdicts,
    original: outcome.current,
    reproduced: outcome.reproduced,
  }), deps.log);

  if (outcome.reproduced) {
    const which = outcome.unresolved.map((v) => `${v.label} (${v.status})`).join(', ');
    deps.log(`::error::Perf gate: the failure reproduced on a second machine — ${which}\n`);
    return 1;
  }
  const which = outcome.escalation.failedGateKeys.join(', ');
  deps.log(
    `::warning::Perf gate: ${which} failed twice on the first runner and passed on this one — `
    + 'recorded as runner-health noise, not a regression (#940). The first sample is in the trend '
    + 'and in the first job\'s artifact.\n',
  );
  return 0;
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  for (const [flag, value] of [
    ['--escalation', args.escalation],
    ['--current', args.current],
    ['--baseline', args.baseline],
    ['--json', args.json],
  ]) {
    if (!value) {
      process.stderr.write(`error: ${flag} <path> is required\n\n` + usage() + '\n');
      return 2;
    }
  }
  return freshConfirmGate({
    escalation: args.escalation,
    currentJson: args.current,
    baselineJson: args.baseline,
    retryJson: args.json,
    summaryPath: args.summary,
    deps: defaultDeps(args.bench),
  });
}

// Same CLI guard as perf-compare.mjs: importing this module (vitest) must not
// run main().
if (process.argv[1]) {
  const invokedUrl = pathToFileURL(path.resolve(process.argv[1])).href;
  const selfUrl = import.meta.url;
  const samePath =
    invokedUrl === selfUrl ||
    fileURLToPath(invokedUrl).toLowerCase() === fileURLToPath(selfUrl).toLowerCase();
  if (samePath) {
    main().then(
      (code) => process.exit(code),
      (err) => {
        process.stderr.write(`error: ${err?.stack || err}\n`);
        process.exit(2);
      },
    );
  }
}
