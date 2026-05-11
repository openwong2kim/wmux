#!/usr/bin/env node
/**
 * Regenerate THIRD_PARTY_NOTICES from production dependencies.
 *
 * Walks `npm ls --prod --all --json` to enumerate every package that ends up
 * in the runtime bundle (direct deps + their transitive prod deps), then
 * reads each package's manifest + LICENSE file from node_modules.
 *
 * Run via `npm run notices` after dependency changes.
 *
 * Intentionally zero external deps — we use `npm ls` JSON output + node:fs
 * so this script is self-contained and works in CI without extra installs.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NOTICES_PATH = join(ROOT, 'THIRD_PARTY_NOTICES');

// --- Step 1: enumerate every production package (direct + transitive). ----------

console.error('[notices] resolving production dep tree via npm ls…');
let lsJson;
try {
  lsJson = execSync('npm ls --prod --all --json --long=false', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  // `npm ls` exits non-zero on missing/peer warnings but still writes JSON.
  if (err.stdout) lsJson = err.stdout.toString();
  else throw err;
}
const tree = JSON.parse(lsJson);

const seen = new Map(); // key = name@version -> { name, version, path }
const skipped = []; // extraneous / dev / type-only — recorded for the log
function walk(node) {
  if (!node?.dependencies) return;
  for (const [name, info] of Object.entries(node.dependencies)) {
    if (!info?.version) continue;
    // Skip packages npm flagged as extraneous (orphan modules in node_modules
    // not actually depended on by anything in package.json). They're not part
    // of the shipping bundle, so they don't require attribution here.
    if (info.extraneous === true) {
      skipped.push(`${name}@${info.version} (extraneous)`);
      continue;
    }
    // Skip @types/* — TypeScript type definitions are build-time only; their
    // code never reaches the runtime bundle.
    if (name.startsWith('@types/')) {
      skipped.push(`${name}@${info.version} (@types/* — build-time only)`);
      continue;
    }
    const key = `${name}@${info.version}`;
    if (!seen.has(key)) {
      seen.set(key, { name, version: info.version });
    }
    walk(info);
  }
}
walk(tree);

// Electron Forge convention puts `electron` in devDependencies even though
// the Electron runtime binary itself ships with the application. Add it
// (and its hoisted node_modules version) explicitly so the Electron LICENSE
// makes it into the notices file.
const ALWAYS_INCLUDE = ['electron'];
for (const name of ALWAYS_INCLUDE) {
  const dir = join(ROOT, 'node_modules', name);
  if (existsSync(join(dir, 'package.json'))) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const key = `${name}@${manifest.version}`;
    if (!seen.has(key)) {
      seen.set(key, { name, version: manifest.version });
    }
  }
}

console.error(`[notices] found ${seen.size} unique production packages.`);
if (skipped.length) {
  console.error(`[notices] skipped ${skipped.length} entries:`);
  for (const s of skipped) console.error(`  - ${s}`);
}

// --- Step 2: resolve each package's on-disk path + read manifest + LICENSE. -----

// npm hoists deps into root node_modules under most layouts. If a package is
// nested (peer conflict, dual versions), fall back to walking the tree.
function findPackageDir(name) {
  // Root hoist
  const rootDir = join(ROOT, 'node_modules', name);
  if (existsSync(join(rootDir, 'package.json'))) return rootDir;
  // Nested search — depth-bounded; node_modules can be deeply nested on Windows.
  const queue = [join(ROOT, 'node_modules')];
  let budget = 5000;
  while (queue.length && budget-- > 0) {
    const dir = queue.shift();
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const sub = join(dir, entry);
        try {
          if (!statSync(sub).isDirectory()) continue;
        } catch {
          continue;
        }
        if (entry.startsWith('@')) {
          // Scoped — descend one more level
          queue.push(sub);
          continue;
        }
        const candidate = join(sub, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) return candidate;
        // Also queue this package's own node_modules for further descent
        const ownNm = join(sub, 'node_modules');
        if (existsSync(ownNm)) queue.push(ownNm);
      }
    } catch {
      continue;
    }
  }
  return null;
}

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
  // Prefer plain LICENSE / LICENSE.md / LICENSE.txt in that order
  const priority = ['license', 'license.md', 'license.txt'];
  candidates.sort((a, b) => {
    const ai = priority.indexOf(a.toLowerCase());
    const bi = priority.indexOf(b.toLowerCase());
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  try {
    return readFileSync(join(pkgDir, candidates[0]), 'utf8').trim();
  } catch {
    return null;
  }
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

const packages = [];
const missing = [];
for (const { name, version } of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const pkgDir = findPackageDir(name);
  if (!pkgDir) {
    missing.push(`${name}@${version}`);
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
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
      'UNKNOWN',
    author: normalizeAuthor(manifest.author),
    repository: normalizeRepository(manifest.repository),
    homepage: manifest.homepage || null,
    licenseText: readLicenseText(pkgDir),
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
lines.push(`Generated from package.json production dependencies (transitive included).`);
lines.push(`Last regenerated: ${new Date().toISOString().slice(0, 10)}`);
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
  lines.push('');
  lines.push(SEP);
  lines.push('');
}

writeFileSync(NOTICES_PATH, lines.join('\n'));
console.error(`[notices] wrote ${NOTICES_PATH} (${packages.length} packages, ${missing.length} missing).`);
