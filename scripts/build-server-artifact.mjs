// Build the `wmux-server` artifact: a self-contained headless wmux (daemon +
// CLI + `wmux web`) that "Add PC over SSH" installs under
// `~/.wmux/runtime/<ver>/` on a Linux host, with no sudo and no system Node.
//
//   node scripts/build-server-artifact.mjs build [--arch x64|arm64] [--out out/server] [--max-glibc 2.28]
//   node scripts/build-server-artifact.mjs fetch-node --arch x64|arm64 --cache <dir>
//   node scripts/build-server-artifact.mjs manifest --in out/server --out dist/server-manifest.json
//
// `build` runs on a Linux machine of the target arch (node-pty is native, so it
// is never cross-built) after `npm ci`, `npm run build:cli` and
// `npm run build:daemon`. Releases run it inside an old-glibc image through
// scripts/build-server-artifact-container.sh, which uses `fetch-node` to hand
// the container the pinned Node. It writes, into --out:
//   wmux-server-<ver>-linux-<arch>.tar.gz          the artifact
//   wmux-server-<ver>-linux-<arch>.tar.gz.sha256   `sha256sum -c` format
//   wmux-server-<ver>-linux-<arch>.json            fragment for `manifest`
//
// The tarball holds one top-level directory, `<ver>/`, laid out like the
// packaged app's resources so the CLI's relative lookups resolve unchanged
// (src/shared/sshPcContract.ts):
//   <ver>/node/bin/node                       pinned official Node, sha256-checked
//   <ver>/package.json                        real version → spawnedByVersion
//   <ver>/resources/cli-bundle/               dist/cli-bundle
//   <ver>/resources/daemon-bundle/            dist/daemon-bundle
//   <ver>/resources/daemon-bundle/node_modules/node-pty/   built on this host
//   <ver>/resources/daemon-web/               dist/daemon-web (web terminal UI)
//   <ver>/resources/wmux-native/              dist/wmux-native (Rust terminal core),
//                                             built on this host by `npm run build:terminal-core`
// The daemon finds the native terminal core at `<daemon-bundle>/../wmux-native`
// (src/shared/nativeTerminalCore.ts). It uses it only when the host picks the
// rust engine; node stays the default.
//
// `manifest` merges the per-arch fragments into the ServerArtifactManifest the
// desktop app ships as resources/server-manifest.json (release.yml runs it
// before `npm run make`).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { verifyIntegrity } = createRequire(import.meta.url)('./verify-native-terminal-package.cjs');

/** Bundled Node. Bump the version and both hashes together, from the
 * release's SHASUMS256.txt. The hashes are pinned here rather than read from
 * nodejs.org at build time, so a tampered mirror cannot vouch for itself. */
export const NODE_VERSION = '24.21.0';
const NODE_SHA256 = {
  x64: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  arm64: '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
};
/** The official Node 24 Linux binaries need glibc 2.28; nothing we add can
 * lower that, only raise it. */
const NODE_GLIBC_FLOOR = '2.28';

const ARCHES = ['x64', 'arm64'];

export function serverArtifactName(version, arch) {
  return `wmux-server-${version}-linux-${arch}.tar.gz`;
}

/** Numeric compare of dotted versions ("2.28" < "2.34"). */
export function compareGlibc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Highest `GLIBC_x.y[.z]` version a dynamically linked ELF asks for, or null.
 * The version-needed names live in .dynstr as plain strings, so a byte scan
 * finds them without binutils on the build host. */
export function maxGlibcRequirement(buf) {
  let max = null;
  for (const m of buf.toString('latin1').matchAll(/GLIBC_(\d+\.\d+(?:\.\d+)?)/g)) {
    if (!max || compareGlibc(m[1], max) > 0) max = m[1];
  }
  return max;
}

/** Merge per-arch fragments into a ServerArtifactManifest. */
export function mergeFragments(fragments, { version, requireArches = ARCHES } = {}) {
  if (fragments.length === 0) throw new Error('no server artifact fragments found');
  const manifest = { version: fragments[0].version, node: fragments[0].node, glibcMin: NODE_GLIBC_FLOOR, artifacts: {} };
  for (const f of fragments) {
    if (!ARCHES.includes(f.arch)) throw new Error(`unknown arch in fragment: ${f.arch}`);
    if (f.version !== manifest.version) throw new Error(`fragments disagree on version: ${f.version} vs ${manifest.version}`);
    if (f.node !== manifest.node) throw new Error(`fragments disagree on Node: ${f.node} vs ${manifest.node}`);
    if (manifest.artifacts[f.arch]) throw new Error(`two fragments for ${f.arch}`);
    if (f.name !== serverArtifactName(f.version, f.arch)) throw new Error(`unexpected artifact name ${f.name}`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`bad sha256 for ${f.arch}`);
    if (!Number.isSafeInteger(f.size) || f.size <= 0) throw new Error(`bad size for ${f.arch}`);
    if (compareGlibc(f.glibcMin, manifest.glibcMin) > 0) manifest.glibcMin = f.glibcMin;
    manifest.artifacts[f.arch] = { name: f.name, sha256: f.sha256, size: f.size };
  }
  if (version && manifest.version !== version) {
    throw new Error(`artifacts are ${manifest.version} but package.json is ${version}`);
  }
  for (const arch of requireArches) {
    if (!manifest.artifacts[arch]) throw new Error(`missing server artifact for ${arch}`);
  }
  return manifest;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m || i + 1 >= argv.length) throw new Error(`unexpected argument: ${argv[i]}`);
    opts[m[1]] = argv[++i];
  }
  return opts;
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireFile(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`${path.relative(repoRoot, file)} is missing — ${hint}`);
}

