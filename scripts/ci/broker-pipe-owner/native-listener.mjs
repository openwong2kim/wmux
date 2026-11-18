// The built terminal core's native pipe listener, for broker-pipe-owner.yml:
// listens on a name as the runner's account, records every connection it
// accepts (with the peer the OS reports), and stops when the stop file
// appears or after a time limit.
//
//   node native-listener.mjs <core module> <pipe name> <ready file> <result file> <stop file>
import fs from 'node:fs';
import { createRequire } from 'node:module';

const [modulePath, pipeName, readyPath, resultPath, stopPath] = process.argv.slice(2);
if (!stopPath) {
  console.error('usage: native-listener.mjs <core module> <pipe name> <ready file> <result file> <stop file>');
  process.exit(2);
}

const core = createRequire(import.meta.url)(modulePath);
if (!core.nativeCoreCapabilities().includes('pipe-listener-v1') || typeof core.NativePipeListener !== 'function') {
  console.error('the terminal core lacks pipe-listener-v1');
  process.exit(1);
}

const accepted = [];
const conns = [];
const listener = new core.NativePipeListener(pipeName, 4, () => {
  for (let conn = listener.takeAccepted(); conn !== null; conn = listener.takeAccepted()) {
    accepted.push(conn.peer());
    conns.push(conn);
  }
});
fs.writeFileSync(readyPath, String(process.pid));

const started = Date.now();
const timer = setInterval(() => {
  if (!fs.existsSync(stopPath) && Date.now() - started < 300_000) return;
  clearInterval(timer);
  const failure = listener.failure();
  for (const conn of conns) conn.destroy();
  listener.close();
  fs.writeFileSync(resultPath, JSON.stringify({ accepted, failure }));
  // The native listener's threads are joined off the JS thread; leave once
  // the result is on disk.
  setTimeout(() => process.exit(0), 200);
}, 100);
