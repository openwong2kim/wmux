#!/usr/bin/env node
// Builds the Windows computer-use helper (NativeAOT, win-x64) into
// native/computer-use-windows/dist/wmux-computer-use.exe, the path a dev build
// of wmux spawns, and stages a copy at <repo>/dist/computer-use-windows/, which
// forge ships as resources/computer-use-windows/ (an extraResource).
//
//   npm run build:computer-use-windows              # build and stage
//   npm run build:computer-use-windows -- --no-stage
//
// NativeAOT cannot cross-compile from another OS, so elsewhere this is a no-op.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const project = join(here, 'src', 'Helper', 'wmux-computer-use.csproj');
const out = join(here, 'dist');
const exe = join(out, 'wmux-computer-use.exe');
const stageDir = join(repo, 'dist', 'computer-use-windows');

if (process.platform !== 'win32') {
  console.log('computer-use-windows: Windows only; skipped');
  process.exit(0);
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--no-stage');
if (unknown.length) {
  console.error(`computer-use-windows: unknown argument ${unknown[0]}`);
  process.exit(2);
}

// hello.helperVersion carries the wmux version the helper was built with.
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
if (!/^[0-9A-Za-z.+-]+$/.test(version)) {
  console.error(`computer-use-windows: unexpected package.json version ${JSON.stringify(version)}`);
  process.exit(1);
}

// A stale exe must never survive a failed build and get staged.
rmSync(out, { recursive: true, force: true });
const publish = spawnSync(
  'dotnet',
  ['publish', project, '-c', 'Release', '-r', 'win-x64', '-o', out, '--nologo', `-p:InformationalVersion=${version}`],
  { stdio: 'inherit', shell: false },
);
if (publish.error) {
  console.error(`computer-use-windows: could not run dotnet (${publish.error.message}); install the .NET 10 SDK`);
  process.exit(1);
}
if (publish.status !== 0) process.exit(publish.status ?? 1);
if (!existsSync(exe)) {
  console.error(`computer-use-windows: dotnet publish succeeded but ${exe} is missing`);
  process.exit(1);
}

if (!args.includes('--no-stage')) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  copyFileSync(exe, join(stageDir, 'wmux-computer-use.exe'));
  console.log(`computer-use-windows: staged ${join(stageDir, 'wmux-computer-use.exe')}`);
}
console.log(`computer-use-windows: built ${exe}`);
