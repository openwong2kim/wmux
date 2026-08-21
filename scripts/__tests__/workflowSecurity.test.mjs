// Security contracts for GitHub Actions workflows (#615 F4/F5).
//
// A mutable action tag can be retargeted after review, and a GitHub expression
// interpolated into a `run:` script becomes executable source rather than data.
// Keep both properties mechanically enforced instead of relying on reviewers
// to spot a single unsafe line across several workflow files.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.github',
  'workflows',
);

const WORKFLOWS = fs
  .readdirSync(WORKFLOW_DIR)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort()
  .map((name) => ({
    name,
    text: fs
      .readFileSync(path.join(WORKFLOW_DIR, name), 'utf8')
      .replace(/\r\n/g, '\n'),
  }));

function externalActionUses(text) {
  const uses = [];
  for (const [index, line] of text.split('\n').entries()) {
    const match =
      /^\s*(?:-\s*)?(?:uses|"uses"|'uses'):\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/.exec(
        line,
      );
    if (!match) continue;
    const spec = match[1].replace(/^(['"])(.*)\1$/, '$2');
    if (spec.startsWith('./') || spec.startsWith('docker://')) continue;
    uses.push({ line: index + 1, spec, comment: match[2] ?? '' });
  }
  return uses;
}

export function actionPinViolations(fileName, text) {
  const violations = [];
  for (const use of externalActionUses(text)) {
    const at = use.spec.lastIndexOf('@');
    const ref = at === -1 ? '' : use.spec.slice(at + 1);
    if (!/^[0-9a-f]{40}$/.test(ref)) {
      violations.push(
        `${fileName}:${use.line} external action is not pinned to a full commit SHA: ${use.spec}`,
      );
    }
    if (!/^v\d+(?:\.\d+)*\b/.test(use.comment)) {
      violations.push(
        `${fileName}:${use.line} pinned action has no readable version comment`,
      );
    }
  }
  return violations;
}

function runScripts(text) {
  const lines = text.split('\n');
  const scripts = [];
  for (let index = 0; index < lines.length; index++) {
    const match =
      /^(\s*)(-\s+)?(?:run|"run"|'run'):\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length + (match[2]?.length ?? 0);
    const header = match[3].trim();
    const continuation = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex++) {
      const line = lines[bodyIndex];
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) {
        break;
      }
      continuation.push(line);
    }
    const blockHeader =
      /^[|>](?:(?:[-+][1-9]?)|(?:[1-9][-+]?))?$/.test(header);
    scripts.push({
      line: index + 1,
      text: blockHeader
        ? continuation.join('\n')
        : [header, ...continuation].join('\n'),
    });
  }
  return scripts;
}

export function runExpressionViolations(fileName, text) {
  return runScripts(text)
    .filter((script) => /\$\{\{[\s\S]*?\}\}/.test(script.text))
    .map(
      (script) =>
        `${fileName}:${script.line} run script interpolates a GitHub expression; pass it through env instead`,
    );
}

// One action, one commit, one version comment — across every workflow.
//
// actionPinViolations checks each `uses:` line on its own: 40 hex characters
// and a comment that starts with a version. Both of those held while
// actions/checkout sat pinned to two different commits for six months, each
// labelled `# v4`, because nothing ever compared the lines to each other. The
// comment is the only human-readable part of a pin and it is not machine-read,
// so it drifts silently; this is what reads it (#964).
export function pinConsistencyViolations(workflows) {
  const seen = new Map(); // action spec -> { sha, comment, where }
  const violations = [];
  for (const { name, text } of workflows) {
    for (const use of externalActionUses(text)) {
      const at = use.spec.lastIndexOf('@');
      if (at === -1) continue;
      const action = use.spec.slice(0, at);
      const sha = use.spec.slice(at + 1);
      const comment = use.comment.trim();
      const where = `${name}:${use.line}`;
      const first = seen.get(action);
      if (!first) {
        seen.set(action, { sha, comment, where });
        continue;
      }
      if (first.sha !== sha) {
        violations.push(
          `${where} pins ${action} to ${sha} but ${first.where} pins it to ${first.sha}: one action, one commit`,
        );
      } else if (first.comment !== comment) {
        violations.push(
          `${where} labels ${action}@${sha} "${comment}" but ${first.where} labels the same commit "${first.comment}"`,
        );
      }
    }
  }
  return violations;
}

describe('GitHub Actions workflow security contracts', () => {
  // The contract this enables — pinConsistencyViolations(WORKFLOWS) === [] —
  // turns on in the release.yml half of #964. It cannot pass before then: the
  // CI workflows move to v7 here while release.yml is still on v4, so the two
  // halves are legitimately split for as long as that PR is open. Landing the
  // assertion now would make a green tree red for a state we chose on purpose.
  // The detectors below prove the function works in the meantime.
  it('detects an action pinned to two different commits', () => {
    const drifted = [
      { name: 'a.yml', text: '      - uses: actions/checkout@' + 'a'.repeat(40) + ' # v7.0.1\n' },
      { name: 'b.yml', text: '      - uses: actions/checkout@' + 'b'.repeat(40) + ' # v7.0.1\n' },
    ];
    expect(pinConsistencyViolations(drifted).join(' | ')).toContain(
      'one action, one commit',
    );
  });

  it('detects one commit wearing two different version labels', () => {
    const mislabelled = [
      { name: 'a.yml', text: '      - uses: actions/checkout@' + 'a'.repeat(40) + ' # v7.0.1\n' },
      { name: 'b.yml', text: '      - uses: actions/checkout@' + 'a'.repeat(40) + ' # v4\n' },
    ];
    expect(pinConsistencyViolations(mislabelled).join(' | ')).toContain(
      'labels the same commit',
    );
  });

  it('pins every external action to an immutable commit with a version comment', () => {
    const violations = WORKFLOWS.flatMap(({ name, text }) =>
      actionPinViolations(name, text),
    );
    expect(violations).toEqual([]);
  });

  it('keeps GitHub expressions out of release run scripts', () => {
    const release = WORKFLOWS.find(({ name }) => name === 'release.yml');
    expect(release).toBeDefined();
    expect(runExpressionViolations(release.name, release.text)).toEqual([]);
  });

  it('detects a mutable action tag even with trailing whitespace', () => {
    const ci = WORKFLOWS.find(({ name }) => name === 'ci.yml');
    expect(ci).toBeDefined();
    // Match the pin by shape, never by the version it happens to carry today.
    // This fixture hardcoded `# v4`, so bumping checkout turned the replace
    // into a no-op and failed the assertion below — on a change with nothing
    // wrong with it. The lookahead keeps the comment out of the match, so the
    // mutation still leaves the trailing whitespace this test is about (#964).
    const pin = /actions\/checkout@[0-9a-f]{40}(?= # v)/;
    expect(ci.text).toMatch(pin);
    const mutated = ci.text.replace(pin, 'actions/checkout@v4 ');
    expect(mutated).not.toBe(ci.text);
    expect(actionPinViolations(ci.name, mutated).join(' | ')).toContain(
      'not pinned to a full commit SHA',
    );
  });

  it('detects direct expression interpolation in a release script', () => {
    const release = WORKFLOWS.find(({ name }) => name === 'release.yml');
    expect(release).toBeDefined();
    const mutated = release.text.replace(
      '$version  = $env:PKG_VERSION',
      '$version  = "${{ steps.pkg.outputs.version }}"',
    );
    expect(mutated).not.toBe(release.text);
    expect(
      runExpressionViolations(release.name, mutated).join(' | '),
    ).toContain('pass it through env instead');
  });

  it('detects expression interpolation in a folded run continuation', () => {
    const release = WORKFLOWS.find(({ name }) => name === 'release.yml');
    expect(release).toBeDefined();
    const runLine =
      '        run: choco push "out/choco/wmux.$env:PKG_VERSION.nupkg" --source https://push.chocolatey.org --api-key $env:CHOCO_API_KEY';
    const mutated = release.text.replace(
      runLine,
      `${runLine}\n          ; Write-Host "\${{ steps.pkg.outputs.version }}"`,
    );
    expect(mutated).not.toBe(release.text);
    expect(
      runExpressionViolations(release.name, mutated).join(' | '),
    ).toContain('pass it through env instead');
  });
});
