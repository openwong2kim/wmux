// Check one engine's run of an engine A/B (scripts/twenty-pane-stability.mjs)
// before its numbers are compared: it must have completed, on the engine it
// asked for at start and at end, with one daemon throughout, with its memory
// recorded, and torn down cleanly, so nothing of it runs on into the next
// engine's run. The harness
// exits 0 either way and only flags these in summary.json; the A/B workflow
// (.github/workflows/twenty-pane-ab-linux.yml) fails on them instead.
//
//   node scripts/twenty-pane-ab-check.mjs <run-out-dir> <node|rust>
//   node scripts/twenty-pane-ab-check.mjs --table <node-run-out-dir> <rust-run-out-dir>
//
// The first checks one run and prints its row of the A/B table. The second
// prints the table, a row per run that wrote a summary, and appends it to
// $GITHUB_STEP_SUMMARY when that is set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Why a run's numbers cannot be compared; empty when they can. */
export function abRunProblems(summary, engine) {
  const problems = [];
  if (summary.reason !== 'completed') problems.push(`the run ended "${summary.reason}", not completed`);
  if (summary.engine?.requested !== engine) problems.push(`the run asked for ${summary.engine?.requested ?? 'no engine'}, not ${engine}`);
  for (const at of ['start', 'end']) {
    const effective = summary.engine?.[at]?.effective;
    if (effective !== engine) problems.push(`the daemon ran ${effective ?? 'an unknown engine'} at the ${at}, not ${engine}`);
  }
  if (summary.daemonRespawned) problems.push('the daemon was respawned during the run');
  // The engine checks above already cover the engine flags.
  for (const flag of summary.flags ?? []) {
    if (/daemon was replaced/.test(flag)) problems.push(flag);
  }
  // Memory is what the A/B compares first; a trend with no sample compares nothing.
  for (const [name, trend] of [['daemon RSS', summary.memory?.daemonRss], ['process tree RSS', summary.memory?.processTree]]) {
    if (!trend) problems.push(`the run recorded no ${name}, so it cannot be compared on memory`);
  }
  if (summary.teardown?.clean !== true) {
    const pid = summary.daemonLingering?.pid;
    problems.push(`the instance was not torn down cleanly${pid ? ` (its daemon, pid ${pid}, was still alive)` : ''}, so it may run on into the next run`);
  }
  return problems;
}

/** One row of the Markdown table of the numbers the A/B compares. */
export function abRunRow(summary, engine) {
  const ms = (v) => (Number.isFinite(v) ? `${v} ms` : '-');
  const mib = (t) => (t ? `${t.firstMiB}→${t.lastMiB} (max ${t.maxMiB}) MiB, ${t.growthMiBPerHour ?? '-'} MiB/h` : '-');
  const n = (v) => v ?? '-';
  return `| ${engine} | ${mib(summary.memory?.daemonRss)} | ${mib(summary.memory?.processTree)} | ${ms(summary.keyboard?.echoMs?.p95)} | ${ms(summary.probes?.idle?.echoMs?.p95)} | ${n(summary.keyboard?.dropped)} / ${n(summary.probes?.dropped)} / ${n(summary.stalls?.episodes)} |`;
}

export const AB_TABLE_HEADER = '| Engine | Daemon RSS | Process tree RSS | Key p95 | Idle p95 | Dropped keys / probes / stalls |\n|---|---|---|---|---|---|';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const summaryFile = (dir) => path.join(dir, 'summary.json');
  const readSummary = (dir) => JSON.parse(fs.readFileSync(summaryFile(dir), 'utf8'));
  if (args[0] === '--table') {
    const rows = [['node', args[1]], ['rust', args[2]]]
      .filter(([, dir]) => dir && fs.existsSync(summaryFile(dir)))
      .map(([engine, dir]) => abRunRow(readSummary(dir), engine));
    const table = `${AB_TABLE_HEADER}\n${rows.join('\n')}\n`;
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
    process.exit(0);
  }
  const [dir, engine] = args;
  if (!dir || !['node', 'rust'].includes(engine)) {
    console.error('usage: twenty-pane-ab-check.mjs <run-out-dir> <node|rust> | --table <node-run-out-dir> <rust-run-out-dir>');
    process.exit(2);
  }
  if (!fs.existsSync(summaryFile(dir))) {
    console.error(`[ab-check] ${engine}: no ${summaryFile(dir)}; the run stopped before its first summary`);
    process.exit(1);
  }
  const summary = readSummary(dir);
  console.log(`${AB_TABLE_HEADER}\n${abRunRow(summary, engine)}`);
  const problems = abRunProblems(summary, engine);
  for (const p of problems) console.error(`[ab-check] ${engine}: ${p}`);
  process.exit(problems.length ? 1 : 0);
}
