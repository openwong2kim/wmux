// The Windows computer-use helper's release order (release.yml).
//
// `make` bakes the staged helper's SHA-256 into the main bundle, and a
// packaged wmux refuses a helper that does not match it. So the helper must be
// signed before it is staged, and staged before `make`: a signing step added
// after the pin would ship a build whose computer use fails closed for every
// user. This pins the order of the steps by name.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  )
  .replace(/\r\n/g, '\n');

/** Step names of the `build` job, in order. */
function buildJobSteps(text) {
  const job = text.slice(text.indexOf('\n  build:\n'), text.indexOf('\n  winget:\n'));
  return [...job.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1].trim());
}

describe('release.yml computer-use helper order', () => {
  const steps = buildJobSteps(RELEASE);
  const at = (name) => {
    const i = steps.indexOf(name);
    expect(i, `step "${name}" is missing from release.yml's build job`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('builds, signs, stages, makes, then checks the packaged helper', () => {
    const order = [
      'Build the computer-use helper',
      'Upload unsigned computer-use helper for signing',
      'Sign computer-use helper via SignPath',
      'Replace the unsigned helper with the signed one',
      'Stage the computer-use helper',
      'Build & Make',
      'Check the packaged computer-use helper',
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('touches the helper exe nowhere after staging', () => {
    const stage = at('Stage the computer-use helper');
    const job = RELEASE.slice(RELEASE.indexOf('- name: Stage the computer-use helper'), RELEASE.indexOf('\n  winget:\n'));
    const later = job.slice(job.indexOf('\n      - ', 1));
    expect(stage).toBeGreaterThan(0);
    expect(later).not.toMatch(/Copy-Item[^\n]*wmux-computer-use\.exe/);
  });
});
