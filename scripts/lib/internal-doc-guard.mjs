/**
 * Repository policy gate: internal-only documents must never become tracked
 * files in this public repository.
 *
 * The audit lives here (not in the `#!` CLI wrapper) so vitest can import it —
 * a module with a shebang cannot be imported under vitest.
 *
 * ## What this guards, and why it is shaped this way
 *
 * `plans/` holds working notes that are deliberately not published. Encoding
 * that in a `.gitignore` entry alone is weak: it is one line, in a file that
 * changes for unrelated reasons, and editing it silently widens what the
 * repository will accept. A check that reads `.gitignore` for its verdict
 * inherits the same weakness — it agrees with whatever the file currently says.
 *
 * So the gate below asserts three things independently of `.gitignore`:
 *
 *  1. `plans/` must stay ignored          — catches the entry being weakened
 *  2. no tracked file may live in `plans/` — catches the result, even if (1) is edited
 *  3. high-signal filenames are blocked    — catches the same note moved elsewhere
 *
 * ## Why there is no content heuristic
 *
 * Scanning prose for "competitor name + strategy vocabulary" was measured
 * against the tracked tree and is not precise enough to block a commit:
 * `kpi` matches inside "co-c-kpi-t" (README's Fleet View **cockpit**), and
 * `moat` appears in README/CHANGELOG describing the A2A moat — all three are
 * intentionally public. A gate that cries wolf on README.md gets bypassed with
 * `--no-verify` within a week, which is worse than no gate. Precision beats
 * recall for a blocking check; recall is covered by rules 1-3 above.
 *
 * ## Bypass
 *
 * `git commit --no-verify` always skips local hooks — git offers no way to
 * prevent that, and pretending otherwise would be false assurance. That is why
 * the same audit also runs as a vitest case (`scripts/__tests__/`), which lands
 * in CI through `npm test`: a local bypass still fails the pull request.
 */

/**
 * Paths whose entire subtree is internal-only. Kept as a prefix list rather
 * than a `.gitignore` read so editing `.gitignore` cannot widen it.
 */
export const INTERNAL_PATH_PREFIXES = ['plans/'];

/**
 * `.gitignore` entries this repository's document policy depends on. Stored
 * verbatim: the check is "is this exact line still present", not a re-implementation
 * of git's matching rules.
 */
export const REQUIRED_GITIGNORE_ENTRIES = ['plans/'];

/**
 * Filename tokens that mark a document as internal wherever it is written.
 * Matched against the basename with its extension removed, so
 * `docs/2026-07-28-strategy.md` trips on `strategy` while `src/roadmapView.tsx`
 * does not (the token must be delimited, not embedded).
 */
export const INTERNAL_NAME_TOKENS = [
  'strategy',
  'strategies',
  'roadmap',
  'competitive',
  'competitor',
  'as-is-to-be',
  'master-plan',
];

const INTERNAL_NAME_RE = new RegExp(
  `(?:^|[^a-z])(${INTERNAL_NAME_TOKENS.join('|')})(?:[^a-z]|$)`,
  'i',
);

/**
 * Tracked files that match a rule above but are published on purpose.
 *
 * Adding an entry is a policy decision, not a formality: it says "this document
 * is written for the public". Keep the reason with it — a bare path list decays
 * into a place where violations go to be forgotten.
 */
export const INTERNAL_DOC_ALLOWLIST = new Map([
  [
    'docs/mcp-2026-07-28-strategy.md',
    'Published MCP integration guidance for third-party agent authors — technical, contains no positioning or competitive material.',
  ],
]);

/** Strip the directory and the final extension: `a/b/c-strategy.md` -> `c-strategy`. */
function basenameWithoutExtension(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Classify one repo-relative path.
 *
 * @returns {{path: string, rule: 'internal-path'|'internal-name', detail: string} | null}
 */
export function classifyPath(path) {
  const normalized = path.replace(/\\/g, '/');
  if (INTERNAL_DOC_ALLOWLIST.has(normalized)) return null;

  const prefix = INTERNAL_PATH_PREFIXES.find((p) => normalized.startsWith(p));
  if (prefix) {
    return {
      path: normalized,
      rule: 'internal-path',
      detail: `\`${prefix}\` holds internal-only documents and must never be tracked in this public repository.`,
    };
  }

  const token = INTERNAL_NAME_RE.exec(basenameWithoutExtension(normalized));
  if (token) {
    return {
      path: normalized,
      rule: 'internal-name',
      detail: `Filename carries the internal-document marker "${token[1]}". Write it under plans/ (ignored), or allowlist it in scripts/lib/internal-doc-guard.mjs with the reason it is public.`,
    };
  }

  return null;
}

/**
 * Classify a batch of repo-relative paths.
 *
 * @param {Iterable<string>} paths
 * @returns {Array<{path: string, rule: string, detail: string}>}
 */
export function checkPaths(paths) {
  const violations = [];
  for (const path of paths) {
    if (!path) continue;
    const violation = classifyPath(path);
    if (violation) violations.push(violation);
  }
  return violations;
}

/**
 * Verify the `.gitignore` entries the policy leans on are still present.
 *
 * A removed entry is reported on its own, before any file has been committed
 * through the hole — the same problem caught one step earlier.
 *
 * @param {string} gitignoreText
 * @returns {Array<{rule: 'gitignore-weakened', entry: string, detail: string}>}
 */
export function checkGitignore(gitignoreText) {
  const lines = gitignoreText.split(/\r?\n/).map((line) => line.trim());
  const violations = [];
  for (const entry of REQUIRED_GITIGNORE_ENTRIES) {
    // A later `!plans/...` negation would re-admit the very files the entry
    // exists to keep out, so an un-negated presence is what "still ignored" means.
    const present = lines.includes(entry);
    const negated = lines.some((line) => line.startsWith(`!${entry}`));
    if (!present || negated) {
      violations.push({
        rule: 'gitignore-weakened',
        entry,
        detail: negated
          ? `.gitignore negates \`${entry}\`, re-admitting internal documents.`
          : `.gitignore no longer ignores \`${entry}\`, which is what this repository's document policy relies on — restore the entry rather than removing this check.`,
      });
    }
  }
  return violations;
}
