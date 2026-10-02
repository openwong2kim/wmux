import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import {
  HELPER_REQUIREMENT,
  createHelperVerifier,
  helperBundlePath,
  type CodesignResult,
  type RunCodesign,
} from '../verifyHelper';

const BUNDLE = '/Applications/wmux.app/Contents/Resources/computer-use-macos/wmux Computer Use.app';
const EXE = `${BUNDLE}/Contents/MacOS/wmux-computer-use`;

interface FakeSignature {
  signed: boolean;
  team?: string;
  identifier?: string;
}

/**
 * Stands in for /usr/bin/codesign: evaluates the one requirement verifyHelper
 * sends against a fake signature, with codesign's real exit codes (0 ok,
 * 1 not signed, 3 requirement not satisfied).
 */
function fakeCodesign(sig: FakeSignature): RunCodesign & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: readonly string[]): Promise<CodesignResult> => {
    calls.push([...args]);
    expect(args).toContain(`-R=${HELPER_REQUIREMENT}`);
    expect(args).toContain('--strict');
    expect(args[args.length - 1]).toBe(BUNDLE);
    if (!sig.signed) return { code: 1, stderr: `${BUNDLE}: code object is not signed at all\n` };
    if (sig.team !== '8RGHH2F237' || sig.identifier !== 'com.electron.wmux.computer-use') {
      return { code: 3, stderr: 'test-requirement: code failed to satisfy specified code requirement(s)\n' };
    }
    return { code: 0, stderr: '' };
  };
  return Object.assign(run, { calls });
}

const verifier = (sig: FakeSignature, fileIdentity = async () => 'dev:ino:1') => {
  const runCodesign = fakeCodesign(sig);
  return { verify: createHelperVerifier({ platform: 'darwin', isPackaged: true, runCodesign, fileIdentity }), runCodesign };
};

async function refusal(promise: Promise<void>): Promise<ComputerError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ComputerError);
  expect((error as ComputerError).code).toBe('helper_unavailable');
  return error as ComputerError;
}

describe('computer-use helper signature check', () => {
  it('accepts the helper signed by the wmux team with its own identifier', async () => {
    const { verify } = verifier({ signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' });
    await expect(verify(EXE)).resolves.toBeUndefined();
  });

  it('refuses another binary from the same team (wrong identifier)', async () => {
    const { verify } = verifier({ signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux' });
    expect((await refusal(verify(EXE))).message).toContain('failed to satisfy');
  });

  it('refuses the right identifier signed by another team', async () => {
    const { verify } = verifier({ signed: true, team: 'ABCDE12345', identifier: 'com.electron.wmux.computer-use' });
    await refusal(verify(EXE));
  });

  it('refuses an unsigned helper binary', async () => {
    const { verify } = verifier({ signed: false });
    expect((await refusal(verify(EXE))).message).toContain('not signed at all');
  });

  it('refuses the ad-hoc helper an unsigned wmux build ships', async () => {
    // build.sh signs ad-hoc without an identity: no team, so the anchor fails.
    const { verify } = verifier({ signed: true, identifier: 'com.electron.wmux.computer-use' });
    await refusal(verify(EXE));
  });

  it('refuses a helper outside an app bundle without running codesign', async () => {
    const { verify, runCodesign } = verifier({ signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' });
    await refusal(verify('/tmp/wmux-computer-use'));
    expect(runCodesign.calls).toHaveLength(0);
  });

  it('refuses a missing helper', async () => {
    const { verify } = verifier({ signed: true }, async () => {
      throw new Error('ENOENT');
    });
    expect((await refusal(verify(EXE))).message).toContain('missing');
  });

  it('caches the verdict by path and file identity', async () => {
    let identity = 'dev:ino:1';
    const { verify, runCodesign } = verifier(
      { signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' },
      async () => identity,
    );
    await verify(EXE);
    await verify(EXE);
    expect(runCodesign.calls).toHaveLength(1);
    identity = 'dev:ino2:1'; // the binary was replaced
    await verify(EXE);
    expect(runCodesign.calls).toHaveLength(2);
  });

  it('caches a refusal too, until the binary changes', async () => {
    const { verify, runCodesign } = verifier({ signed: false });
    await refusal(verify(EXE));
    await refusal(verify(EXE));
    expect(runCodesign.calls).toHaveLength(1);
  });

  it('refuses a helper swapped while codesign ran, and does not cache that', async () => {
    let identity = 'dev:ino:1';
    const runCodesign = fakeCodesign({ signed: true, team: '8RGHH2F237', identifier: 'com.electron.wmux.computer-use' });
    const verify = createHelperVerifier({
      platform: 'darwin',
      isPackaged: true,
      fileIdentity: async () => identity,
      runCodesign: async (args) => {
        const result = await runCodesign(args);
        identity = 'dev:ino2:1'; // replaced mid-check
        return result;
      },
    });
    expect((await refusal(verify(EXE))).message).toContain('changed');
    // The new binary is checked on its own next time.
    await expect(verify(EXE)).resolves.toBeUndefined();
    expect(runCodesign.calls).toHaveLength(2);
  });

  it('does not cache a codesign timeout or signal', async () => {
    let calls = 0;
    const verify = createHelperVerifier({
      platform: 'darwin',
      isPackaged: true,
      fileIdentity: async () => 'dev:ino:1',
      runCodesign: async () => {
        calls += 1;
        return { code: -1, stderr: '' };
      },
    });
    await refusal(verify(EXE));
    await refusal(verify(EXE));
    expect(calls).toBe(2);
  });

  it('does not check dev builds or other platforms', async () => {
    const runCodesign = vi.fn<RunCodesign>();
    await createHelperVerifier({ platform: 'darwin', isPackaged: false, runCodesign })(EXE);
    await createHelperVerifier({ platform: 'win32', isPackaged: true, runCodesign })('C:\\wmux\\helper.exe');
    expect(runCodesign).not.toHaveBeenCalled();
  });

  it('finds the bundle around the executable', () => {
    expect(helperBundlePath(EXE)).toBe(BUNDLE);
    expect(helperBundlePath('/x/helper')).toBeNull();
  });

  it.runIf(process.platform === 'darwin')('real codesign refuses an unsigned bundle', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wmux-verify-'));
    const exe = path.join(dir, 'Fake.app', 'Contents', 'MacOS', 'fake');
    await fs.mkdir(path.dirname(exe), { recursive: true });
    await fs.writeFile(exe, '#!/bin/sh\n', { mode: 0o755 });
    try {
      await refusal(createHelperVerifier({ platform: 'darwin', isPackaged: true })(exe));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
