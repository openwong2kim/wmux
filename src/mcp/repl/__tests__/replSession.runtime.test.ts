/**
 * Real-child tests for the REPL runtime.
 *
 * These spawn actual Node processes, so they live in the `*.runtime.test.ts`
 * suite (serialised, `vitest.runtime.config.ts`). Everything load-bearing about
 * this feature — that state survives, that a runaway stops, that a killed
 * parent does not orphan children — is only true if it is true of a real
 * process, so mocking the child would test nothing worth testing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplSession, buildReplChildEnv } from '../ReplSession';

const live: ReplSession[] = [];

function makeSession(cwd = os.tmpdir()): ReplSession {
  const session = new ReplSession({ name: 'test', cwd });
  live.push(session);
  return session;
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  while (live.length > 0) live.pop()?.destroy('test cleanup');
});

describe('ReplSession state persistence', () => {
  it('keeps let/const/var bindings and required modules across calls', async () => {
    const session = makeSession();

    const first = await session.run('let counter = 41; var legacy = "kept"; const tag = "t";', 5000);
    expect(first.ok).toBe(true);

    const second = await session.run('counter += 1; [counter, legacy, tag]', 5000);
    expect(second.ok).toBe(true);
    expect(second.result?.text).toContain('42');
    expect(second.result?.text).toContain('kept');

    // A module required in one call is still bound in the next.
    await session.run('globalThis.osmod = require("os");', 5000);
    const third = await session.run('typeof osmod.platform', 5000);
    expect(third.result?.text).toContain('function');
  });

  it('captures the code\'s own stdout and stderr separately from the result', async () => {
    const session = makeSession();
    const outcome = await session.run(
      'console.log("to stdout"); console.error("to stderr"); 7 * 6',
      5000,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.stdout.text).toContain('to stdout');
    expect(outcome.stderr.text).toContain('to stderr');
    expect(outcome.result?.text).toBe('42');
  });

  it('supports top-level await and reports the resolved value', async () => {
    const session = makeSession();
    const outcome = await session.run(
      'const delayed = await new Promise((r) => setTimeout(() => r("resolved"), 20)); delayed',
      5000,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toContain('resolved');
  });

  it('returns the trailing expression of a multi-statement awaiting snippet', async () => {
    const session = makeSession();
    const outcome = await session.run(
      'const a = await Promise.resolve(1);\nconst b = a + 41;\nb',
      5000,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toBe('42');
  });

  it('does not persist declarations made inside an awaiting snippet, as documented', async () => {
    const session = makeSession();
    await session.run('const ephemeral = await Promise.resolve(1); ephemeral', 5000);
    const after = await session.run('typeof ephemeral', 5000);
    expect(after.result?.text).toContain('undefined');

    // The documented workaround: assign to a global instead of declaring.
    await session.run('globalThis.kept = await Promise.resolve("yes"); kept', 5000);
    const kept = await session.run('kept', 5000);
    expect(kept.result?.text).toContain('yes');
  });

  it('awaits a returned promise instead of reporting it as pending', async () => {
    const session = makeSession();
    const outcome = await session.run('Promise.resolve({ ok: 1 })', 5000);
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toContain('ok: 1');
    expect(outcome.result?.text).not.toContain('pending');
  });

  it('reports a thrown error with its stack and keeps the session alive', async () => {
    const session = makeSession();
    await session.run('let survivor = "alive";', 5000);
    const failed = await session.run('throw new Error("boom")', 5000);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('boom');
    expect(failed.fatal).toBeUndefined();
    // The runner's own vm/IPC frames are cut: they are identical on every error
    // and would cost the agent context on every failure.
    expect(failed.error).not.toContain('runInThisContext');
    expect(failed.error).not.toContain('node:internal/child_process');

    const after = await session.run('survivor', 5000);
    expect(after.ok).toBe(true);
    expect(after.result?.text).toContain('alive');
  });

  it('explains a let re-declaration instead of leaving a bare V8 error', async () => {
    const session = makeSession();
    await session.run('let dup = 1;', 5000);
    const again = await session.run('let dup = 2;', 5000);
    expect(again.ok).toBe(false);
    expect(again.remedy).toContain('already bound');
    expect(again.fatal).toBeUndefined();
  });
});

describe('ReplSession timeouts', () => {
  it('stops a synchronous runaway without losing session state', async () => {
    const session = makeSession();
    await session.run('let keepme = "still here";', 5000);

    const outcome = await session.run('while (true) {}', 300);
    expect(outcome.ok).toBe(false);
    expect(outcome.timedOut).toBe(true);
    // Entirely-internal stack trimmed down to the message that is the story.
    expect(outcome.error).toBe('Error: Script execution timed out after 300ms');
    // The vm watchdog stops the script; the process is untouched, so state lives.
    expect(outcome.fatal).toBeUndefined();
    expect(session.dead).toBe(false);

    const after = await session.run('keepme', 5000);
    expect(after.result?.text).toContain('still here');
  }, 20_000);

  it('hard-kills the child when a promise never settles, and says state was lost', async () => {
    const session = makeSession();
    const pid = session.pid;
    await session.run('let doomed = 1;', 5000);

    const outcome = await session.run('new Promise(() => {})', 300);
    expect(outcome.ok).toBe(false);
    expect(outcome.fatal).toContain('killed');
    expect(session.dead).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid)).toBe(false);
  }, 20_000);

  it('reports the child exiting on its own rather than hanging', async () => {
    const session = makeSession();
    const outcome = await session.run('process.exit(3)', 5000);
    expect(outcome.ok).toBe(false);
    expect(outcome.fatal).toContain('exited on its own');
    expect(session.dead).toBe(true);
  }, 20_000);

  it('survives an uncaught exception thrown from a background timer', async () => {
    const session = makeSession();
    // Fire well after this run's output drain, so the throw lands between evals
    // and the next run is the one that must surface it.
    await session.run('setTimeout(() => { throw new Error("late boom"); }, 250);', 5000);
    await new Promise((r) => setTimeout(r, 500));
    const after = await session.run('"still running"', 5000);
    expect(session.dead).toBe(false);
    expect(after.ok).toBe(true);
    // Not swallowed, and not misattributed either: it surfaces on the next run
    // as background, since it belongs to the earlier eval, not this one.
    expect(after.background).toContain('late boom');
    expect(after.stderr.text).not.toContain('late boom');
  }, 20_000);
});

describe('ReplSession result integrity (review panel findings)', () => {
  it('ignores an IPC message the user code forges, so the timeout still binds', async () => {
    const session = makeSession();
    // User code shares the child's globals, so it can call process.send. If the
    // parent accepted that, a script could report success, take the answer, and
    // keep burning CPU in the shared broker with the hard timer cleared.
    const outcome = await session.run(
      'process.send({ id: 999, ok: true, result: "\'forged\'" }); 1 + 1',
      5000,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toBe('2');
  }, 20_000);

  it('does not let a thrown message impersonate the vm watchdog', async () => {
    const session = makeSession();
    const outcome = await session.run('throw new Error("Script execution timed out after 1ms")', 5000);
    expect(outcome.ok).toBe(false);
    // Classification comes from the runner, not from matching the error text.
    expect(outcome.timedOut).toBeUndefined();
  }, 20_000);

  it('bounds a value with a huge number of keys inside the child', async () => {
    const session = makeSession();
    const outcome = await session.run(
      'Object.fromEntries(Array.from({ length: 300000 }, (_, i) => ["k" + i, i]))',
      20_000,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toContain('truncated in the REPL process');
  }, 30_000);

  it('still answers for a value with hostile inspection traps', async () => {
    const session = makeSession();
    const outcome = await session.run(
      'new Proxy({}, { ownKeys() { throw new Error("no introspection"); } })',
      5000,
    );
    // The reply must arrive and the session must live: a swallowed inspect
    // failure would present as a hang and cost the caller its whole session.
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toBeTruthy();
    expect(session.dead).toBe(false);
  }, 20_000);

  it('does not split an expression that only looks like two statements', async () => {
    const session = makeSession();
    // There is no ASI before "[", so this is ONE expression:
    // `const a = await Promise.resolve([1,2,3])[0]`, which leaves a undefined.
    // A naive newline split would make the tail `[0]` the returned value and
    // answer `[ 0 ]` — a different program, silently.
    const outcome = await session.run('const a = await Promise.resolve([1, 2, 3])\n[0]', 5000);
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).not.toContain('[ 0 ]');
    expect(outcome.result?.text).toBe('undefined');
  }, 20_000);

  it('does not rewrite a trailing declaration into a return value', async () => {
    const session = makeSession();
    const outcome = await session.run(
      'await Promise.resolve(1);\nfunction helper() { return 5; }',
      5000,
    );
    expect(outcome.ok).toBe(true);
    // Returning the function object would be a different program than written.
    expect(outcome.result?.text).toContain('undefined');
  }, 20_000);

  it('labels output left over from an earlier run as background', async () => {
    const session = makeSession();
    await session.run('setTimeout(() => console.log("from the past"), 250);', 5000);
    await new Promise((r) => setTimeout(r, 500));
    const outcome = await session.run('console.log("mine"); 1', 5000);
    expect(outcome.background).toContain('from the past');
    expect(outcome.stdout.text).toContain('mine');
    // The two must not be blended: that is how an agent misreads another run's
    // output as its own code's doing.
    expect(outcome.stdout.text).not.toContain('from the past');
  }, 20_000);
});

describe('ReplSession output discipline', () => {
  it('truncates a flood of stdout while counting every byte', async () => {
    const session = makeSession();
    const outcome = await session.run(
      'for (let i = 0; i < 20000; i++) console.log("x".repeat(80)); "done"',
      15_000,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.stdout.truncated).toBe(true);
    expect(outcome.stdout.totalBytes).toBeGreaterThan(1_000_000);
    expect(Buffer.byteLength(outcome.stdout.text)).toBeLessThan(70 * 1024);
    expect(outcome.stdout.text).toContain('bytes elided');
  }, 30_000);

  it('bounds a huge return value', async () => {
    const session = makeSession();
    const outcome = await session.run('"y".repeat(200000)', 10_000);
    expect(outcome.ok).toBe(true);
    expect(Buffer.byteLength(outcome.result?.text ?? '')).toBeLessThan(20 * 1024);
  }, 20_000);
});

describe('ReplSession isolation', () => {
  it('withholds nested-agent and credential env from the child', async () => {
    const session = makeSession();
    const outcome = await session.run(
      'JSON.stringify(Object.keys(process.env).filter((k) => ' +
        '/^(CLAUDE|ANTHROPIC)/i.test(k) || k === "AI_AGENT" || /_TOKEN$|_KEY$/i.test(k)))',
      5000,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toContain('[]');
  });

  it('drops CLAUDE*/ANTHROPIC*/AI_AGENT from the built env', () => {
    const { env } = buildReplChildEnv({
      PATH: '/usr/bin',
      CLAUDE_CODE_CHILD_SESSION: 'x',
      CLAUDECODE: '1',
      ANTHROPIC_API_KEY: 'secret',
      AI_AGENT: 'claude',
      GITHUB_TOKEN: 'tok',
      HOME: '/home/u',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AI_AGENT).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('reports which credential names were withheld', () => {
    const { withheldCredentials } = buildReplChildEnv({ PATH: '/b', GITHUB_TOKEN: 'x' });
    expect(withheldCredentials).toContain('GITHUB_TOKEN');
  });

  it('runs in the cwd it was given and rejects one that does not exist', async () => {
    const session = makeSession(os.tmpdir());
    // Compare INSIDE the child and return a boolean. Matching the path against
    // the inspected result instead would compare against a JS string literal:
    // on Windows every separator comes back escaped (C:\\Users\\...), so a
    // substring test for the real path fails even when the cwd is correct.
    // realpath on both sides absorbs macOS reporting /var/... as /private/var/....
    const expectedCwd = fs.realpathSync(os.tmpdir());
    const outcome = await session.run(
      `require("fs").realpathSync(process.cwd()) === ${JSON.stringify(expectedCwd)}`,
      5000,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toBe('true');

    expect(() => makeSession(path.join(os.tmpdir(), 'definitely-not-a-real-wmux-path'))).toThrow(
      /cwd does not exist/,
    );
  });

  it('exits when its parent IPC channel closes, so a crashed parent orphans nothing', async () => {
    const session = makeSession();
    await session.run('1', 5000);
    const pid = session.pid;
    expect(isAlive(pid)).toBe(true);

    // Close the channel WITHOUT killing the child, which is what a SIGKILLed
    // parent looks like from the child's side.
    (session as unknown as { child: { disconnect(): void } }).child.disconnect();
    await new Promise((r) => setTimeout(r, 500));
    expect(isAlive(pid)).toBe(false);
  }, 20_000);
});
