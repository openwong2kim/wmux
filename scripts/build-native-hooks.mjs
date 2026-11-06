// Build wmux-native (core/wmux-native) for the host and stage it as
// dist/native-hooks/, which forge.config.ts ships as resources/native-hooks/
// when present. Without a staged binary the package ships the Node bridge only
// and the hook installers keep writing `node <bridge>` entries.
//
//   node scripts/build-native-hooks.mjs
//
// The crate has no dependencies, so the stage holds the binary and a manifest
// naming the platform it was built for and a hash of the sources it was built
// from. forge refuses a stage for another platform, or from other sources than
// the checkout's.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/** The Rust target for each platform wmux packages. Linux links musl
 *  statically: a glibc build needs the build host's glibc or newer, and the
 *  app itself runs on older distributions than the CI image. */
export const NATIVE_HOOKS_TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

export function nativeHooksBinary(platform) {
  return platform === 'win32' ? 'wmux-native.exe' : 'wmux-native';
}

/** The marker main.rs prints with --version; the installer matches it in the bytes. */
export const NATIVE_HOOKS_MARKER = 'wmux-managed: native-hooks';

/**
 * A hash of everything the binary is built from: the crate's src/ tree, its
 * flavour table, Cargo.toml and Cargo.lock. Paths are hashed with the bytes,
 * so a moved or added file changes it too.
 */
export function nativeHooksSourceHash(root) {
  const crate = path.join(root, 'core', 'wmux-native');
  const files = ['flavours.json', 'Cargo.toml', 'Cargo.lock'];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(crate, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk('src');
  const hash = createHash('sha256');
  for (const rel of files.sort()) {
    hash.update(`${rel}\0`).update(fs.readFileSync(path.join(crate, ...rel.split('/')))).update('\0');
  }
  return hash.digest('hex');
}

/** Why `stageDir` must not be packaged from this checkout, or null when it may. */
export function nativeHooksStageProblem(root, stageDir) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(stageDir, 'manifest.json'), 'utf8'));
  } catch (error) {
    return `${stageDir} has no readable manifest (${error}); rerun node scripts/build-native-hooks.mjs`;
  }
  if (manifest.sourceHash !== nativeHooksSourceHash(root)) {
    return `${stageDir} was built from other sources than core/wmux-native in this checkout; rerun node scripts/build-native-hooks.mjs`;
  }
  return null;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const crate = path.join(root, 'core', 'wmux-native');
  const target = NATIVE_HOOKS_TARGETS[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`No native hooks target for ${process.platform}-${process.arch}`);
  const binary = nativeHooksBinary(process.platform);

  // Not installed with a minimal toolchain; a no-op once it is.
  if (target.endsWith('-musl')) execFileSync('rustup', ['target', 'add', target], { stdio: 'inherit' });
  // Run from the crate so its .cargo/config.toml applies (static CRT on Windows).
  execFileSync('cargo', ['build', '--release', '--locked', '--target', target], { cwd: crate, stdio: 'inherit' });
  const built = path.join(crate, 'target', target, 'release', binary);

  const version = execFileSync(built, ['--version'], { encoding: 'utf8' });
  if (!version.includes(NATIVE_HOOKS_MARKER)) throw new Error(`${built} --version lacks the ownership marker: ${version}`);

  const stage = path.join(root, 'dist', 'native-hooks');
  fs.mkdirSync(stage, { recursive: true });
  for (const name of fs.readdirSync(stage)) fs.unlinkSync(path.join(stage, name));
  fs.copyFileSync(built, path.join(stage, binary));
  fs.chmodSync(path.join(stage, binary), 0o755);
  const manifest = { platform: process.platform, arch: process.arch, target, binary, sourceHash: nativeHooksSourceHash(root) };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[build-native-hooks] staged ${path.relative(root, path.join(stage, binary))} (${target})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
