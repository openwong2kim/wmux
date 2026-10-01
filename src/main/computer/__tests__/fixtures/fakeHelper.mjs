// Stand-in for a native computer-use helper, speaking the NDJSON protocol
// from src/shared/computer/protocol.ts. Behaviour is picked by argv[2]:
//   ok          normal helper
//   old         reports protocolVersion 0
//   silent      never says hello
//   hang        says hello, never answers `click`
//   garbage     answers the first request with a non-JSON line
//   wrong-id    answers with an id nobody asked for
//   split-utf8  answers listApps with a Korean name split mid-character
//               across two writes
//   exit        exits as soon as a request arrives, without answering
//   deaf        answers normally but ignores stdin EOF (a helper stuck in a
//               native call), so only a kill ends it
// Every request is appended to the file named by argv[3] (if given), so tests
// can see what the helper received, including across restarts.
import fs from 'node:fs';
import readline from 'node:readline';

const mode = process.argv[2] || 'ok';
const logFile = process.argv[3];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

if (mode !== 'silent') {
  send({
    type: 'hello',
    protocolVersion: mode === 'old' ? 0 : 1,
    os: 'win32',
    helperVersion: 'fake',
    capabilities: { actions: ['click'], modes: ['ax'], permissions: { accessibility: true, screenRecording: true } },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (logFile) fs.appendFileSync(logFile, req.method + '\n');
  if (mode === 'garbage') return process.stdout.write('not json\n');
  if (mode === 'wrong-id') return send({ id: req.id + 100, ok: true, result: {} });
  if (mode === 'hang' && req.method === 'click') return;
  if (mode === 'exit') process.exit(3);
  if (mode === 'split-utf8' && req.method === 'listApps') {
    const bytes = Buffer.from(JSON.stringify({ id: req.id, ok: true, result: { apps: [{ name: '메모장' }] } }) + '\n');
    const cut = bytes.indexOf(Buffer.from('메')) + 1; // inside the first character
    process.stdout.write(bytes.subarray(0, cut));
    setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
    return;
  }
  switch (req.method) {
    case 'capabilities':
      return send({ id: req.id, ok: true, result: { actions: ['click'], modes: ['ax'], permissions: { accessibility: true, screenRecording: true } } });
    case 'fail':
      return send({ id: req.id, ok: false, error: { code: 'element_stale', message: 'changed' } });
    default:
      return send({ id: req.id, ok: true, result: { method: 'synthetic', verification: 'unverified', echo: req.method } });
  }
});
rl.on('close', () => {
  if (mode === 'deaf') setInterval(() => undefined, 1_000);
  else process.exit(0);
});
