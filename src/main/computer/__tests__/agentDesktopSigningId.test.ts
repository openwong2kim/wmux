import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_MAX_LINE_BYTES, RUNNER_MAX_OUTPUT_BYTES, RUNNER_MAX_TIMEOUT_MS } from '../RunnerProcess';
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

describe('the runner limits main relies on', () => {
  // `name = 8 << 20` or `name = 35_000` in RunnerPolicy.
  const swiftConstant = (source: string, name: string): number => {
    const match = new RegExp(`static let ${name} = ([0-9_]+)(?: << ([0-9]+))?`).exec(source);
    if (!match) throw new Error(`${name} not found in Runner.swift`);
    return Number(match[1].replace(/_/g, '')) * 2 ** Number(match[2] ?? 0);
  };

  it('match the Swift runner, and a reply line fits every escaped byte it may carry', () => {
    const runner = read('native/computer-use-macos/Sources/ComputerUseCore/Runner.swift');
    expect(swiftConstant(runner, 'maxOutputBytes')).toBe(RUNNER_MAX_OUTPUT_BYTES);
    expect(swiftConstant(runner, 'maxTimeoutMs')).toBe(RUNNER_MAX_TIMEOUT_MS);
    const stderrCap = swiftConstant(runner, 'maxErrorBytes');
    expect(RUNNER_MAX_LINE_BYTES).toBeGreaterThanOrEqual((RUNNER_MAX_OUTPUT_BYTES + stderrCap) * 6);
  });
});
