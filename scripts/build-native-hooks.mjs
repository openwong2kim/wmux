// Build wmux-native (core/wmux-native) for the host and stage it as
// dist/native-hooks/, which forge.config.ts ships as resources/native-hooks/
// when present. Without a staged binary the package ships the Node bridge only
// and the hook installers keep writing `node <bridge>` entries.
//
//   node scripts/build-native-hooks.mjs
//
// The crate has no dependencies, so the stage holds the binary and a manifest
// naming the platform it was built for (forge refuses a package for another).
import { execFileSync } from 'node:child_process';
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
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, target, binary }, null, 2) + '\n');
  console.log(`[build-native-hooks] staged ${path.relative(root, path.join(stage, binary))} (${target})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
