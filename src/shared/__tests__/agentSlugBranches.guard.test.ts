// Guard for #1904 item 1: no NEW per-agent slug branches.
//
// A per-agent capability belongs on the agent's registry row
// (src/shared/agentIdentity.ts), where a new agent declares it in one place.
// A `slug === 'codex'` or `case 'claude':` written in a consumer is the
// opposite: the capability is implied by a comparison nobody adding an agent
// will find. This test counts such branches per file under src/ and compares
// them with the snapshot in agentSlugBranches.allowlist.json, taken when the
// registry learned capabilities. It fails when
//   - a file that is not in the snapshot gains a branch, or
//   - a file in the snapshot has more branches than its snapshot count.
// Fewer branches always pass; lower the count in the snapshot when you remove
// some, so the room is not reused.
//
// The aim is "no new scattered branches", not removing the existing ones. If a
// new branch really is the right shape (an adapter module that exists to speak
// one agent's protocol), regenerate the snapshot and say why in the PR:
//
//   WMUX_UPDATE_SLUG_BRANCHES=1 npx vitest run src/shared/__tests__/agentSlugBranches.guard.test.ts
//
// What counts: a string literal equal to a registry slug on either side of
// `===`, `!==`, `==` or `!=`, and `case '<slug>':`. Test files and the
// registry itself are not scanned. Not counted (a known gap): slug arrays such
// as `['claude', 'codex'].includes(x)`.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_SLUGS } from '../agentIdentity';

const SRC = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(SRC, '..');
const ALLOWLIST = path.join(__dirname, 'agentSlugBranches.allowlist.json');
const REGISTRY = path.join(SRC, 'shared', 'agentIdentity.ts');

const slugAlt = AGENT_SLUGS.join('|');
const BRANCH_RE = new RegExp(
  [
    `(?:===|!==|==|!=)\\s*(['"])(?:${slugAlt})\\1`,
    `(['"])(?:${slugAlt})\\2\\s*(?:===|!==|==|!=)`,
    `\\bcase\\s+(['"])(?:${slugAlt})\\3\\s*:`,
  ].join('|'),
  'g',
);

function isScanned(file: string): boolean {
  if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) return false;
  return path.resolve(file) !== REGISTRY;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && isScanned(full)) out.push(full);
  }
  return out;
}

/** Branch count per file, keyed by repo-relative forward-slash path. */
function countSlugBranches(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of walk(SRC, []).sort()) {
    const n = fs.readFileSync(file, 'utf8').match(BRANCH_RE)?.length ?? 0;
    if (n > 0) counts[path.relative(REPO, file).split(path.sep).join('/')] = n;
  }
  return counts;
}

function readAllowlist(): Record<string, number> {
  return (JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) as { files: Record<string, number> }).files;
}

describe('agent slug branches', () => {
  const counts = countSlugBranches();

  if (process.env.WMUX_UPDATE_SLUG_BRANCHES === '1') {
    fs.writeFileSync(ALLOWLIST, `${JSON.stringify({
      comment: 'Per-file count of agent slug branches allowed under src/. See agentSlugBranches.guard.test.ts.',
      files: counts,
    }, null, 2)}\n`);
  }

  it('the regex sees the shapes it is meant to', () => {
    const sample = [
      "if (slug === 'codex') {}",
      'if ("claude" !== agent) {}',
      "switch (a) { case 'agy': break; }",
      "const ok = agent == 'opencode';",
      "const label = 'claude';",
      "if (slug === 'claudex') {}",
    ].join('\n');
    expect(sample.match(BRANCH_RE)).toHaveLength(4);
  });

  it('adds no slug branch outside the snapshot', () => {
    const allowed = readAllowlist();
    const grown = Object.entries(counts)
      .filter(([file, n]) => n > (allowed[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} branches (snapshot allows ${allowed[file] ?? 0})`);
    expect(grown, [
      'New per-agent `slug === \'<literal>\'` / `case \'<slug>\':` branches. Declare the capability on the',
      'agent\'s row in src/shared/agentIdentity.ts and read the field instead; see the header of',
      'src/shared/__tests__/agentSlugBranches.guard.test.ts if the branch is genuinely right.',
    ].join(' ')).toEqual([]);
  });
});
