import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_DESKTOP_SIGNING_ID, HELPER_SIGNING_ID, HELPER_TEAM_ID } from '../verifyHelper';

// The nested binary's identity is written in four places that must agree:
// main's constants, the runner's check (Swift), the build that signs it and
// the release check of the signed bundle.
const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('the nested agent-desktop identity', () => {
  it('is the same in the runner, the build and the signature check', () => {
    const runner = read('native/computer-use-macos/Sources/ComputerUseCore/Runner.swift');
    expect(runner).toContain(`childIdentifier = "${AGENT_DESKTOP_SIGNING_ID}"`);
    expect(runner).toContain(`helperIdentifier = "${HELPER_SIGNING_ID}"`);
    expect(runner).toContain(`teamID = "${HELPER_TEAM_ID}"`);
    expect(read('native/computer-use-macos/build.sh')).toContain(`AGENT_DESKTOP_IDENTIFIER="${AGENT_DESKTOP_SIGNING_ID}"`);
    const check = read('native/computer-use-macos/check-signature.sh');
    expect(check).toContain(`NESTED_IDENTIFIER="${AGENT_DESKTOP_SIGNING_ID}"`);
    expect(check).toContain(`leaf[subject.OU] = "${HELPER_TEAM_ID}" and identifier "${AGENT_DESKTOP_SIGNING_ID}"`);
  });
});
