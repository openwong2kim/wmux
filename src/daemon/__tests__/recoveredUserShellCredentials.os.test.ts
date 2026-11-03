// #3049 — which restored pane gets which credentials, read off each child's
// real environment: a real /bin/sh in DaemonSessionManager prints the values
// it holds. The records come from a temporary sessions.json; recovery holds
// what the hold list names (recoverySelector heldForCredentials) and replays
// the rest from the record, and main's connect pass (pty/userShellRecord.ts)
// starts the held shells through a promote that does what daemon.promoteSession
// does with credentialEnv. The daemon's own env carries a GH_TOKEN and the
// push relay secret, as a daemon inheriting main's env does on Windows and
// Linux (and the relay secret on macOS): neither may reach any pane.
//
// What needs a running daemon (attach answering pending, the first-party
// refusal, the fallback timer, a failed start staying pending) is pinned in
// heldUserShellWiring.test.ts; the decisions themselves are unit-tested in
// heldUserShellStart.test.ts and recoveredUserShellCredentials.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonSessionManager } from '../DaemonSessionManager';
import { StateWriter } from '../StateWriter';
import { heldForCredentials } from '../recoverySelector';
import { createHeldStartFallback } from '../heldUserShellStart';
import type { DaemonSession } from '../types';
import { sanitizeCredentialEnv } from '../../shared/envFilter';
import { readUserShellHolds, USER_SHELL_HOLDS_FILE } from '../../shared/userShellHolds';
import { UserShellRecord, startHeldUserShells, type ListedSession, type PromoteAnswer } from '../../main/pty/userShellRecord';
import { waitFor } from '../../test-utils/waitFor';

const SHELL = '/bin/sh';
const posix = process.platform !== 'win32' && fs.existsSync(SHELL);
const WAIT_MS = 20_000;

// Placeholder values only; no real secret is ever used in a test.
const DAEMON_TOKEN = 'daemon-env-placeholder';
const MAIN_TOKEN = 'main-placeholder';
const RELAY = 'relay-placeholder';
const MAIN_ENV = { PATH: '/main/bin', GH_TOKEN: MAIN_TOKEN, WMUX_PUSH_RELAY_SECRET: RELAY };

/** What the pane's own process sees, printed so its echo cannot match. */
const PROBE = `printf 'rx-%s-%s-%s\\n' "\${GH_TOKEN:-none}" "\${WMUX_PUSH_RELAY_SECRET:-none}" end\n`;
const seen = (token: string, relay: string) => `rx-${token}-${relay}-end`;

