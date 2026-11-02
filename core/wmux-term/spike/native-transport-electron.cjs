/** Production transport and packaged loader in Electron main. */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const { NativeTransport, NativeRing, NativeOutputDecoder, NativeOutputInterpreter, nativeCoreCapabilities } = require('../../../dist/wmux-native/index.cjs');
let transport, ended = false, output = '';
const timer = setTimeout(() => { transport?.close(); app.exit(1); }, 15000);
app.whenReady().then(() => {
  assert(nativeCoreCapabilities().includes('pty-v1'));
  assert(nativeCoreCapabilities().includes('output-chunk-v1'));
  assert(nativeCoreCapabilities().includes('output-interpreter-v1'));
  assert(nativeCoreCapabilities().includes('console-owner-v1'));
  const interpreter = new NativeOutputInterpreter();
  const probe = new NativeOutputDecoder().feed(Buffer.from('\x1b[?2004h\x1b]7;file:///tmp/한글\x07\x1b]133;C\x07'), false);
  try {
    const events = interpreter.feedChunk(probe, probe.byteLength);
    assert.deepEqual(Array.from(events.codes), [7, 133]);
    assert.deepEqual(events.data, ['file:///tmp/한글', 'C']);
    assert(interpreter.isSet(2004));
    assert.equal(interpreter.preamble(probe.byteLength + 1), '\x1b[?2004h');
  } finally { probe.dispose(); interpreter.dispose(); }
  const ring = new NativeRing(1024);
  const pump = () => {
    if (ended) return;
    const result = transport.readChunk();
    try { output += result.chunk.text; ring.writeChunk(result.chunk); }
    finally { result.chunk.dispose(); }
    if (result.bytesRead) setImmediate(pump);
    if (result.exitCode != null) {
      ended = true;
      try { assert.equal(result.exitCode, 0); assert.match(output, /native-electron/); assert(ring.size > 0); }
      catch (e) { console.error(e); process.exitCode = 1; }
      finally { transport.close(); ring.dispose(); clearTimeout(timer); console.log(JSON.stringify({ electron: process.versions.electron, ok: !process.exitCode })); app.exit(process.exitCode ?? 0); }
    }
  };
  // The Windows Electron executable is a GUI-subsystem process and is not a
  // console-output oracle under ConPTY. Keep the host in Electron, but spawn a
  // real console child there, as the product does for cmd/PowerShell sessions.
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.execPath;
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'echo native-electron'] : ['-e', 'console.log("native-electron")'];
  // The console-window owner (sign-in pickers), given at spawn and again later: the
  // bundled conpty.dll takes a real window's handle; elsewhere, and for a handle of
  // the wrong size or a NULL one, it is a no-op.
  const owner = new BrowserWindow({ show: false });
  transport = new NativeTransport(command, args, process.cwd(),
    { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, 80, 24, () => setImmediate(pump), process.platform === 'win32'
      ? path.resolve('node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll') : undefined,
    owner.getNativeWindowHandle());
  try {
    assert.equal(transport.setParentWindow(owner.getNativeWindowHandle()), process.platform === 'win32');
    assert.equal(transport.setParentWindow(Buffer.alloc(3)), false);
    assert.equal(transport.setParentWindow(Buffer.alloc(8)), false);
  } finally { owner.destroy(); }
}).catch(e => { console.error(e); clearTimeout(timer); transport?.close(); app.exit(1); });
