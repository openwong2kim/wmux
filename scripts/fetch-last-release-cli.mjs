#!/usr/bin/env node
// Fetch the last release's CLI bundle for the downgrade test
// (src/cli/commands/__tests__/setupHooks.downgrade.os.test.ts): the Linux
// server tarball carries resources/cli-bundle, plain JavaScript that runs on
// any node. The tarball is checked against its published .sha256 before
// anything is extracted, and only resources/cli-bundle is extracted.
//
//   node scripts/fetch-last-release-cli.mjs <out dir>
//
// The release is the newest `vX.Y.Z` tag in this checkout (no prerelease), so
// the test follows each release without a step of its own. While that tag's
// assets are still being built (HTTP 404), the release before it is used.
// WMUX_LAST_RELEASE (`4.14.0`) names another for a local run, with no
// fallback. No tag at all is an error: CI fetches the tags for this job.
//
// Prints the path of the bundle's index.js (WMUX_LAST_RELEASE_CLI).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetNotFound, fetchNewestPublished, stableReleases } from './lib/last-release.mjs';

const REPO = 'openwong2kim/wmux';

/** The releases to try, newest first. */
function releasesToTry() {
  const override = process.env.WMUX_LAST_RELEASE?.trim();
  if (override) {
    if (!/^\d+\.\d+\.\d+$/.test(override)) throw new Error(`WMUX_LAST_RELEASE must be X.Y.Z, not ${JSON.stringify(override)}`);
    return [override];
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).split('\n');
  const releases = stableReleases(tags);
  if (releases.length === 0) throw new Error('no vX.Y.Z release tag in this checkout: fetch the tags first, or set WMUX_LAST_RELEASE');
  return releases;
}

async function download(release, name) {
  const url = `https://github.com/${REPO}/releases/download/v${release}/${name}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (response.status === 404) throw new AssetNotFound(`${url}: HTTP 404`);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Download, check and extract one release's CLI bundle; its index.js. */
async function fetchRelease(release, out) {
  const asset = `wmux-server-${release}-linux-x64.tar.gz`;
  const bundle = `${release}/resources/cli-bundle`;
  const downloads = path.join(out, 'download');
  const extracted = path.join(out, 'extracted');
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(extracted, { recursive: true });

  const expected = (await download(release, `${asset}.sha256`)).toString('utf8').trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`${asset}.sha256 holds no SHA-256: ${JSON.stringify(expected)}`);
  const tarball = await download(release, asset);
  const actual = createHash('sha256').update(tarball).digest('hex');
  if (actual !== expected) throw new Error(`${asset}: SHA-256 ${actual}, published ${expected}`);
  const file = path.join(downloads, asset);
  fs.writeFileSync(file, tarball);

  execFileSync('tar', ['xzf', file, '-C', extracted, bundle], { stdio: 'inherit' });
  const cli = path.join(extracted, bundle, 'index.js');
  if (!fs.existsSync(cli)) throw new Error(`${asset} has no ${bundle}/index.js`);
  console.error(`last release: ${release}`);
  return cli;
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: node scripts/fetch-last-release-cli.mjs <out dir>');
  const cli = await fetchNewestPublished(releasesToTry(), (release) => fetchRelease(release, out), (line) => console.error(line));
  process.stdout.write(`${cli}\n`);
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