describe.skipIf(!posix)('restored panes and their credentials, through a real shell (#3049)', () => {
  let dir: string;
  let manager: DaemonSessionManager;
  let writer: StateWriter;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cred3049-os-'));
    manager = new DaemonSessionManager();
    writer = new StateWriter(dir);
    vi.stubEnv('GH_TOKEN', DAEMON_TOKEN);
    vi.stubEnv('WMUX_PUSH_RELAY_SECRET', RELAY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    manager.disposeAll();
    writer.dispose();
    // A shell just killed can still be writing in its home.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const persistedEnv = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, HISTFILE: '/dev/null', PS1: '$ ', TERM: 'xterm-256color', LC_ALL: 'C' });
  function rec(id: string, extra: Partial<DaemonSession> = {}): DaemonSession {
    const now = new Date().toISOString();
    return {
      id, state: 'suspended', incarnationId: `inc-${id}`, createdAt: now, lastActivity: now, pid: 0,
      cmd: SHELL, cwd: dir, env: persistedEnv(), cols: 80, rows: 24, deadTtlHours: 24, ...extra,
    };
  }

  const replay = (s: DaemonSession) => ({
    id: s.id, cmd: s.cmd, cwd: s.cwd, env: s.env, cols: s.cols, rows: s.rows, incarnationId: s.incarnationId,
    ...(s.exec ? { exec: s.exec } : {}), ...(s.supervision ? { supervision: s.supervision } : {}),
  });

  /** Boot recovery's choice for each record, as recoverSessions makes it. */
  async function recover(holds: ReadonlySet<string>): Promise<void> {
    for (const session of writer.load().sessions) {
      if (heldForCredentials(session, holds)) {
        session.state = 'suspended';
        manager.holdForStart(session);
      } else {
        await manager.createSessionAsync(replay(session));
      }
    }
  }

  /** The daemon's side of main's RPCs: the listing and daemon.promoteSession's credentialEnv handling. */
  const daemon = {
    rpc: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === 'daemon.listSessions') {
        return manager.listSessions().map((s) => ({ ...s, ...(manager.isStartPending(s.id) ? { startPending: true } : {}) }));
      }
      const id = String(params?.id);
      const session = manager.getPendingRecovery(id)!;
      const credentialEnv = params?.credentialEnv === undefined ? undefined : sanitizeCredentialEnv(params.credentialEnv);
      if (credentialEnv === null || (credentialEnv && (session.exec || session.supervision))) return { ok: false } satisfies PromoteAnswer;
      await manager.createSessionAsync({ ...replay(session), ...(credentialEnv ? { credentialEnv } : {}) });
      return { ok: true, alreadyActive: false, ...(credentialEnv ? { credentialsApplied: true as const } : {}) } satisfies PromoteAnswer;
    },
  };

  async function probe(id: string): Promise<string> {
    const managed = manager.getSession(id)!;
    if (!managed.meta.exec) managed.ptyProcess.write(PROBE);
    await waitFor(() => /rx-[^\n]*-end/.test(manager.getSession(id)!.ringBuffer.readAll().toString('utf8')), WAIT_MS, `${id} printed its env`);
    return manager.getSession(id)!.ringBuffer.readAll().toString('utf8');
  }

  it('only the user shell main recorded gets main\'s value; the daemon\'s own token and the relay secret reach no pane', async () => {
    const sessions = [
      rec('user-shell'),
      rec('exec-agent', { exec: { command: PROBE.trim() } }),
      rec('plain-agent'),
      // Edited records: a flag the daemon does not read, an exec removed from
      // an agent that is then put on the hold list, and an env field deleted.
      { ...rec('flagged'), credentialPassthrough: true } as DaemonSession,
      rec('exec-removed'),
      (() => { const r = rec('no-env'); delete (r as Partial<DaemonSession>).env; return r; })(),
    ];
    expect(writer.saveImmediate({ version: 1, sessions, bootId: 'boot' })).toBe(true);
    const holdsFile = path.join(dir, USER_SHELL_HOLDS_FILE);
    fs.writeFileSync(holdsFile, JSON.stringify({ version: 1, ids: ['user-shell', 'exec-agent', 'exec-removed'] }));
    const record = new UserShellRecord(path.join(dir, 'user-shell-record.json'), path.join(dir, 'main-holds.json'));
    record.set('user-shell', { cmd: SHELL, incarnationId: 'inc-user-shell' });

    await recover(readUserShellHolds(holdsFile));
    // The exec unit is never held, whatever the list says; the two plain
    // shells on the list are.
    expect(manager.startPendingIds().sort()).toEqual(['exec-removed', 'user-shell']);
    expect(manager.getSession('exec-agent')).toBeDefined();

    expect(await startHeldUserShells(daemon, record, { liveEnv: MAIN_ENV, log: () => undefined })).toBe(2);

    expect(await probe('user-shell')).toContain(seen(MAIN_TOKEN, 'none'));
    for (const id of ['exec-agent', 'plain-agent', 'flagged', 'exec-removed', 'no-env']) {
      const out = await probe(id);
      expect(out, id).toContain(seen('none', 'none'));
    }
    for (const id of ['user-shell', 'exec-agent', 'plain-agent', 'flagged', 'exec-removed', 'no-env']) {
      const out = manager.getSession(id)!.ringBuffer.readAll().toString('utf8');
      expect(out, id).not.toContain(DAEMON_TOKEN);
      expect(out, id).not.toContain(RELAY);
    }

    // Nothing main passed is on a record, listed, or saved.
    expect(JSON.stringify(manager.listSessions())).not.toContain(MAIN_TOKEN);
    expect(writer.saveImmediate({ version: 1, sessions: manager.listSessions(), bootId: 'boot' })).toBe(true);
    const saved = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
    expect(saved).not.toContain(MAIN_TOKEN);
    expect(saved).not.toContain('startPending');
    // One entry per id once started.
    expect(manager.listSessions().filter((s) => s.id === 'user-shell')).toHaveLength(1);
  });

  it('with no app at all, the fallback starts a held shell, and without anyone\'s credentials', async () => {
    expect(writer.saveImmediate({ version: 1, sessions: [rec('lonely-shell')], bootId: 'boot' })).toBe(true);
    await recover(new Set(['lonely-shell']));
    expect(manager.isStartPending('lonely-shell')).toBe(true);

    const fallback = createHeldStartFallback({
      heldIds: () => manager.startPendingIds(),
      start: (id) => daemon.rpc('daemon.promoteSession', { id }),
      log: () => undefined,
    });
    await fallback.fire();

    expect(manager.isStartPending('lonely-shell')).toBe(false);
    const out = await probe('lonely-shell');
    expect(out).toContain(seen('none', 'none'));
    expect(out).not.toContain(DAEMON_TOKEN);
  });
});
