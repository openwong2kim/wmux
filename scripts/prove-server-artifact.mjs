// Load proof for an extracted wmux-server artifact, run on the artifact's own
// Node inside a clean old-glibc image (scripts/prove-server-artifact.sh), the
// way "Add PC over SSH" installs and starts it:
//
//   <runtime>/node/bin/node scripts/prove-server-artifact.mjs <runtime>
//
// <runtime> is the tarball's `<ver>/` directory. The proof:
//   1. runs the native terminal core's package smoke on this Node and host;
//   2. picks the rust engine the way a server user does, in
//      ~/.wmux/terminal-core.json (no WMUX_TERMINAL_CORE override);
//   3. starts the daemon through the shipped CLI (`wmux daemon start`);
//   4. checks the daemon reports rust as requested and effective;
//   5. opens a shell session in the daemon and reads its prompt back from the
//      session's screen text, then ends the session and stops the daemon.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const runtime = fs.realpathSync(path.resolve(process.argv[2] ?? '.'));
const node = path.join(runtime, 'node', 'bin', 'node');
const cli = path.join(runtime, 'resources', 'cli-bundle', 'index.js');
if (fs.realpathSync(process.execPath) !== node) {
  throw new Error(`run this on the artifact's own Node (${node}), not ${process.execPath}`);
}
const home = os.homedir();
const wmuxDir = path.join(home, '.wmux');
const env = { PATH: '/usr/bin:/bin', HOME: home };
const PROMPT = 'wmux-proof$ ';

/** The shipped CLI; its output is kept on failure too (`--json` prints the error on stdout). */
function wmux(...args) {
  const run = spawnSync(node, [cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) {
    throw new Error(`wmux ${args.join(' ')} exited ${run.status ?? run.signal}: ${run.stdout}${run.stderr}${run.error ? run.error.message : ''}`);
  }
  return run.stdout;
}

/** One request on the daemon control pipe (newline-delimited JSON, token-only). */
function rpc(pipe, token, method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const sock = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`${method}: no answer within 10 s`)); }, 10_000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ id, method, params, token })}\n`));
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg = null;
        try { msg = line.trim() ? JSON.parse(line) : null; } catch {
          clearTimeout(timer);
          sock.destroy();
          reject(new Error(`${method}: the daemon answered a line that is not JSON: ${line.slice(0, 200)}`));
          return;
        }
        if (msg?.id !== id) continue;
        clearTimeout(timer);
        sock.end();
        if (msg.ok === false) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
        return;
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

execFileSync(node, [path.join(import.meta.dirname, 'verify-native-terminal-package.cjs'), path.join(runtime, 'resources'), '--node'], {
  stdio: 'inherit', env, timeout: 30_000,
});

fs.mkdirSync(wmuxDir, { recursive: true });
fs.writeFileSync(path.join(wmuxDir, 'terminal-core.json'), `${JSON.stringify({ engine: 'rust' })}\n`);

const started = JSON.parse(wmux('daemon', 'start', '--json'));
try {
  const token = fs.readFileSync(path.join(wmuxDir, 'daemon-auth-token'), 'utf8').trim();
  const call = (method, params = {}) => rpc(started.pipeName, token, method, params);

  const { terminalCore } = await call('daemon.ping', { includeTerminalCore: true });
  if (terminalCore?.requested !== 'rust' || terminalCore.effective !== 'rust'
    || terminalCore.rustAvailable !== true || terminalCore.environmentOverride !== false) {
    throw new Error(`the daemon does not run the rust engine: ${JSON.stringify(terminalCore)}`);
  }

  const id = 'server-artifact-proof';
  await call('daemon.createSession', {
    id, cmd: '/bin/sh', cwd: home, cols: 80, rows: 24,
    env: { PATH: '/usr/bin:/bin', HOME: home, TERM: 'xterm-256color', PS1: PROMPT },
  });
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const text = await call('daemon.readSessionText', { id });
      if (text.mode === 'rows' && text.rows.some((row) => row.text.includes(PROMPT.trim()))) break;
      if (Date.now() > deadline) throw new Error(`the session's prompt never reached its screen text: ${JSON.stringify(text)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    // Reported, not thrown: a failure above says more than one here.
    await call('daemon.destroySession', { id }).catch((err) => console.error(`daemon.destroySession: ${err.message}`));
  }
  console.log(JSON.stringify({ serverArtifactProof: 'ok', arch: process.arch, node: process.version, terminalCore }));
} finally {
  // A failed stop is reported without hiding the error that may have led here.
  try { wmux('daemon', 'stop'); } catch (err) { console.error(`wmux daemon stop: ${err.message}`); process.exitCode = 1; }
}
