import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { nativeTerminalTarget } from './lib/native-terminal-targets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@napi-rs/cli/package.json')), require('@napi-rs/cli/package.json').bin.napi);
const { target, binary } = nativeTerminalTarget(process.platform, process.arch);
execFileSync(process.execPath, ['scripts/generate-rust-unicode11.mjs', '--check'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [cli, 'build', '--manifest-path', './Cargo.toml', '--features', 'native-core',
  '--target', target, '--output-dir', './dist/native-core', '--platform', '--release', '--js', 'index.cjs', '--dts', 'index.d.ts'],
{ cwd: path.join(root, 'core/wmux-term'), stdio: 'inherit' });

const output = path.join(root, 'core/wmux-term/dist/native-core');
const stage = path.join(root, 'dist/wmux-native');
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(output, binary), path.join(stage, binary));
// The packaged loader only loads its adjacent, explicitly selected binary.
fs.writeFileSync(path.join(stage, 'index.cjs'), `if(process.platform!==${JSON.stringify(process.platform)}||process.arch!==${JSON.stringify(process.arch)})throw Error('Native terminal target mismatch');\nmodule.exports=require('./${binary}');\n`);
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', 'core/wmux-term/Cargo.toml', '--format-version', '1', '--features', 'native-core', '--filter-platform', target], { cwd: root, encoding: 'utf8' }));
const notices = [];
for (const pkg of metadata.packages) {
  const directory = path.dirname(pkg.manifest_path);
  const files = fs.readdirSync(directory).filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)([.-]|$)/i.test(name));
  notices.push(`${pkg.name} ${pkg.version}\nSPDX: ${pkg.license ?? 'See license file'}\n${pkg.repository ?? ''}\n`);
  for (const file of files) if (fs.statSync(path.join(directory, file)).isFile()) notices.push(fs.readFileSync(path.join(directory, file), 'utf8'));
}
fs.writeFileSync(path.join(stage, 'THIRD_PARTY_NOTICES'), notices.join('\n\n--------------------\n\n'));
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ abi: 1, platform: process.platform, arch: process.arch, target, binary,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(stage, binary))).digest('hex') }, null, 2) + '\n');
