// A stand-in for the full MCP bundle, for broker-pipe-owner.yml: run.ps1
// copies it to ..\mcp-bundle\index.js beside a copy of wmux-native, where the
// shim's fallback looks for the bundle. It answers every request it reads
// with a result that names itself, so the job can tell a fallback answer from
// one the broker gave.
'use strict';

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stand-in-bundle', version: '0' } }
      : { content: [{ type: 'text', text: `FULL BUNDLE ${message.method}` }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  }
});
