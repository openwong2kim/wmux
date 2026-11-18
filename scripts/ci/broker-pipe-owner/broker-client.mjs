// A client of the MCP broker for broker-pipe-owner.yml: it sends the shim
// handshake with its own pid and parent, and once the broker acks it, an
// MCP initialize and one tool call. It writes what it saw as JSON and exits 0;
// run.ps1 judges the result. With --open-only it only opens the pipe and
// records whether the open succeeded (for a client the pipe must refuse).
//
//   node broker-client.mjs <pipe name> <token> <result file> [--open-only]
import fs from 'node:fs';
import net from 'node:net';

const [pipe, token, resultPath, mode] = process.argv.slice(2);
if (!resultPath) {
  console.error('usage: broker-client.mjs <pipe name> <token> <result file> [--open-only]');
  process.exit(2);
}

const out = { pid: process.pid, connected: false, ack: null, initialized: false, tool: false, toolResult: null, error: null, lines: [] };
let done = false;
const socket = net.connect(pipe);
const timer = setTimeout(() => finish('timed out'), 30_000);

function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  out.error = error ?? null;
  fs.writeFileSync(resultPath, JSON.stringify(out));
  socket.destroy();
  process.exit(0);
}

const send = (message) => socket.write(JSON.stringify(message) + '\n');

socket.on('error', (error) => finish(error.code || error.message));
socket.on('close', () => finish(out.tool ? null : 'closed'));
socket.on('connect', () => {
  out.connected = true;
  if (mode === '--open-only') return finish(null);
  send({ wmuxShim: 1, authToken: token, callerPid: process.pid, callerPpid: process.ppid, ack: 1 });
});

let buffer = '';
socket.setEncoding('utf8');
socket.on('data', (data) => {
  buffer += data;
  for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    // What the broker sent, for the job log (bounded).
    if (out.lines.length < 8) out.lines.push(line.slice(0, 2000));
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.wmuxBroker === 1) {
      out.ack = message;
      if (!message.ok) return finish('refused');
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'broker-ci', version: '0' } } });
    } else if (message.id === 1) {
      out.initialized = Boolean(message.result);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'repl_sessions', arguments: {} } });
    } else if (message.id === 2) {
      out.tool = Boolean(message.result) && !message.result.isError;
      out.toolResult = message.result ?? message.error ?? null;
      return finish(null);
    }
  }
});
