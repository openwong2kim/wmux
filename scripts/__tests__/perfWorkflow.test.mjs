// Contract tests for .github/workflows/perf.yml (#570).
//
// The perf gate's verdict reaches the job as one step's exit code, and YAML is
// where that can be broken without a test, a type-check or a lint noticing:
//   - `continue-on-error` on the step, or on the job, makes a red non-fatal
//     (both are documented GitHub features, and the job-level one is invisible
//     from the step);
//   - an `if:` on the step means it can simply not run;
//   - a block `run:` with a second command hands the step the LAST command's
//     exit code instead of the gate's.
//
// So this file does two things. It asserts the invariants against the shipped
// workflow, and it proves the check can actually see them broken by running it
// against mechanically mutated copies of that same file — one substitution
// each, with the line delta asserted, so a check that silently stopped
// detecting anything fails here rather than passing forever.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.github',
  'workflows',
  'perf.yml',
);
// Normalised to LF: this repo checks out CRLF on Windows and the contract is
// about content, not line endings.
const TEXT = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

// Comments are prose — this file discusses `continue-on-error` at length, and
// prose must never satisfy (or violate) a contract.
function stripComments(text) {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

// Minimal step splitter: a step starts at a 6-space `- `, its body is the
// 8-space-or-deeper lines that follow.
function parseSteps(text) {
  const steps = [];
  let cur = null;
  for (const raw of stripComments(text).split('\n')) {
    if (/^ {6}- /.test(raw)) {
      const first = raw.replace(/^ {6}- /, '        ');
      cur = { name: null, lines: [first] };
      const named = /^\s*name:\s*(.+)$/.exec(first);
      if (named) cur.name = named[1].trim();
      steps.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.trim() === '') continue;
    if (!/^ {8}/.test(raw)) { cur = null; continue; }
    cur.lines.push(raw);
  }
  return steps;
}

// The keys of a job, i.e. the lines indented exactly four spaces under it.
function jobKeys(text, jobName) {
  const lines = stripComments(text).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}${jobName}:\\s*$`).test(l));
  if (start === -1) return null;
  const keys = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (!/^ {4}/.test(l)) break; // dedented back out of the job
    if (/^ {4}\S/.test(l)) keys.push(l.trim());
  }
  return keys;
}

const GATE = 'Compare against baseline';
const SUMMARY = 'Append summary to step summary';
const UPLOAD = 'Upload artifacts';
const GATE_RUN = '        run: node scripts/perf-compare.mjs --current out/perf-current.json --baseline bench/baseline-ci.json --summary perf-summary.md --confirm-retry out/perf-retry.json ${{ steps.histflag.outputs.value }}';
const SAFE_SPLICE_VALUES = new Set([
  '',
  '--append-history out/perf-history-line.ndjson',
]);

function flagValues(body, flag) {
  return [...body.matchAll(new RegExp(`${flag}\\s+(\\S+)`, 'g'))].map((m) => m[1]);
}

// Null unless the flag appears exactly once: a repeated flag means the file
// actually used depends on argv order, which is not something to read off a
// first regex match.
function flagValue(body, flag) {
  const all = flagValues(body, flag);
  return all.length === 1 ? all[0] : null;
}

/** Returns a list of violated invariants — empty means the workflow is sound. */
export function checkWorkflow(text) {
  const steps = parseSteps(text);
  const at = (name) => steps.findIndex((s) => s.name === name);
  const step = (name) => steps.find((s) => s.name === name);
  const v = [];

  const gateStep = step(GATE);
  if (!gateStep) return ['the compare step is gone'];
  const gate = gateStep.lines.join('\n');

  // 1. Nothing anywhere may make a failure non-fatal. Checked over the whole
  //    file rather than the step: `continue-on-error` is also a job-level key,
  //    and a job-level one is invisible from inside the step that would carry
  //    the verdict.
  if (/continue-on-error/.test(stripComments(text))) {
    v.push('the workflow uses continue-on-error, so a red gate would not fail the job');
  }

  // 2. The gate must actually run — as a step, and as a job. A job skipped by a
  //    job-level `if` reports success, and a required check that reports
  //    success does not block anything.
  if (/^\s*(?:if|"if"|'if')\s*:/m.test(gate)) v.push('the compare step is conditional, so it can be skipped');
  const job = jobKeys(text, 'bench');
  if (!job) v.push('the bench job is gone');
  else if (job.some((k) => /^(?:if|"if"|'if')\s*:/.test(k))) {
    v.push('the bench job is conditional, and a skipped job reports success');
  }

  // 2b. The step's script must be what actually runs it. A custom `shell:` is a
  //     template GitHub fills the script into, so it can drop it entirely.
  if (/^\s*(?:shell|"shell"|'shell')\s*:/m.test(gate)) v.push('the compare step overrides its shell, which decides what running the script even means');
  if (/^\s*(?:defaults|"defaults"|'defaults')\s*:/m.test(stripComments(text))) v.push('the workflow sets run defaults, which can swap the shell under the gate');

  // 3. Its exit code must BE perf-compare's: one single-line command, nothing
  //    chained after it.
  const runLines = gateStep.lines.filter((l) => /^\s*run:/.test(l));
  if (runLines.length !== 1) {
    v.push(`the compare step does not have exactly one run: (${runLines.length})`);
  } else {
    const runLine = runLines[0];
    const value = runLine.replace(/^\s*run:\s*/, '');
    const expectedValue = GATE_RUN.replace(/^\s*run:\s*/, '');
    if (/^[|>]/.test(value.trim())) {
      v.push('the compare step\'s run: is a block, so its exit code is the last command\'s, not the gate\'s');
    } else {
      if (value !== expectedValue) {
        v.push('the compare step is no longer the exact gate invocation whose exit-code contract is reviewed here');
      }
      if (!/^node scripts\/perf-compare\.mjs\b/.test(value)) {
        v.push('the compare step no longer starts with node scripts/perf-compare.mjs');
      }
      if (/[;&]|\|\||\bexit\b/.test(value)) {
        v.push('the compare step chains another command, so the gate\'s exit code may not reach the job');
      }
      // YAML folds a more-indented continuation into a plain scalar. Checking
      // only the first `run:` line would therefore miss an appended `; exit 0`
      // that GitHub executes as part of this same command.
      const runAt = gateStep.lines.indexOf(runLine);
      const runIndent = /^\s*/.exec(runLine)[0].length;
      for (let i = runAt + 1; i < gateStep.lines.length; i++) {
        const line = gateStep.lines[i];
        if (/^\s*/.exec(line)[0].length <= runIndent) break;
        v.push('the compare step adds a folded continuation to its single-line command');
        break;
      }
      // Whatever another step's output splices in becomes part of THIS command,
      // so the set of things that step can emit is part of the gate's contract.
      const refs = [...value.matchAll(/\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}/g)]
        .map((m) => ({ expression: m[0], id: m[1], output: m[2] }));
      const expressions = [...value.matchAll(/\$\{\{.*?\}\}/g)].map((m) => m[0]);
      const recognised = new Set(refs.map((r) => r.expression));
      if (expressions.some((expression) => !recognised.has(expression))) {
        v.push('the compare step contains an expression whose command-line value is not validated');
      }
      for (const { id, output } of refs) {
        const src = steps.find((s) => s.lines.some((l) => new RegExp(`^\\s*id\\s*:\\s*${id}\\s*$`).test(l)));
        if (!src) { v.push(`the compare step splices in the output of an unknown step '${id}'`); continue; }
        if (output !== 'value') {
          v.push(`the compare step splices an unvalidated output '${output}' from step '${id}'`);
          continue;
        }
        const writes = src.lines.filter((line) => /\bGITHUB_OUTPUT\b/i.test(line));
        if (writes.length === 0) {
          v.push(`what step '${id}' can splice into the gate command is no longer readable`);
        }
        for (const line of writes) {
          const literal = /^\s*"value=([^"]*)"\s*\|\s*Out-File\s+-FilePath\s+\$env:GITHUB_OUTPUT\s+-Append\s*$/.exec(line);
          if (!literal) {
            v.push(`what step '${id}' can splice into the gate command is no longer a literal output`);
          } else if (!SAFE_SPLICE_VALUES.has(literal[1])) {
            v.push(`step '${id}' can splice ${JSON.stringify(literal[1])} into the gate command`);
          }
        }
      }
    }
  }

  // 4. The confirmation re-run (#570) must write its own file, and never one
  //    this run depends on.
  for (const flag of ['--current', '--baseline', '--summary', '--confirm-retry']) {
    const n = flagValues(gate, flag).length;
    if (n > 1) v.push(`the compare step passes ${flag} ${n} times, so which file it uses depends on argv order`);
  }
  const retryJson = flagValue(gate, '--confirm-retry');
  if (!retryJson) v.push('the compare step no longer asks for a confirmation re-run');
  else if (retryJson === flagValue(gate, '--current')) {
    v.push('the re-run would overwrite the result file published to the trend');
  } else if (retryJson === flagValue(gate, '--baseline')) {
    v.push('the re-run would overwrite the baseline');
  }

  // 5. Order: the summary is collected after the gate has written it.
  if (at(SUMMARY) < at(GATE)) v.push('the step summary is collected before the gate writes it');

  // 6. Both samples have to leave the runner — the retry is the evidence that
  //    the red was noise, and #570 is waiting on exactly this kind of data.
  const upload = step(UPLOAD)?.lines.join('\n') ?? '';
  if (retryJson && !upload.includes(retryJson)) v.push('the re-run result is not uploaded with the artifacts');

  return v;
}

/** One mechanical substitution, asserted to hit exactly once. */
function mutate(text, from, to) {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`expected exactly one occurrence of ${JSON.stringify(from)}, found ${parts.length - 1}`);
  return parts.join(to);
}

/** How many lines differ between two texts, counting a replacement as 2. */
function lineDelta(a, b) {
  const bag = new Map();
  for (const l of a.split('\n')) bag.set(l, (bag.get(l) ?? 0) + 1);
  let onlyInB = 0;
  for (const l of b.split('\n')) {
    const n = bag.get(l) ?? 0;
    if (n > 0) bag.set(l, n - 1);
    else onlyInB++;
  }
  let onlyInA = 0;
  for (const n of bag.values()) onlyInA += n;
  return onlyInA + onlyInB;
}

describe('perf.yml gate contract', () => {
  it('holds on the shipped workflow', () => {
    expect(checkWorkflow(TEXT)).toEqual([]);
  });

  it.each([
    {
      what: 'the gate step is made non-fatal',
      mutated: () => mutate(TEXT, '      - name: Compare against baseline\n', '      - name: Compare against baseline\n        continue-on-error: true\n'),
      lines: 1,
      expected: /would not fail the job/,
    },
    {
      // Invisible from the step, and a documented GitHub feature: the job's own
      // failure stops failing the workflow.
      what: 'the whole job is made non-fatal',
      mutated: () => mutate(TEXT, '    runs-on: windows-latest\n', '    runs-on: windows-latest\n    continue-on-error: true\n'),
      lines: 1,
      expected: /would not fail the job/,
    },
    {
      // Invisible from the step, and a skipped job reports Success — a required
      // check that reports success blocks nothing.
      what: 'the whole job is made conditional',
      mutated: () => mutate(TEXT, '    runs-on: windows-latest\n', '    if: false\n    runs-on: windows-latest\n'),
      lines: 1,
      expected: /skipped job reports success/,
    },
    {
      // YAML permits whitespace before `:` in a plain mapping key.
      what: 'the whole job is made conditional with spaced YAML punctuation',
      mutated: () => mutate(TEXT, '    runs-on: windows-latest\n', '    if : false\n    runs-on: windows-latest\n'),
      lines: 1,
      expected: /skipped job reports success/,
    },
    {
      what: 'the whole job is made conditional with a quoted YAML key',
      mutated: () => mutate(TEXT, '    runs-on: windows-latest\n', '    "if": false\n    runs-on: windows-latest\n'),
      lines: 1,
      expected: /skipped job reports success/,
    },
    {
      what: 'the gate step gets a custom shell',
      mutated: () => mutate(
        TEXT,
        '      - name: Compare against baseline\n',
        '      - name: Compare against baseline\n        shell: bash -e {0}\n',
      ),
      lines: 1,
      expected: /overrides its shell/,
    },
    {
      what: 'the gate step gets a custom shell with spaced YAML punctuation',
      mutated: () => mutate(
        TEXT,
        '      - name: Compare against baseline\n',
        '      - name: Compare against baseline\n        shell : bash -e {0}\n',
      ),
      lines: 1,
      expected: /overrides its shell/,
    },
    {
      what: 'the gate step gets a custom shell with a quoted YAML key',
      mutated: () => mutate(
        TEXT,
        '      - name: Compare against baseline\n',
        '      - name: Compare against baseline\n        "shell": bash -e {0}\n',
      ),
      lines: 1,
      expected: /overrides its shell/,
    },
    {
      // The history flag is spliced into the gate command, so what that step
      // can emit is part of this command's contract.
      what: 'the spliced-in history flag grows a second command',
      mutated: () => mutate(
        TEXT,
        '"value=--append-history out/perf-history-line.ndjson"',
        '"value=--append-history out/perf-history-line.ndjson; exit 0"',
      ),
      lines: 2,
      expected: /can splice .* into the gate command/,
    },
    {
      // `\S+` is not a shell-safe path pattern: `;exit` contains no whitespace
      // and makes PowerShell report success after a red gate.
      what: 'the spliced-in history path hides a second command without whitespace',
      mutated: () => mutate(
        TEXT,
        '"value=--append-history out/perf-history-line.ndjson"',
        '"value=--append-history out/perf-history-line.ndjson;exit"',
      ),
      lines: 2,
      expected: /can splice .* into the gate command/,
    },
    {
      what: 'the gate step is made conditional',
      mutated: () => mutate(TEXT, '      - name: Compare against baseline\n', '      - name: Compare against baseline\n        if: false\n'),
      lines: 1,
      expected: /can be skipped/,
    },
    {
      what: 'the gate swallows the script exit code in a block',
      mutated: () => mutate(
        TEXT,
        `${GATE_RUN}\n`,
        '        run: |\n          node scripts/perf-compare.mjs --current out/perf-current.json --baseline bench/baseline-ci.json --summary perf-summary.md --confirm-retry out/perf-retry.json\n          exit 0\n',
      ),
      lines: 4,
      expected: /exit code is the last command's/,
    },
    {
      // A more-indented continuation extends a YAML plain scalar. The first
      // `run:` line remains unchanged while GitHub executes the folded suffix.
      what: 'the single-line gate grows a folded command continuation',
      mutated: () => mutate(TEXT, `${GATE_RUN}\n`, `${GATE_RUN}\n          ; exit 0\n`),
      lines: 1,
      expected: /folded continuation/,
    },
    {
      // perf-compare handles --help before reading results and exits zero.
      what: 'the gate invocation gains a help flag',
      mutated: () => mutate(
        TEXT,
        ' --confirm-retry out/perf-retry.json ',
        ' --confirm-retry out/perf-retry.json --help ',
      ),
      lines: 2,
      expected: /exact gate invocation/,
    },
    {
      what: 'a command is chained after the gate',
      mutated: () => mutate(TEXT, '${{ steps.histflag.outputs.value }}', '${{ steps.histflag.outputs.value }} || true'),
      lines: 2,
      expected: /chains another command/,
    },
    {
      what: 'the re-run is pointed at the original sample',
      mutated: () => mutate(TEXT, '--confirm-retry out/perf-retry.json', '--confirm-retry out/perf-current.json'),
      lines: 2,
      expected: /overwrite the result file published to the trend/,
    },
    {
      what: 'the re-run is pointed at the baseline',
      mutated: () => mutate(TEXT, '--confirm-retry out/perf-retry.json', '--confirm-retry bench/baseline-ci.json'),
      lines: 2,
      expected: /overwrite the baseline/,
    },
    {
      // A second --current does not replace the first, so a checker reading the
      // first match would see agreement that the CLI does not honour.
      what: 'a flag is passed twice',
      mutated: () => mutate(TEXT, '--summary perf-summary.md', '--current out/elsewhere.json --summary perf-summary.md'),
      lines: 2,
      expected: /passes --current 2 times/,
    },
    {
      what: 'the re-run result is dropped from the artifacts',
      mutated: () => mutate(TEXT, '            out/perf-retry.json\n', ''),
      lines: 1,
      expected: /not uploaded with the artifacts/,
    },
  ])('catches it when $what', ({ mutated, lines, expected }) => {
    const text = mutated();
    // The copy under test differs from the shipped file on exactly the lines
    // this case is about — so a passing assertion is about the real workflow,
    // not about a hand-written approximation of it.
    expect(lineDelta(TEXT, text)).toBe(lines);
    expect(checkWorkflow(text).join(' | ')).toMatch(expected);
  });
});
