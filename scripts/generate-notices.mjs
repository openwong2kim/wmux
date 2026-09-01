#!/usr/bin/env node
/**
 * Regenerate THIRD_PARTY_NOTICES from production dependencies.
 *
 * Resolves the production closure from package-lock.json (see
 * scripts/lib/prod-dependency-closure.mjs for why the lockfile rather than
 * `npm ls`), then reads each package's manifest + LICENSE +
 * NOTICE/ThirdPartyNotices files from node_modules. NOTICE preservation is
 * required by Apache 2.0 §4(d) for any package whose distribution includes
 * one (e.g. playwright-core carries a Puppeteer-derivation NOTICE that we
 * must propagate).
 *
 * Usage:
 *   node scripts/generate-notices.mjs                  # rewrite THIRD_PARTY_NOTICES
 *   node scripts/generate-notices.mjs --check          # exit 1 if the file is stale
 *   node scripts/generate-notices.mjs --stdout-digest  # sha256 of what it would write
 *
 * The output is a pure function of package-lock.json plus the LICENSE/NOTICE
 * files on disk — no wall-clock timestamp, no platform-dependent package set
 * — so --check is a usable CI gate. scripts/__tests__/generateNotices.test.mjs
 * runs it with the rest of the suite.
 *
 * Run via `npm run notices` after dependency changes.
 *
 * Intentionally zero external deps — package-lock.json + node:fs only — so
 * this script is self-contained and works in CI without extra installs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProdClosure } from './lib/prod-dependency-closure.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NOTICES_PATH = join(ROOT, 'THIRD_PARTY_NOTICES');
const CHECK_ONLY = process.argv.slice(2).includes('--check');
// Lets the drift-guard test assert that two runs produce the same bytes without
// writing the file twice. Determinism is the load-bearing property here: if it
// regresses, --check flaps and a flaky guard gets deleted rather than fixed.
const DIGEST_ONLY = process.argv.slice(2).includes('--stdout-digest');

// Vendored LICENSE/NOTICE files ship with mixed line endings (several are CRLF).
// Emitting them verbatim would bake CRLF into an otherwise-LF file and break the
// --check compare, which has to normalize the checkout side (core.autocrlf=true
// on Windows). Normalize on the way in so the generated file is pure LF.
const lf = (text) => text.replace(/\r\n/g, '\n');

// --- Step 1: enumerate every production package (direct + transitive). ----------

// Electron Forge convention puts `electron` in devDependencies even though
// the Electron runtime binary itself ships with the application, so it is
// forced into the closure and gets its LICENSE into the notices file.
const { packages: closure, unresolved } = readProdClosure({ root: ROOT, alwaysInclude: ['electron'] });

console.error(`[notices] ${closure.length} unique production packages in the lockfile closure.`);
if (unresolved.length) {
  console.error(`[notices] WARN: ${unresolved.length} dependency edges did not resolve in the lockfile:`);
  for (const u of unresolved) console.error(`  - ${u}`);
}

// --- Step 2: read each package's manifest + LICENSE from its lockfile path. -----

function readLicenseText(pkgDir) {
  const candidates = readdirSync(pkgDir).filter((f) => {
    const lower = f.toLowerCase();
    return (
      lower === 'license' ||
      lower === 'license.md' ||
      lower === 'license.txt' ||
      lower === 'license-mit' ||
      lower === 'license-mit.txt' ||
      lower === 'copying' ||
      lower === 'copying.txt' ||
      lower === 'unlicense' ||
      lower.startsWith('license.')
    );
  });
  if (candidates.length === 0) return null;
  // Prefer plain LICENSE / LICENSE.md / LICENSE.txt in that order. The name
  // tiebreak matters: readdirSync order is filesystem-dependent, so without it
  // a package shipping both COPYING and LICENSE-MIT could pick a different file
  // per machine and make the --check drift guard flap.
  const priority = ['license', 'license.md', 'license.txt'];
  candidates.sort((a, b) => {
    const ai = priority.indexOf(a.toLowerCase());
    const bi = priority.indexOf(b.toLowerCase());
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b);
  });
  try {
    return lf(readFileSync(join(pkgDir, candidates[0]), 'utf8')).trim();
  } catch {
    return null;
  }
}

// Apache 2.0 4(d) requires that NOTICE files shipped with a package be
// preserved in derivative-work distributions. We pull both:
//   - NOTICE / NOTICE.txt / NOTICE.md — the canonical Apache attribution file
//   - ThirdPartyNotices.txt / THIRD_PARTY_NOTICES (case-insensitive) — common
//     in Microsoft-authored packages (e.g. playwright-core) where vendored
//     sub-dependencies are not separate npm packages and therefore would not
//     appear in our own lockfile walk
// Both are returned concatenated when present; either may be null.
function readNoticeText(pkgDir) {
  let files;
  try {
    files = readdirSync(pkgDir);
  } catch {
    return null;
  }
  const noticeCandidates = files.filter((f) => {
    const lower = f.toLowerCase();
    return (
      lower === 'notice' ||
      lower === 'notice.txt' ||
      lower === 'notice.md' ||
      lower === 'thirdpartynotices.txt' ||
      lower === 'thirdpartynotices.md' ||
      lower === 'third_party_notices' ||
      lower === 'third_party_notices.txt' ||
      lower === 'third_party_notices.md'
    );
  });
  if (noticeCandidates.length === 0) return null;
  // Stable ordering: NOTICE first, ThirdPartyNotices second.
  noticeCandidates.sort((a, b) => {
    const aIsNotice = a.toLowerCase().startsWith('notice');
    const bIsNotice = b.toLowerCase().startsWith('notice');
    if (aIsNotice && !bIsNotice) return -1;
    if (!aIsNotice && bIsNotice) return 1;
    return a.localeCompare(b);
  });
  const parts = [];
  for (const f of noticeCandidates) {
    try {
      const body = lf(readFileSync(join(pkgDir, f), 'utf8')).trim();
      if (!body) continue;
      parts.push(`--- ${f} ---\n${body}`);
    } catch {
      // best-effort — skip unreadable
    }
  }
  return parts.length ? parts.join('\n\n') : null;
}

function normalizeAuthor(author) {
  if (!author) return null;
  if (typeof author === 'string') return author;
  if (typeof author === 'object') {
    const parts = [author.name, author.email && `<${author.email}>`, author.url && `(${author.url})`].filter(Boolean);
    return parts.join(' ') || null;
  }
  return null;
}

function normalizeRepository(repo) {
  if (!repo) return null;
  if (typeof repo === 'string') return repo;
  if (typeof repo === 'object' && repo.url) return repo.url.replace(/^git\+/, '').replace(/\.git$/, '');
  return null;
}

// A package whose lockfile entry carries `os`/`cpu` constraints exists on disk
// on exactly one platform, so reading anything from its installed copy would
// make this file differ between a macOS dev machine and the Windows CI runner.
// These entries are therefore rendered from lockfile metadata only, on every
// platform. Nothing is lost in practice: npm platform-binary siblings carry the
// same license as the parent package that declares them as optionalDependencies,
// and the parent IS installed everywhere, so its full text is emitted above.
const PLATFORM_VARIANT_NOTE =
  '(Platform-specific binary package. It is installed only on its target OS/CPU, so its\n' +
  'license text is not read from this checkout; the license identifier above is taken from\n' +
  'package-lock.json. The full terms are those of the parent package that declares this\n' +
  'package as an optional dependency — see that entry in this file.)';

const packages = [];
const missing = [];
for (const entry of closure) {
  const { name, version, dir, declaredLicense, platformConstrained } = entry;

  if (platformConstrained) {
    packages.push({
      name,
      version,
      license: declaredLicense || 'UNKNOWN',
      author: null,
      repository: null,
      homepage: null,
      licenseText: PLATFORM_VARIANT_NOTE,
      noticeText: null,
    });
    continue;
  }

  if (!dir) {
    missing.push(`${name}@${version} (expected at ${entry.lockPath})`);
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    missing.push(`${name}@${version} (manifest unreadable)`);
    continue;
  }
  packages.push({
    name,
    version,
    license:
      manifest.license ||
      (Array.isArray(manifest.licenses) ? manifest.licenses.map((l) => l.type || l).join(', ') : null) ||
      declaredLicense ||
      'UNKNOWN',
    author: normalizeAuthor(manifest.author),
    repository: normalizeRepository(manifest.repository),
    homepage: manifest.homepage || null,
    licenseText: readLicenseText(dir),
    noticeText: readNoticeText(dir),
  });
}

if (missing.length) {
  console.error(`[notices] WARN: ${missing.length} packages could not be located on disk:`);
  for (const m of missing) console.error(`  - ${m}`);
}

// --- Step 3: emit THIRD_PARTY_NOTICES ---------------------------------------------

const SEP = '='.repeat(80);
const lines = [];
lines.push('This file contains third-party notices for software bundled with wmux.');
lines.push('');
lines.push('wmux itself is distributed under the MIT License (see LICENSE).');
lines.push('The packages listed below are bundled with the wmux application or');
lines.push('its MCP server and retain their own license terms.');
lines.push('');
lines.push(`Generated from the package-lock.json production closure (transitive included,`);
lines.push(`every platform variant of platform-specific packages included).`);
// Deliberately no "last regenerated" date: this file is byte-compared against a
// fresh run by scripts/__tests__/generateNotices.test.mjs, and a wall-clock
// stamp would make that guard fail every day. Git history records when it moved.
lines.push(`Total packages: ${packages.length}`);
lines.push('');
lines.push('Regenerate with: `npm run notices`');
lines.push('');
lines.push(SEP);
lines.push('');

for (const p of packages) {
  lines.push(`${p.name}@${p.version}`);
  lines.push(`License: ${p.license}`);
  if (p.author) lines.push(`Author: ${p.author}`);
  if (p.repository) lines.push(`Repository: ${p.repository}`);
  else if (p.homepage) lines.push(`Homepage: ${p.homepage}`);
  lines.push('');
  if (p.licenseText) {
    lines.push(p.licenseText);
  } else {
    lines.push(`(No LICENSE file shipped with this package. See ${p.repository || p.homepage || 'package source'} for full terms.)`);
  }
  // Apache 2.0 §4(d): NOTICE files (and Microsoft-style ThirdPartyNotices)
  // must be preserved in derivative-work distributions. Emitted after the
  // LICENSE text so a single grep-able section per package stays intact.
  if (p.noticeText) {
    lines.push('');
    lines.push('--- ATTRIBUTION NOTICES (preserved per Apache 2.0 §4(d) or equivalent) ---');
    lines.push(p.noticeText);
  }
  lines.push('');
  lines.push(SEP);
  lines.push('');
}

// --- Step 4: emit bundled fonts ---------------------------------------------
// Fonts are shipped in the renderer via @font-face (see styles/globals.css),
// not as npm dependencies, so they are enumerated here from their committed
// LICENSE-*.txt files. This keeps the SIL Open Font License attribution in the
// notices across every regeneration. Keep in sync with the @font-face block.
const FONTS_DIR = join(ROOT, 'src/renderer/assets/fonts');
const BUNDLED_FONTS = [
  { name: 'Cascadia Code', file: 'LICENSE-CascadiaCode.txt', repo: 'https://github.com/microsoft/cascadia-code' },
  { name: 'JetBrains Mono', file: 'LICENSE-JetBrainsMono.txt', repo: 'https://github.com/JetBrains/JetBrainsMono' },
  { name: 'Fira Code', file: 'LICENSE-FiraCode.txt', repo: 'https://github.com/tonsky/FiraCode' },
  { name: 'JetBrainsMonoHangul', file: 'LICENSE-JetBrainsMonoHangul.txt', repo: 'https://github.com/Jhyub/JetBrainsMonoHangul' },
];
lines.push('BUNDLED FONTS');
lines.push('');
lines.push('The fonts below are bundled in the renderer via @font-face and are not');
lines.push('npm packages. Each is distributed under the SIL Open Font License 1.1;');
lines.push('the full license text (including the original copyright line) follows.');
lines.push('');
lines.push(SEP);
lines.push('');
let fontCount = 0;
for (const f of BUNDLED_FONTS) {
  lines.push(f.name);
  lines.push('License: SIL Open Font License 1.1');
  lines.push(`Repository: ${f.repo}`);
  lines.push('');
  const licPath = join(FONTS_DIR, f.file);
  if (existsSync(licPath)) {
    lines.push(lf(readFileSync(licPath, 'utf8')).trimEnd());
    fontCount++;
  } else {
    lines.push(`(LICENSE file ${f.file} not found — run after the font is committed.)`);
  }
  lines.push('');
  lines.push(SEP);
  lines.push('');
}

// --- Step 5: emit borrowed-technique attributions ---------------------------
// Projects whose CODE is not bundled, but whose implementation approach was
// reimplemented in wmux from reading their source. No npm dependency exists to
// enumerate, so the notice is listed here and the borrow sites carry a
// `mirrors <project> <file> <symbol>` comment.
const BORROWED_SOURCES = [
  {
    name: 'browser-use',
    license: 'MIT License',
    repo: 'https://github.com/browser-use/browser-use',
    copyright: 'Copyright (c) 2024 Gregor Zunic',
    what:
      'Browser-automation heuristics reimplemented in TypeScript: the nearest\n' +
      'file-input search around a clicked element, the scrollable-container\n' +
      'reporting rules, the page-readiness (empty / skeleton) statistics, and\n' +
      'the bounded iframe walk (depth and frame-count caps, visited-frame cycle\n' +
      'guard, rendered frames only) used by the snapshot frame graft.',
  },
  {
    name: 'Stagehand',
    license: 'MIT License',
    repo: 'https://github.com/browserbase/stagehand',
    copyright: 'Copyright (c) 2024 Browserbase, Inc.',
    what:
      'Chrome DevTools Protocol plumbing for cross-origin iframes,\n' +
      'reimplemented in TypeScript: the auto-attach / attach-to-target pattern\n' +
      'for out-of-process frame targets, and the frame-owning-session helper —\n' +
      'the idea that a frame is read over a CDP session bound to its own\n' +
      'target rather than through the page session. No selector-resolution or\n' +
      'XPath code was taken.\n' +
      '\n' +
      'Separately, three operating principles of its action cache were adopted\n' +
      'for browser_replay: best-effort (a cache miss or a mismatched page shape\n' +
      'may never break the underlying action), replay-fallback self-heal (a\n' +
      'replay that stops reports where and why and hands the live page back so\n' +
      'the flow can be finished and re-recorded), and variable placeholders (a\n' +
      'value that must vary is stored as a placeholder and substituted at\n' +
      'replay time, so secrets are never written). wmux keys its steps on the\n' +
      "snapshot's own role/name/index tuple rather than on Stagehand's XPath\n" +
      'axis, and again no code was taken.',
  },
  {
    name: 'Hermes Agent',
    license: 'MIT License',
    repo: 'https://github.com/NousResearch/hermes-agent',
    copyright: 'Copyright (c) 2024 Nous Research',
    what:
      'The lifecycle shape for promoted browser flows: usage counters kept\n' +
      'beside the artifact rather than inside the cache that produced it, and\n' +
      'an idle ladder that archives before it deletes so a forgotten entry is\n' +
      'recoverable rather than gone. wmux applies it to promoted browser_replay\n' +
      'flows with its own thresholds and its own file layout. No code was taken.',
  },
  {
    name: 'skill-forge',
    license: 'MIT License',
    repo: 'https://github.com/BrowserAct/skill-forge',
    copyright: 'Copyright (c) 2025 BrowserAct',
    what:
      'The document shape for a promoted browser flow: a short situational\n' +
      'contract line paired with a literal, runnable invocation, so the reader\n' +
      'can act on it without a further lookup. wmux emits this as a one-line\n' +
      'hint on navigation rather than as a file on disk, and derives every\n' +
      'field from its own records. No code or prose was taken.',
  },
];
lines.push('BORROWED IMPLEMENTATION TECHNIQUES');
lines.push('');
lines.push('No code from the projects below is bundled with wmux. Their approach was');
lines.push('reimplemented from the source named at each borrow site, and their license');
lines.push('terms are reproduced here.');
lines.push('');
lines.push(SEP);
lines.push('');
for (const b of BORROWED_SOURCES) {
  lines.push(b.name);
  lines.push(`License: ${b.license}`);
  lines.push(`Repository: ${b.repo}`);
  lines.push('');
  lines.push(b.copyright);
  lines.push('');
  lines.push(b.what);
  lines.push('');
  lines.push('Permission is hereby granted, free of charge, to any person obtaining a copy');
  lines.push('of this software and associated documentation files (the "Software"), to deal');
  lines.push('in the Software without restriction, including without limitation the rights');
  lines.push('to use, copy, modify, merge, publish, distribute, sublicense, and/or sell');
  lines.push('copies of the Software, and to permit persons to whom the Software is');
  lines.push('furnished to do so, subject to the following conditions:');
  lines.push('');
  lines.push('The above copyright notice and this permission notice shall be included in all');
  lines.push('copies or substantial portions of the Software.');
  lines.push('');
  lines.push('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR');
  lines.push('IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,');
  lines.push('FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE');
  lines.push('AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER');
  lines.push('LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,');
  lines.push('OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE');
  lines.push('SOFTWARE.');
  lines.push('');
  lines.push(SEP);
  lines.push('');
}

const rendered = lines.join('\n');

if (DIGEST_ONLY) {
  process.stdout.write(`${createHash('sha256').update(rendered, 'utf8').digest('hex')}\n`);
  process.exit(0);
}

if (CHECK_ONLY) {
  let current = null;
  try {
    // Normalize CRLF: with core.autocrlf=true the checkout is CRLF while the
    // generator emits LF — a byte-exact compare would always report stale.
    current = readFileSync(NOTICES_PATH, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    // missing file = stale
  }
  if (current === rendered) {
    console.log(`[notices] ${relative(ROOT, NOTICES_PATH)} is up to date (${packages.length} packages).`);
    process.exit(0);
  }
  console.error(
    `[notices] ${relative(ROOT, NOTICES_PATH)} is STALE — run \`npm run notices\` and commit the result.`,
  );
  process.exit(1);
}

writeFileSync(NOTICES_PATH, rendered);
console.error(`[notices] wrote ${NOTICES_PATH} (${packages.length} packages, ${fontCount} fonts, ${missing.length} missing).`);
