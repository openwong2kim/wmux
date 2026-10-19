#!/usr/bin/env node
// Open, update or close the `Nightly red: <workflow>` issue for this run.
//
//   node scripts/ci-failure-issue.mjs [--state failure|success|auto] [--dry-run]
//
// Runs in the `report` job of runtime.yml and windows.yml, on main, after the
// test jobs, with GH_TOKEN set and the GITHUB_* variables Actions provides.
// By default (auto) the run's finished jobs decide:
//
//   a job failed or timed out   comment on the open `ci-nightly` issue for this
//                               workflow, or open one (labels bug, ci-nightly);
//   all green                   close that issue with "green again at <run url>";
//   a job was cancelled         nothing (a newer push superseded the run).
//
//   --state failure|success     skip the job check (a manual or dry run);
//   --dry-run                   print the gh commands that would change
//                               something instead of running them. Reads print
//                               too and answer "nothing found".
//
// The rules are in scripts/lib/ci-failure-issue.mjs. An error exits 1: the
// report job turns red, which says the issue was not filed or closed.

import { spawnSync } from 'node:child_process';
import { report } from './lib/ci-failure-issue.mjs';

function parseArgs(argv) {
  const args = { state: 'auto', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--state') args.state = argv[++i] ?? null;
    else if (arg.startsWith('--state=')) args.state = arg.slice('--state='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// No shell: the body and title are argv entries, never parsed as a command
// line. libuv finds gh.exe on PATH on Windows without one.
function realGh(args, { allowFailure = false } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`gh ${args[0]} ${args[1]}: ${result.error.message}`);
  if (result.status !== 0) {
    if (allowFailure) return '';
    throw new Error(`gh ${args[0]} ${args[1]} exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function dryRunGh(args) {
  console.log(`gh ${args.map(quote).join(' ')}`);
  if (args[0] === 'issue' && args[1] === 'list') return '[]';
  if (args[0] === 'run' && args[1] === 'view') return '{"jobs":[]}';
  if (args[0] === 'run' && args[1] === 'list') return '[]';
  return '';
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ci-failure-issue: ${error.message}`);
    process.exit(2);
  }
  try {
    report({
      state: args.state,
      env: process.env,
      gh: args.dryRun ? dryRunGh : realGh,
      log: (line) => console.log(`ci-failure-issue: ${line}`),
    });
  } catch (error) {
    console.error(`ci-failure-issue: ${error.message}`);
    process.exit(1);
  }
}

main();