async function fetchNode(arch, cacheDir) {
  const name = `node-v${NODE_VERSION}-linux-${arch}.tar.gz`;
  const file = path.join(cacheDir, name);
  if (!fs.existsSync(file) || sha256File(file) !== NODE_SHA256[arch]) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}`;
    console.log(`[server-artifact] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const actual = sha256File(file);
  if (actual !== NODE_SHA256[arch]) {
    throw new Error(`${name} hashes to ${actual}, pinned ${NODE_SHA256[arch]} — refusing to ship it`);
  }
  return file;
}

/** node-pty's runtime files only: the JS, its package.json and the native
 * build output. Sources, deps, prebuilds for other platforms and tests stay out. */
function stageNodePty(dest) {
  const src = path.join(repoRoot, 'node_modules', 'node-pty');
  const release = path.join(src, 'build', 'Release');
  requireFile(path.join(release, 'pty.node'), 'run `npm ci` on this Linux host so node-pty builds natively');
  fs.mkdirSync(path.join(dest, 'build', 'Release'), { recursive: true });
  fs.copyFileSync(path.join(src, 'package.json'), path.join(dest, 'package.json'));
  fs.copyFileSync(path.join(src, 'LICENSE'), path.join(dest, 'LICENSE'));
  fs.cpSync(path.join(src, 'lib'), path.join(dest, 'lib'), {
    recursive: true,
    filter: (p) => !/\.test\.js(\.map)?$/.test(p),
  });
  for (const entry of fs.readdirSync(release)) {
    if (entry === 'pty.node' || entry === 'spawn-helper') {
      const out = path.join(dest, 'build', 'Release', entry);
      fs.copyFileSync(path.join(release, entry), out);
      // npm ci can drop the exec bit; a dlopen'd .node and an exec'd helper both need it.
      fs.chmodSync(out, 0o755);
    }
  }
}

/** The native terminal core as `npm run build:terminal-core` staged it for
 * the desktop package: only the files its manifest describes, so a binary an
 * earlier build for another target left in the stage stays out. Checked
 * before and after the copy. */
export function stageNativeCore(src, dest, arch) {
  requireFile(path.join(src, 'manifest.json'), 'run `npm run build:terminal-core` on this Linux host first');
  verifyIntegrity(src, 'linux', arch);
  const { binary } = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['manifest.json', 'index.cjs', 'THIRD_PARTY_NOTICES', binary]) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
  verifyIntegrity(dest, 'linux', arch);
}

/** Run the staged Node against the staged node-pty and open a real PTY, then
 * run the native terminal core's package smoke on the same Node. Catches an
 * ABI or glibc mismatch here instead of on a user's host. */
function smokeStaged(root) {
  const node = path.join(root, 'node', 'bin', 'node');
  const pty = path.join(root, 'resources', 'daemon-bundle', 'node_modules', 'node-pty');
  const probe = `
    const pty = require(${JSON.stringify(pty)});
    if (process.version !== 'v${NODE_VERSION}') throw new Error('node ' + process.version);
    const p = pty.spawn('/bin/sh', ['-c', 'echo PTY_$((6*7))'], { cols: 80, rows: 24 });
    let out = '';
    p.onData((d) => { out += d; });
    p.onExit(() => { if (!out.includes('PTY_42')) { console.error(JSON.stringify(out)); process.exit(1); } console.log('pty ok'); });
  `;
  execFileSync(node, ['-e', probe], { stdio: 'inherit', env: { PATH: '/usr/bin:/bin' }, timeout: 30_000 });
  execFileSync(node, [path.join(repoRoot, 'scripts', 'verify-native-terminal-package.cjs'), path.join(root, 'resources'), '--node'], {
    stdio: 'inherit', env: { PATH: '/usr/bin:/bin' }, timeout: 30_000,
  });
}

