/**
 * Real-child tests for the REPL runtime.
 *
 * These spawn actual Node processes, so they live in the `*.runtime.test.ts`
 * suite (serialised, `vitest.runtime.config.ts`). Everything load-bearing about
 * this feature — that state survives, that a runaway stops, that a killed
 * parent does not orphan children — is only true if it is true of a real
 * process, so mocking the child would test nothing worth testing.
 */
import * as os from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplSession, buildReplChildEnv } from '../ReplSession';

const live: ReplSession[] = [];

function makeSession(cwd = os.tmpdir(), idleMs = 60_000): ReplSession {
  const session = new ReplSession({ name: 'test', cwd, idleMs });
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
    // The background failure is not swallowed — it surfaces on the next run.
    expect(after.stderr.text).toContain('late boom');
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
    const outcome = await session.run('process.cwd()', 5000);
    expect(outcome.ok).toBe(true);
    // macOS reports /var/folders/... as /private/var/folders/...; compare the tail.
    expect(outcome.result?.text).toContain(os.tmpdir().replace(/^\/private/, ''));

    expect(() => makeSession('/definitely/not/a/real/path')).toThrow(/cwd does not exist/);
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
