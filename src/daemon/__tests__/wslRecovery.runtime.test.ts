/** Opt-in Windows + WSL test: WMUX_TEST_WSL=1 npm run test:runtime.
 * Uses fake Claude and Codex executables that run the REAL per-launch hook/bridge.
 * No API calls, user agent settings edits, or connection to the daily daemon.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { toResumeCommand } from '../../shared/agentResume';
import type { ResumeBinding } from '../../shared/agentResume';
import type { WslTarget } from '../../shared/wslTarget';

const enabled = process.platform === 'win32' && process.env.WMUX_TEST_WSL === '1';
const fakeClaude = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv[1:]
settings = json.load(open(args[args.index('--settings') + 1]))
key = '--resume' if '--resume' in args else '--session-id'
sid = args[args.index(key) + 1]
payload = {'session_id': sid, 'cwd': os.getcwd(), 'transcript_path': os.getcwd() + '/' + sid + '.jsonl'}
for entry in settings['hooks']['SessionStart']:
    for hook in entry['hooks']:
        subprocess.run(hook['command'], shell=True, input=json.dumps(payload), text=True, check=True)
print('WMUX_FAKE_CLAUDE_READY ' + os.environ['WMUX_TEST_RUN'] + ' ' + sid + ' cwd=' + os.getcwd(), flush=True)
for line in sys.stdin:
    if line.strip() == 'quit': break
`;

const fakeCodex = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv[1:]
override = args[args.index('-c') + 1]
assert override.startswith('notify=')
notify = json.loads(override[len('notify='):])
sid = args[args.index('resume') + 1] if 'resume' in args else args[args.index('--session-id') + 1]
sessions = os.path.join(os.environ['CODEX_HOME'], 'sessions', '2026', '09', '18')
os.makedirs(sessions, exist_ok=True)
with open(os.path.join(sessions, 'rollout-2026-09-18T00-00-00-' + sid + '.jsonl'), 'w') as f:
    f.write(json.dumps({'type': 'session_meta', 'payload': {'id': sid, 'source': 'cli'}}) + '\\n')
payload = {'type': 'agent-turn-complete', 'thread-id': sid, 'turn-id': sid + '-turn', 'cwd': os.getcwd()}
subprocess.run(notify + [json.dumps(payload)], check=True)
print('WMUX_FAKE_CODEX_READY ' + os.environ['WMUX_TEST_RUN'] + ' ' + sid + ' cwd=' + os.getcwd(), flush=True)
for line in sys.stdin:
    if line.strip() == 'quit': break
`;

type Session = { args?: string[]; id: string; pid: number; cwd: string; wslTarget: WslTarget; resumeBinding?: ResumeBinding };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}

describe.runIf(enabled)('WSL exact conversation recovery', () => {
  it.each(['claude', 'codex'] as const)('captures two %s IDs in one Linux cwd and restores both through restarts', async (agent) => {
    const readyMarker = `WMUX_FAKE_${agent.toUpperCase()}_READY`;
    const tag = randomUUID().slice(0, 8);
    const suffix = `-wsl-test-${tag}`;
    const wmuxDir = path.join(os.homedir(), `.wmux${suffix}`);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-runtime-'));
    const linuxRoot = `/tmp/wmux-wsl-test-${tag}`;
    const cwd = `${linuxRoot}/project ' $(literal) 日本語`;
    const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    const distroArgs = process.env.WMUX_TEST_WSL_DISTRO ? ['-d', process.env.WMUX_TEST_WSL_DISTRO] : [];
    const distro = execFileSync(wsl, [...distroArgs, '--exec', '/bin/sh', '-c', 'printf %s "$WSL_DISTRO_NAME"'], { encoding: 'utf8', timeout: 15_000 }).trim();
    const selectedArgs = ['-d', distro];
    const bundle = path.resolve(process.env.WMUX_TEST_DAEMON_BUNDLE || 'dist/daemon-bundle/index.js');
    expect(fs.existsSync(bundle)).toBe(true);
    const fixture = path.join(scratch, agent); fs.writeFileSync(fixture, agent === 'claude' ? fakeClaude : fakeCodex);
    execFileSync(wsl, [...selectedArgs, '--exec', '/bin/sh', '-c', 'set -eu; mkdir -p "$1/bin" "$2"; cp "$(wslpath -u "$3")" "$1/bin/$4"; chmod +x "$1/bin/$4"', 'wmux-test', linuxRoot, cwd, fixture, agent], { timeout: 15_000 });
    const processes: ChildProcess[] = [];
    const streams: net.Socket[] = [];
    let token = '';
    let pipe = '';
    let daemon: ChildProcess | undefined;
    let daemonOutput = '';
    const rpc = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => new Promise((resolve, reject) => {
      const socket = net.createConnection(pipe); let data = '';
      const id = randomUUID();
      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`RPC timeout: ${method}`)); }, 25_000);
      socket.on('error', (err) => { clearTimeout(timer); reject(err); });
      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params, token }) + '\n'));
      socket.on('data', (chunk) => {
        data += chunk.toString();
        for (;;) {
          const end = data.indexOf('\n'); if (end < 0) break;
          const line = data.slice(0, end); data = data.slice(end + 1);
          if (!line) continue;
          const response = JSON.parse(line);
          if (response.id !== id) continue;
          clearTimeout(timer); socket.end();
          if (!response.ok) reject(new Error(JSON.stringify(response.error)));
          else resolve(response.result);
        }
      });
    });
    const list = async () => await rpc('daemon.listSessions') as Session[];
    const start = async () => {
      const marker = path.join(wmuxDir, 'daemon-pipe');
      fs.rmSync(marker, { force: true });
      daemon = spawn(process.env.WMUX_TEST_DAEMON_EXECUTABLE || process.execPath, [bundle], {
        env: { ...process.env, WMUX_DATA_SUFFIX: suffix, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      processes.push(daemon);
      daemon.stdout?.on('data', (b) => { daemonOutput = (daemonOutput + b.toString()).slice(-30_000); });
      daemon.stderr?.on('data', (b) => { daemonOutput = (daemonOutput + b.toString()).slice(-30_000); });
      await until(() => fs.existsSync(marker), Boolean, 'daemon ready');
      pipe = fs.readFileSync(marker, 'utf8').trim();
      token = fs.readFileSync(path.join(wmuxDir, 'daemon-auth-token'), 'utf8').trim();
      await rpc('daemon.listSessions');
    };
    const stop = async () => {
      streams.splice(0).forEach((s) => s.destroy());
      if (!daemon || daemon.exitCode !== null) return;
      await rpc('daemon.shutdown');
      await until(() => daemon!.exitCode, (code) => code !== null, 'daemon exit');
    };
    const attach = async (id: string) => {
      await rpc('daemon.attachSession', { id });
      const socket = net.createConnection(`\\\\.\\pipe\\wmux-session-${id}`);
      streams.push(socket);
      let output = '';
      socket.on('data', (data) => { output += data.toString(); });
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      socket.write(token + '\n');
      await rpc('daemon.resizeSession', { id, cols: 110, rows: 30 });
      await until(() => output, (s) => s.includes('133;B'), 'WSL shell prompt');
      return { socket, output: () => output };
    };
    const ids = [`wsl-${tag}-one`, `wsl-${tag}-two`];
    const conversations = [randomUUID(), randomUUID()];
    const runAgent = async (id: string, command: string) => {
      const terminal = await attach(id);
      const baseline = terminal.output().length;
      const runId = randomUUID(); // A restored scrollback marker must not satisfy this launch.
      terminal.socket.write(`WMUX_TEST_RUN="${runId}" CODEX_HOME="${linuxRoot}/codex-home" PATH="$WMUX_WSL_BIN:${linuxRoot}/bin:$PATH" ${command}\r`);
      await until(() => terminal.output().slice(baseline), (s) => s.includes(`${readyMarker} ${runId}`), `${agent} bridge execution`);
      return terminal;
    };
    try {
      await start();
      for (let i = 0; i < ids.length; i++) {
        const created = await rpc('daemon.createSession', { id: ids[i], cmd: wsl, args: selectedArgs, cwd, cols: 110, rows: 30 }) as Session;
        expect(created.cwd).toBe(cwd);
        expect(created.wslTarget.distribution).toBe(distro);
        expect(created.args).toEqual(selectedArgs);
        await runAgent(ids[i], `${agent} --session-id ${conversations[i]}`);
      }
      const captured = await until(list, (sessions) => ids.every((id, i) => sessions.find((s) => s.id === id)?.resumeBinding?.sessionId === conversations[i]), 'distinct captured IDs');
      for (const session of captured) expect(session.resumeBinding?.cwd, JSON.stringify({ cwd: session.cwd, bindingCwd: session.resumeBinding?.cwd })).toBe(cwd);
      const target = captured[0].wslTarget;
      // GUI detach/reattach preserves the actual PTY process and binding.
      for (const s of streams.splice(0)) s.destroy();
      for (const id of ids) await rpc('daemon.detachSession', { id });
      const detached = await list();
      expect(detached.map((s) => s.pid)).toEqual(captured.map((s) => s.pid));
      for (const id of ids) await attach(id);
      for (let restart = 0; restart < 2; restart++) {
        await stop(); await start();
        await Promise.all(ids.map((id) => rpc('daemon.promoteSession', { id })));
        const recovered = await list();
        for (let i = 0; i < ids.length; i++) {
          const session = recovered.find((s) => s.id === ids[i])!;
          expect(session.cwd).toBe(cwd);
          expect(session.wslTarget).toEqual(target);
          expect(session.args).toEqual(selectedArgs);
          expect(session.resumeBinding?.sessionId).toBe(conversations[i]);
          const resume = toResumeCommand(agent, session.resumeBinding, session.cwd);
          expect(resume).toBe(`${agent} ${agent === 'claude' ? '--resume' : 'resume'} ${conversations[i]}`);
          await runAgent(ids[i], resume);
        }
      }
      // A removed directory keeps the same pane and buffer across failed
      // retries AND another daemon restart. Restoring it makes Retry succeed.
      await stop();
      execFileSync(wsl, [...selectedArgs, '--exec', '/bin/mv', '--', cwd, cwd + '.away']);
      await start();
      const pending = await list();
      expect(pending.filter((s) => ids.includes(s.id)).map((s) => s.id).sort()).toEqual([...ids].sort());
      const failures = await Promise.all(ids.map((id) => rpc('daemon.promoteSession', { id }))) as { ok: boolean }[];
      expect(failures.every((r) => !r.ok)).toBe(true);
      await rpc('daemon.ping'); // failed recovery leaves control RPC responsive
      const saved = JSON.parse(fs.readFileSync(path.join(wmuxDir, 'sessions.json'), 'utf8'));
      for (const id of ids) {
        const s = saved.sessions.find((s: { id: string }) => s.id === id);
        expect(s.state).toBe('suspended');
        expect(s.recoveryError).toContain('WSL could not open');
        expect(fs.existsSync(s.bufferDumpPath)).toBe(true);
        expect(fs.readFileSync(s.bufferDumpPath, 'utf8')).toContain(readyMarker);
      }
      await stop(); await start();
      expect((await list()).filter((s) => ids.includes(s.id))).toHaveLength(2);
      execFileSync(wsl, [...selectedArgs, '--exec', '/bin/mv', '--', cwd + '.away', cwd]);
      const retried = await Promise.all(ids.map((id) => rpc('daemon.promoteSession', { id }))) as { ok: boolean }[];
      expect(retried.every((r) => r.ok)).toBe(true);
      const afterRetry = await list();
      for (let i = 0; i < ids.length; i++) {
        expect(afterRetry.find((s) => s.id === ids[i])?.resumeBinding?.sessionId).toBe(conversations[i]);
      }
      await expect(rpc('daemon.createSession', { id: `wsl-${tag}-quoted`, cmd: wsl, cwd: '/tmp/double"quote' })).rejects.toThrow('double quotes');
      // A non-existent project must fail rather than start in a different cwd.
      await expect(rpc('daemon.createSession', { id: `wsl-${tag}-missing`, cmd: wsl, args: selectedArgs, cwd: `${linuxRoot}/missing` })).rejects.toThrow();
      // The diagnostic also validates ~ in the pinned distribution.
      const home = await rpc('daemon.createSession', { id: `wsl-${tag}-home`, cmd: wsl, args: ['-d', 'ChangedDefaultNotInstalled'], cwd: '~', wslTarget: target }) as Session;
      expect(home.wslTarget).toEqual(target);
      expect(home.args).toEqual(selectedArgs);
      expect(home.cwd.startsWith('/')).toBe(true);
      expect(home.cwd).not.toContain('~');
    } catch (err) {
      // The private daemon log contains only fixture data. Never emit tokens.
      throw new Error(`${String(err)}\n${daemonOutput.replaceAll(token || 'unused-token', '[redacted]')}`);
    } finally {
      await stop().catch(() => undefined);
      streams.forEach((s) => s.destroy());
      for (const child of processes) if (child.exitCode === null) child.kill();
      execFileSync(wsl, [...selectedArgs, '--exec', '/bin/rm', '-rf', '--', linuxRoot], { timeout: 15_000 });
      fs.rmSync(wmuxDir, { recursive: true, force: true });
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
