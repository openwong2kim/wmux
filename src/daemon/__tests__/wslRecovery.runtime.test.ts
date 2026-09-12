/** Opt-in Windows + WSL test: WMUX_TEST_WSL=1 npm run test:runtime.
 * Uses a fake Claude executable that runs the REAL per-launch hook/bridge.
 * No API calls, user Claude settings edits, or connection to the daily daemon.
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
print('WMUX_FAKE_CLAUDE_READY ' + sid + ' cwd=' + os.getcwd(), flush=True)
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
  it('captures two IDs in one Linux cwd, reattaches and restores both through two restarts', async () => {
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
    const fixture = path.join(scratch, 'claude'); fs.writeFileSync(fixture, fakeClaude);
    execFileSync(wsl, [...selectedArgs, '--exec', '/bin/sh', '-c', 'set -eu; mkdir -p "$1/bin" "$2"; cp "$(wslpath -u "$3")" "$1/bin/claude"; chmod +x "$1/bin/claude"', 'wmux-test', linuxRoot, cwd, fixture], { timeout: 15_000 });
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
    const runClaude = async (id: string, command: string) => {
      const terminal = await attach(id);
      const baseline = terminal.output().length;
      terminal.socket.write(`PATH="$WMUX_WSL_BIN:${linuxRoot}/bin:$PATH" ${command}\r`);
      await until(() => terminal.output().slice(baseline), (s) => s.includes('WMUX_FAKE_CLAUDE_READY'), 'Claude hook execution');
      return terminal;
    };
    try {
      await start();
      for (let i = 0; i < ids.length; i++) {
        const created = await rpc('daemon.createSession', { id: ids[i], cmd: wsl, args: selectedArgs, cwd, cols: 110, rows: 30 }) as Session;
        expect(created.cwd).toBe(cwd);
        expect(created.wslTarget.distribution).toBe(distro);
        expect(created.args).toEqual(selectedArgs);
        await runClaude(ids[i], `claude --session-id ${conversations[i]}`);
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
        const recovered = await list();
        for (let i = 0; i < ids.length; i++) {
          const session = recovered.find((s) => s.id === ids[i])!;
          expect(session.cwd).toBe(cwd);
          expect(session.wslTarget).toEqual(target);
          expect(session.args).toEqual(selectedArgs);
          expect(session.resumeBinding?.sessionId).toBe(conversations[i]);
          const resume = toResumeCommand('claude', session.resumeBinding, session.cwd);
          expect(resume).toBe(`claude --resume ${conversations[i]}`);
          await runClaude(ids[i], resume);
        }
      }
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
