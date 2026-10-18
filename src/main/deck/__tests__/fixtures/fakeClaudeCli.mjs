#!/usr/bin/env node
// A stand-in for the claude CLI in stream-json mode, for the Agent SDK test
// of a bot turn whose prompt carries images (ClaudeSdkAdapter.images.test.ts).
// Every user message it reads is appended, with the argv, to FAKE_CLI_LOG.
// `--resume dead` exits at once without a result (a dead seeded session id);
// FAKE_CLI_HOLD=1 holds the result until an interrupt control request.
import fs from 'node:fs';
import readline from 'node:readline';

const log = process.env.FAKE_CLI_LOG;
const args = process.argv.slice(2);
const resumeAt = args.indexOf('--resume');
const resume = resumeAt >= 0 ? args[resumeAt + 1] : null;
const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
if (resume === 'dead') {
  if (log) fs.appendFileSync(log, `${JSON.stringify({ args, dead: true })}\n`);
  process.stderr.write('No conversation found with session ID: dead\n');
  process.exit(1);
}
const sessionId = resume ?? `s-${process.pid}`;
// The session's tools as claude reports them: the allowed wmux tools, the
// wmux MCP server connected.
const allowedAt = args.indexOf('--allowedTools');
const tools = allowedAt >= 0 ? args[allowedAt + 1].split(',').filter(Boolean) : [];
let held = null;
const finish = (subtype) => {
  write({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'seen' }] } });
  write({ type: 'result', subtype, session_id: sessionId, is_error: subtype !== 'success', result: 'seen', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} });
};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    if (msg.request?.subtype === 'interrupt' && held) { held = null; finish('error_during_execution'); }
    return;
  }
  if (msg.type !== 'user') return;
  if (log) fs.appendFileSync(log, `${JSON.stringify({ args, message: msg.message })}\n`);
  write({ type: 'system', subtype: 'init', session_id: sessionId, tools, mcp_servers: [{ name: 'wmux', status: 'connected' }], model: 'fake', cwd: process.cwd(), permissionMode: 'default', apiKeySource: 'none' });
  if (process.env.FAKE_CLI_HOLD === '1') { held = true; return; }
  finish('success');
});
rl.on('close', () => process.exit(0));
