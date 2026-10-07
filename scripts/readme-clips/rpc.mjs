#!/usr/bin/env node
// One RPC to the isolated daemon: node scripts/readme-clips/rpc.mjs -readme3 <method> ['<json params>']
// Example (limits clip): node rpc.mjs -readme3 daemon.hooks.signal '{"kind":"agent.stop_failure",...}'
import { daemonRpc } from './lib.mjs';

const [suffix, method, json = '{}'] = process.argv.slice(2);
if (!suffix || !method) {
  console.error("usage: rpc.mjs -readme<n> <method> ['<json params>']");
  process.exit(2);
}
try {
  const result = await daemonRpc(suffix, method, JSON.parse(json));
  console.log(JSON.stringify(result ?? null, null, 2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
