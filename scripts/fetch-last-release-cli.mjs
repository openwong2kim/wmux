#!/usr/bin/env node
// Fetch the last release's CLI bundle for the downgrade test
// (src/cli/commands/__tests__/setupHooks.downgrade.os.test.ts): the Linux
// server tarball carries resources/cli-bundle, plain JavaScript that runs on
// any node. The tarball is checked against its published .sha256 before
// anything is extracted, and only resources/cli-bundle is extracted.
//
//   node scripts/fetch-last-release-cli.mjs <out dir>
//
// Prints the path of the bundle's index.js (WMUX_LAST_RELEASE_CLI).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The release the downgrade test runs against: bump it with each release. */
export const LAST_RELEASE = '4.14.0';
const REPO = 'openwong2kim/wmux';
const ASSET = `wmux-server-${LAST_RELEASE}-linux-x64.tar.gz`;
const BUNDLE = `${LAST_RELEASE}/resources/cli-bundle`;

async function download(name) {
  const url = `https://github.com/${REPO}/releases/download/v${LAST_RELEASE}/${name}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: node scripts/fetch-last-release-cli.mjs <out dir>');
  const downloads = path.join(out, 'download');
  const extracted = path.join(out, 'extracted');
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(extracted, { recursive: true });

  const expected = (await download(`${ASSET}.sha256`)).toString('utf8').trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`${ASSET}.sha256 holds no SHA-256: ${JSON.stringify(expected)}`);
  const tarball = await download(ASSET);
  const actual = createHash('sha256').update(tarball).digest('hex');
  if (actual !== expected) throw new Error(`${ASSET}: SHA-256 ${actual}, published ${expected}`);
  const file = path.join(downloads, ASSET);
  fs.writeFileSync(file, tarball);

  execFileSync('tar', ['xzf', file, '-C', extracted, BUNDLE], { stdio: 'inherit' });
  const cli = path.join(extracted, BUNDLE, 'index.js');
  if (!fs.existsSync(cli)) throw new Error(`${ASSET} has no ${BUNDLE}/index.js`);
  process.stdout.write(`${cli}\n`);
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