async function build(opts) {
  const arch = opts.arch ?? process.arch;
  if (!ARCHES.includes(arch)) throw new Error(`--arch must be one of ${ARCHES.join(', ')}`);
  if (process.platform !== 'linux' || process.arch !== arch) {
    throw new Error(`build on a linux-${arch} host: node-pty is native and is never cross-built (this is ${process.platform}-${process.arch})`);
  }
  const version = packageVersion();
  const outDir = path.resolve(opts.out ?? path.join(repoRoot, 'out', 'server'));
  const dist = path.join(repoRoot, 'dist');
  requireFile(path.join(dist, 'cli-bundle', 'index.js'), 'run `npm run build:cli` first');
  requireFile(path.join(dist, 'daemon-bundle', 'index.js'), 'run `npm run build:daemon` first');
  requireFile(path.join(dist, 'daemon-web', 'terminal.html'), 'run `npm run build:daemon` first');

  const nodeTarball = await fetchNode(arch, opts.cache ?? path.join(os.tmpdir(), 'wmux-server-node'));

  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-server-stage-'));
  try {
    const root = path.join(stageParent, version);
    const nodeDir = path.join(root, 'node');
    fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true });
    const top = `node-v${NODE_VERSION}-linux-${arch}`;
    execFileSync('tar', ['-xzf', nodeTarball, '-C', nodeDir, '--strip-components=1', `${top}/bin/node`, `${top}/LICENSE`]);
    fs.chmodSync(path.join(nodeDir, 'bin', 'node'), 0o755);

    // Minimal on purpose: the daemon reads only `version` from it, and the
    // repo's package.json would drag scripts and dependency lists along.
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'wmux-server', version, private: true, license: 'MIT' }, null, 2)}\n`,
    );
    fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(root, 'LICENSE'));
    fs.copyFileSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES'), path.join(root, 'THIRD_PARTY_NOTICES'));

    const resources = path.join(root, 'resources');
    for (const dir of ['cli-bundle', 'daemon-bundle', 'daemon-web']) {
      fs.cpSync(path.join(dist, dir), path.join(resources, dir), { recursive: true });
    }
    stageNodePty(path.join(resources, 'daemon-bundle', 'node_modules', 'node-pty'));
    stageNativeCore(path.join(dist, 'wmux-native'), path.join(resources, 'wmux-native'), arch);

    // Every ELF file in the artifact (addons, helpers it execs), so a future
    // native file cannot slip past.
    let glibcMin = NODE_GLIBC_FLOOR;
    const isElf = (file) => {
      if (!fs.statSync(file).isFile()) return false;
      const fd = fs.openSync(file, 'r');
      try {
        const head = Buffer.alloc(4);
        return fs.readSync(fd, head, 0, 4, 0) === 4 && head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      } finally {
        fs.closeSync(fd);
      }
    };
    const elves = [
      path.join(nodeDir, 'bin', 'node'),
      ...fs.readdirSync(resources, { recursive: true }).map((f) => path.join(resources, f)).filter(isElf),
    ];
    for (const file of elves) {
      const buf = fs.readFileSync(file);
      if (buf.includes('ld-musl')) throw new Error(`${path.basename(file)} links against musl; the artifact is glibc-only`);
      const need = maxGlibcRequirement(buf);
      if (need && compareGlibc(need, glibcMin) > 0) glibcMin = need;
    }
    if (opts['max-glibc'] && compareGlibc(glibcMin, opts['max-glibc']) > 0) {
      throw new Error(`the artifact needs glibc ${glibcMin}, above the allowed ${opts['max-glibc']}; build it in an older image`);
    }

    smokeStaged(root);

    fs.mkdirSync(outDir, { recursive: true });
    const name = serverArtifactName(version, arch);
    const tarball = path.join(outDir, name);
    const mtime = process.env.SOURCE_DATE_EPOCH ? [`--mtime=@${process.env.SOURCE_DATE_EPOCH}`] : [];
    execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', ...mtime, '-czf', tarball, '-C', stageParent, version]);

    const sha256 = sha256File(tarball);
    const size = fs.statSync(tarball).size;
    fs.writeFileSync(`${tarball}.sha256`, `${sha256}  ${name}\n`);
    const fragment = { version, arch, node: NODE_VERSION, glibcMin, name, sha256, size };
    fs.writeFileSync(path.join(outDir, name.replace(/\.tar\.gz$/, '.json')), `${JSON.stringify(fragment, null, 2)}\n`);
    console.log(`[server-artifact] ${name} sha256=${sha256} size=${size} glibcMin=${glibcMin}`);
  } finally {
    fs.rmSync(stageParent, { recursive: true, force: true });
  }
}

function manifest(opts) {
  if (!opts.in || !opts.out) throw new Error('manifest needs --in <dir> and --out <file>');
  const fragments = fs
    .readdirSync(opts.in)
    .filter((f) => /^wmux-server-.+-linux-(x64|arm64)\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(opts.in, f), 'utf8')));
  const merged = mergeFragments(fragments, { version: packageVersion() });
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`[server-artifact] wrote ${opts.out}: ${JSON.stringify(merged)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    const opts = parseArgs(rest);
    if (mode === 'build') await build(opts);
    else if (mode === 'fetch-node') {
      if (!ARCHES.includes(opts.arch) || !opts.cache) throw new Error('fetch-node needs --arch x64|arm64 and --cache <dir>');
      console.log(await fetchNode(opts.arch, path.resolve(opts.cache)));
    }
    else if (mode === 'manifest') manifest(opts);
    else throw new Error('usage: build-server-artifact.mjs build|fetch-node|manifest [options]');
  } catch (err) {
    console.error(`[server-artifact] ${err.message}`);
    process.exit(1);
  }
}
