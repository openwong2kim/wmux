/** Fail packaging if the copied Rust core cannot serve a detached daemon. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function verifyIntegrity(directory, platform, arch) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.abi, 1, 'Native terminal manifest ABI mismatch');
  assert.equal(manifest.platform, platform, 'Native terminal package platform mismatch');
  assert.equal(manifest.arch, arch, 'Native terminal package architecture mismatch');
  assert.match(manifest.binary, /^wmux-term\.[a-z0-9-]+\.node$/, 'Invalid native binary filename');
  const digest = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(directory, manifest.binary))).digest('hex');
  assert.equal(digest, manifest.sha256, 'Native terminal package checksum mismatch');
  for (const file of ['index.cjs', 'THIRD_PARTY_NOTICES']) {
    assert(fs.statSync(path.join(directory, file)).isFile(), `Missing native terminal ${file}`);
  }
}

/**
 * Re-record the binary's digest after a packaging step that legitimately
 * rewrites it: macOS code signing embeds a signature in the Mach-O. Without
 * this the shipped manifest describes the unsigned build output, not the file
 * it sits next to. Trusts the binary it finds, so run verifyIntegrity first.
 */
function recordShippedDigest(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.match(manifest.binary, /^wmux-term\.[a-z0-9-]+\.node$/, 'Invalid native binary filename');
  manifest.sha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(directory, manifest.binary))).digest('hex');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest.sha256;
}

async function smoke(resources) {
  assert(process.versions.electron, 'Run this smoke with the packaged Electron executable');
  const core = require(path.join(resources, 'wmux-native', 'index.cjs'));
  assert.equal(core.nativeCoreAbiVersion(), 1);
  for (const capability of ['pty-v1', 'ring-v1', 'frozen-ring-v1', 'text-v1', 'ansi-v2', 'output-chunk-v1', 'output-interpreter-v1', 'console-owner-v1']) {
    assert(core.nativeCoreCapabilities().includes(capability), `Missing ${capability}`);
  }

  const interpreter = new core.NativeOutputInterpreter();
  const probe = new core.NativeOutputDecoder().feed(Buffer.from('\x1b[?2004h\x1b]7;file:///tmp/terminal-package\x07'), false);
  try {
    const events = interpreter.feedChunk(probe, probe.byteLength);
    assert.deepEqual(Array.from(events.codes), [7]);
    assert.deepEqual(events.data, ['file:///tmp/terminal-package']);
    assert(interpreter.isSet(2004));
  } finally { probe.dispose(); interpreter.dispose(); }

  const terminal = new core.NativeTerminal(80, 24, 100);
  try {
    terminal.feed(Buffer.from('packaged snapshot'));
    assert(terminal.textSnapshot(false).rows.some(row => row.text.includes('packaged snapshot')));
    assert.match(terminal.ansiSnapshot(), /packaged snapshot/);
  } finally { terminal.dispose(); }

  const ring = new core.NativeRing(4096);
  let transport;
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      let ended = false;
      const timer = setTimeout(() => finish(new Error('Packaged native PTY timed out')), 15000);
      function finish(error) {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      }
      function pump() {
        if (ended) return;
        try {
          const result = transport.readChunk();
          try { output += result.chunk.text; ring.writeChunk(result.chunk); }
          finally { result.chunk.dispose(); }
          assert(!result.error, result.error);
          if (result.bytesRead) setImmediate(pump);
          if (result.exitCode != null) {
            assert.equal(result.exitCode, 0);
            assert.match(output, /wmux-packaged-native/);
            const frozen = ring.freeze();
            try { assert.match(frozen.readAll().toString(), /wmux-packaged-native/); }
            finally { frozen.dispose(); }
            finish();
          }
        } catch (error) { finish(error); }
      }
      try {
        const windows = process.platform === 'win32';
        // Resolve ConPTY from the shipped daemon dependency, never the checkout.
        const conpty = windows ? path.join(resources, 'daemon-bundle', 'node_modules', 'node-pty',
          'prebuilds', `win32-${process.arch}`, 'conpty', 'conpty.dll') : undefined;
        if (conpty) assert(fs.statSync(conpty).isFile(), 'Packaged ConPTY DLL missing');
        transport = new core.NativeTransport(
          windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
          windows ? ['/d', '/s', '/c', 'echo wmux-packaged-native'] : ['-c', 'printf "wmux-packaged-native\\n"'],
          resources, { ...process.env }, 80, 24, () => setImmediate(pump), conpty,
        );
        setImmediate(pump);
      } catch (error) { finish(error); }
    });
  } finally { transport?.close(); ring.dispose(); }
  console.log(JSON.stringify({ packagedNativeTerminal: 'ok', platform: process.platform,
    arch: process.arch, electron: process.versions.electron, resources }));
}

module.exports = { verifyIntegrity, recordShippedDigest };
if (require.main === module) {
  smoke(path.resolve(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
}
