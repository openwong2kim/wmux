/**
 * Resolve the production dependency closure from package-lock.json.
 *
 * Why the lockfile and not `npm ls --prod --all --json`:
 *
 *   1. Determinism across platforms. `npm ls` reports what is *installed*,
 *      and optional deps constrained by `os`/`cpu` differ per machine — on
 *      macOS the tree carries @anthropic-ai/claude-agent-sdk-darwin-arm64,
 *      on the Windows CI runner it carries -win32-x64 instead. Anything
 *      byte-comparing generated output (THIRD_PARTY_NOTICES) would then be
 *      permanently stale on one platform or the other.
 *   2. Completeness. We ship installers for macOS, Windows and Linux from a
 *      single lockfile, so *every* platform variant ends up in some release
 *      artifact and every one of them needs attribution — not just the one
 *      that happens to be installed on the machine running the generator.
 *   3. Exact resolution. A lockfile path (`node_modules/a/node_modules/b`)
 *      names the on-disk directory for that specific version, so packages
 *      present at two versions (debug@2 and debug@4) each get their own
 *      LICENSE instead of both collapsing onto the hoisted copy.
 *
 * Consumers: scripts/generate-notices.mjs and scripts/check-licenses.mjs.
 * Both must see the same package set, or the notices file would document a
 * different closure than the one the license policy actually gates.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Walk up the node_modules nesting chain the way node's resolver does:
 * `node_modules/a/node_modules/b` looks in its own node_modules first, then
 * its parent's, then the root.
 */
function resolveFrom(lockPackages, fromPath, name) {
  let prefix = fromPath;
  for (;;) {
    const candidate = prefix ? `${prefix}/node_modules/${name}` : `node_modules/${name}`;
    if (lockPackages[candidate]) return candidate;
    if (!prefix) return null;
    const cut = prefix.lastIndexOf('/node_modules/');
    prefix = cut === -1 ? '' : prefix.slice(0, cut);
  }
}

/**
 * Every edge that pulls code into the shipping bundle: runtime deps,
 * optional deps (platform binaries), and non-optional peer deps (npm 7+
 * installs those). Optional peers are skipped — npm does not install them
 * and they are absent from the lockfile.
 */
function outgoingEdges(entry) {
  const names = new Set([
    ...Object.keys(entry.dependencies || {}),
    ...Object.keys(entry.optionalDependencies || {}),
  ]);
  for (const name of Object.keys(entry.peerDependencies || {})) {
    if (entry.peerDependenciesMeta?.[name]?.optional) continue;
    names.add(name);
  }
  return names;
}

/**
 * @param {object} opts
 * @param {string} opts.root Repo root (contains package-lock.json + node_modules).
 * @param {string[]} [opts.alwaysInclude] Packages to force into the closure even
 *   when the lockfile marks them dev-only. Electron Forge convention puts
 *   `electron` in devDependencies even though the Electron runtime binary
 *   itself ships inside the application.
 * @returns {{packages: Array<{name: string, version: string, lockPath: string,
 *   dir: string|null, declaredLicense: string|null, platformConstrained: boolean}>,
 *   unresolved: string[]}}
 */
export function readProdClosure({ root, alwaysInclude = [] }) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const lockPackages = lock.packages;
  if (!lockPackages || !lockPackages['']) {
    throw new Error('package-lock.json has no `packages` map — lockfileVersion 2+ is required.');
  }

  const foundPaths = new Map(); // lockPath -> name
  const unresolved = [];
  const queue = [...outgoingEdges(lockPackages[''])].map((name) => ['', name]);

  while (queue.length) {
    const [fromPath, name] = queue.shift();
    // @types/* are TypeScript declarations — build-time only, no runtime code
    // ships. Not traversed either, so their own deps (e.g. csstype via
    // @types/react) stay out of the closure too.
    if (name.startsWith('@types/')) continue;
    const lockPath = resolveFrom(lockPackages, fromPath, name);
    if (!lockPath) {
      unresolved.push(`${name} (required by ${fromPath || '<root>'})`);
      continue;
    }
    if (foundPaths.has(lockPath)) continue;
    foundPaths.set(lockPath, name);
    for (const next of outgoingEdges(lockPackages[lockPath])) queue.push([lockPath, next]);
  }

  for (const name of alwaysInclude) {
    const lockPath = `node_modules/${name}`;
    if (lockPackages[lockPath]) foundPaths.set(lockPath, name);
  }

  // Collapse duplicate installs of the same name@version (a package hoisted to
  // the root and also nested under a peer-conflicting parent) into one entry.
  const byIdentity = new Map();
  for (const [lockPath, name] of foundPaths) {
    const entry = lockPackages[lockPath];
    if (!entry?.version) continue;
    const identity = `${name}@${entry.version}`;
    if (byIdentity.has(identity)) continue;
    const dir = join(root, lockPath);
    byIdentity.set(identity, {
      name,
      version: entry.version,
      lockPath,
      dir: existsSync(join(dir, 'package.json')) ? dir : null,
      declaredLicense: typeof entry.license === 'string' ? entry.license : null,
      // `os`/`cpu` constrained packages cannot all be installed at once, so
      // anything read from their on-disk copy would vary by platform.
      platformConstrained: Boolean(entry.os || entry.cpu),
    });
  }

  const packages = [...byIdentity.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );

  return { packages, unresolved: unresolved.sort() };
}
