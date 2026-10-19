// scripts/acp-stub.mjs end to end: a real stub child driven over ACP stdio,
// calling a fake MCP server it is handed in session/new, with captures, the
// expect check, the log, and session/load (accepted and refused).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'acp-stub.mjs');

// A minimal MCP server: answers initialize and tools/call with the tool name
// and its arguments as JSON text.
const FAKE_MCP = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const out = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') out({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  else if (m.method === 'tools/call') out({ content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: m.params.name, args: m.params.arguments, headSha: 'c'.repeat(40) }) }] });
});
`;

let dir;
const children = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp1-acpstub-')); });
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

function startStub(script) {
  const scriptFile = path.join(dir, 'script.json');
  const logFile = path.join(dir, 'log.jsonl');
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const child = spawn(process.execPath, [STUB, '--script', scriptFile, '--log', logFile], { stdio: ['pipe', 'pipe', 'ignore'] });
  children.push(child);
  const updates = [];
  const waiting = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.method === 'session/update') updates.push(msg.params.update);
    else if (waiting.has(msg.id)) waiting.get(msg.id)(msg);
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const log = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { request, notify, updates, log };
}

const MCP_SERVERS = [{ name: 'wmux', command: process.execPath, args: ['-e', FAKE_MCP], env: [{ name: 'X', value: '1' }] }];

describe('acp-stub', () => {
  it('plays a turn: tool calls through the handed MCP server, captures, say', async () => {
    const stub = startStub({
      turns: [{ steps: [
        { tool: 'pr_read', args: { prNumber: 12 }, expect: '"ok":true', save: { head: '"headSha":"([0-9a-f]{40})"' } },
        { tool: 'pr_verdict', args: { headSha: '{{head}}', summary: '{{prompt}}' } },
        { say: 'done {{head}}' },
      ] }],
    });
    expect((await stub.request('initialize', { protocolVersion: 1 })).result.protocolVersion).toBe(1);
    const { result } = await stub.request('session/new', { cwd: dir, mcpServers: MCP_SERVERS });
    const res = await stub.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'go' }] });
    expect(res.result.stopReason).toBe('end_turn');
    expect(stub.updates.filter((u) => u.sessionUpdate === 'tool_call').map((u) => u.title)).toEqual(['wmux pr_read', 'wmux pr_verdict']);
    expect(stub.updates.at(-1)).toEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `done ${'c'.repeat(40)}` } });
    const verdictCall = stub.log().find((e) => e.event === 'tool' && e.name === 'pr_verdict');
    expect(JSON.parse(verdictCall.text).args).toEqual({ headSha: 'c'.repeat(40), summary: 'go' });
  });

  it('stops the turn when an expect is not met', async () => {
    const stub = startStub({ turns: [{ steps: [{ tool: 'pr_read', expect: 'never-there' }, { say: 'unreached' }] }] });
    await stub.request('initialize', {});
    const { result } = await stub.request('session/new', { cwd: dir, mcpServers: MCP_SERVERS });
    await stub.request('session/prompt', { sessionId: result.sessionId, prompt: [] });
    expect(stub.updates.at(-1).content.text).toMatch(/^stub: step 0 \(pr_read\) did not succeed/);
  });

  it('captures from the prompt, and stops the turn when a capture does not match', async () => {
    const stub = startStub({ turns: [
      { steps: [{ capture: { task: '"taskId": "(wtask-[a-z0-9-]+)"' } }, { tool: 'pr_verdict', args: { task: '{{task}}' } }] },
      { steps: [{ capture: { task: 'wtask-(nope)' } }, { say: 'unreached' }] },
    ] });
    await stub.request('initialize', {});
    const { result } = await stub.request('session/new', { cwd: dir, mcpServers: MCP_SERVERS });
    await stub.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'task {\n  "taskId": "wtask-ab12"\n}' }] });
    const call = stub.log().find((e) => e.event === 'tool' && e.name === 'pr_verdict');
    expect(JSON.parse(call.text).args).toEqual({ task: 'wtask-ab12' });
    await stub.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'no id here' }] });
    expect(stub.updates.at(-1).content.text).toBe('stub: step 0 found no task in the prompt');
  });

  it('a cancelled turn never resumes, even when the next prompt comes at once', async () => {
    const stub = startStub({ turns: [{ steps: [{ sleep: 300 }, { say: 'OLD_TURN' }] }, { steps: [{ say: 'new' }] }] });
    await stub.request('initialize', {});
    const { result } = await stub.request('session/new', { cwd: dir, mcpServers: [] });
    const first = stub.request('session/prompt', { sessionId: result.sessionId, prompt: [] });
    stub.notify('session/cancel', { sessionId: result.sessionId });
    const second = await stub.request('session/prompt', { sessionId: result.sessionId, prompt: [] });
    expect(second.result.stopReason).toBe('end_turn');
    expect((await first).result.stopReason).toBe('cancelled');
    expect(stub.updates.map((u) => u.content?.text)).toEqual(['new']);
  });

  it('logs session/load, and refuses it when the script says failLoad', async () => {
    const ok = startStub({ turns: [] });
    await ok.request('initialize', {});
    expect((await ok.request('session/load', { sessionId: 'old', mcpServers: [] })).result).toEqual({});
    expect(ok.log().map((e) => e.event)).toEqual(['initialize', 'session/load']);
    const refused = startStub({ failLoad: true, turns: [] });
    expect((await refused.request('session/load', { sessionId: 'old' })).error.message).toBe('unknown session');
  });
});
