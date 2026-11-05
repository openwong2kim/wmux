import { verifyOutputInterpreter } from './native-interpreter-verify';
import { StringDecoder } from 'node:string_decoder';
import { DaemonPTYBridge } from '../src/daemon/DaemonPTYBridge';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { RingBuffer } from '../src/daemon/RingBuffer';
import { spawnTerminalPty, ptyBackend, type TerminalPty } from '../src/shared/terminalPty';
import { loadNativeTerminalCore } from '../src/shared/nativeTerminalCore';
import { snapshotRingTextUnqueued } from '../src/daemon/nativeRingSnapshot';
import { enqueueSnapshotJob, generateTextSnapshot } from '../src/daemon/HeadlessSnapshot';

const checks: string[] = [];
const threadCount = () => process.platform === 'darwin' ? execFileSync('ps', ['-M', '-p', String(process.pid)], { encoding: 'utf8' }).trim().split('\n').length - 1
  : process.platform === 'linux' ? Number(fs.readFileSync('/proc/self/status', 'utf8').match(/^Threads:\s+(\d+)/m)?.[1]) : undefined;
const fixture = path.resolve('bench/fixtures/native-pty-child.cjs');
let seed = 0x5eed;
const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
function verifyRing(): void {
  for (const capacity of [1, 7, 1024, 65537, 128 * 1024, 8 * 1024 * 1024]) {
    const reference = new RingBuffer(capacity, 'node');
    const actual = new RingBuffer(capacity, 'rust');
    assert.equal(actual.backend, 'rust');
    for (let step = 0; step < 1000; step++) {
      const operation = random(10);
      if (operation < 3) {
        const cols = 2 + random(200), rows = 1 + random(60);
        reference.noteGeometry(cols, rows); actual.noteGeometry(cols, rows);
      } else if (operation === 3) { reference.clear(); actual.clear(); }
      else {
        const data = Buffer.alloc(random(Math.min(capacity * 2 + 1, 150000)), random(256));
        reference.write(data); actual.write(data);
      }
      assert.deepEqual(actual.readAllWithGeometry(), reference.readAllWithGeometry(), `ring capacity=${capacity} step=${step}`);
      assert.equal(actual.allocatedBytes, reference.allocatedBytes);
      assert.equal(actual.hasGeometryChanges, reference.hasGeometryChanges);
    }
  }
  // Geometry churn without wrapping exercises the 256-mark cap.
  const a = new RingBuffer(1024 * 1024, 'rust'), b = new RingBuffer(1024 * 1024, 'node');
  for (let i = 0; i < 600; i++) for (const ring of [a, b]) { ring.noteGeometry(20 + i, 24); ring.write(Buffer.from('a')); }
  assert.deepEqual(a.readAllWithGeometry(), b.readAllWithGeometry());
  checks.push('ring: 6,000 seeded operations + geometry churn match JS oracle');
}
function session(mode: string, args: string[] = [], onData?: (text: string, pty: TerminalPty) => void,
  command = process.execPath, commandArgs = [fixture, mode, ...args], bundled = process.platform === 'win32') {
  const pty = spawnTerminalPty(command, commandArgs, { cols: 80, rows: 24,
    cwd: process.cwd(), env: { ...process.env, WMUX_FIXTURE_VALUE: '한글 value' }, useConptyDll: bundled },
  () => { throw new Error('Unexpected node-pty fallback'); }) as TerminalPty;
  assert.equal(ptyBackend(pty), 'rust');
  let output = '', exits = 0;
  const done = new Promise<{ output: string; exitCode: number; signal?: number }>((resolve, reject) => {
    // Console input is processed as key events on Windows. Keep the full 4 MiB
    // integrity check, with a longer deadline and byte-count diagnostics.
    const timeoutMs = process.platform === 'win32' && mode === 'input' ? 300000 : 30000;
    const timer = setTimeout(() => {
      const pending = pty.pendingInputBytes;
      pty.dispose?.();
      reject(new Error(`PTY timeout: ${mode}; pendingInputBytes=${pending}; ${output.slice(-500)}`));
    }, timeoutMs);
    pty.onData(text => { output += text; try { onData?.(text, pty); } catch (e) { clearTimeout(timer); pty.dispose?.(); reject(e); } });
    pty.onExit(event => { exits++; clearTimeout(timer); resolve({ output, ...event }); });
  });
  return { pty, done, get exits() { return exits; } };
}
function verifyOutputChunks(): void {
  const native = loadNativeTerminalCore('output-chunk-v1');
  const Decoder = native.NativeOutputDecoder;
  assert(Decoder);
  const cases = [Buffer.from('한글🙂e\u0301\x1b[31mred\x1b[0m'),
    Buffer.from([0xf0, 0x80, 0x80, 0x80, 0xed, 0xa0, 0x80, 0xff, 0xe2, 0x82])];
  const compare = (parts: Buffer[]) => {
    const decoder = new Decoder(), reference = new StringDecoder('utf8');
    const ring = new RingBuffer(1024, 'rust'); let text = '', expected = '';
    try {
      for (let i = 0; i <= parts.length; i++) {
        const bytes = parts[i] ?? Buffer.alloc(0), finish = i === parts.length;
        const chunk = decoder.feed(bytes, finish);
        const referenceChunk = finish ? reference.end() : reference.write(bytes);
        assert.equal(chunk.text, referenceChunk, 'UTF-8 emission boundary must match StringDecoder');
        text += chunk.text; expected += referenceChunk;
        assert.equal(chunk.byteLength, Buffer.byteLength(chunk.text));
        ring.writeNativeChunk(chunk); chunk.dispose();
        assert.equal(chunk.byteLength, 0);
      }
      assert.equal(text, expected); assert.equal(ring.readAll().toString(), expected);
    } finally { ring.dispose(); }
  };
  for (const bytes of cases) for (let i = 0; i <= bytes.length; i++) compare([bytes.subarray(0, i), bytes.subarray(i)]);
  for (let i = 0; i < 5000; i++) compare(Array.from({ length: 10 }, () => Buffer.from(Array.from({ length: random(12) }, () => random(256)))));
  checks.push('output: native UTF-8 + direct ring writes match StringDecoder for every fixture split and 5,000 malformed streams');
}

async function verifyNativeBridge(): Promise<void> {
  const ring = new RingBuffer(1024 * 1024, 'rust'), bridge = new DaemonPTYBridge();
  const live = session('metadata');
  assert(live.pty.onNativeData, 'Native chunk capability missing');
  let directWrites = 0;
  const write = ring.writeNativeChunk.bind(ring);
  ring.writeNativeChunk = chunk => { directWrites++; write(chunk); };
  bridge.setupDataForwarding(live.pty, ring, 'native-bridge');
  try {
    const result = await live.done;
    assert(directWrites > 0); assert.equal(ring.readAll().toString(), result.output);
    checks.push('output: real PTY feeds DaemonPTYBridge and native ring without a JS byte delivery subscriber');
  } finally { live.pty.dispose?.(); bridge.cleanup(); ring.dispose(); }
}

async function verifyPausedDisposal(): Promise<void> {
  const native = loadNativeTerminalCore('pty-v1');
  for (const bundled of process.platform === 'win32' ? [true, false] : [false]) {
    const pty = spawnTerminalPty(process.execPath, [fixture, 'output-raw', '1000000'], {
      cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConptyDll: bundled,
    }, () => { throw new Error('Unexpected node-pty fallback'); }) as TerminalPty;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Paused-disposal fixture did not start output')), 30000);
        let tail = '';
        const listener = pty.onData(text => {
          tail = (tail + text).slice(-4096);
          if (!tail.includes('ROW')) return;
          clearTimeout(timer); listener.dispose(); pty.pause(); resolve();
        });
        pty.onExit(() => { clearTimeout(timer); reject(new Error('Output producer exited before disposal')); });
      });
      // Let the bounded output queue fill, then cancel without resuming it.
      await new Promise(resolve => setTimeout(resolve, 500));
      pty.dispose?.();
      for (let retry = 0; retry < 500 && native.nativeTransportWorkerCount() !== 0; retry++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(native.nativeTransportWorkerCount(), 0, `Paused disposal leaked a worker (bundled=${bundled})`);
    } finally { pty.dispose?.(); }
  }
  checks.push('PTY: disposal with paused bulk output reclaims every worker');
}

async function main() {
  process.env.WMUX_TERMINAL_CORE = 'rust';
  checks.push(...verifyOutputInterpreter());
  verifyRing();
  verifyOutputChunks();
  const threadsBefore = threadCount();
  const nativeRing = new RingBuffer(1024 * 1024, 'rust');
  nativeRing.noteGeometry(80, 24); nativeRing.write(Buffer.from('hello 한글🙂\r\n'));
  nativeRing.noteGeometry(40, 24); nativeRing.write(Buffer.from('\x1b[2mfaint\x1b[0m final'));
  const baselineInput = nativeRing.readAllWithGeometry();
  process.env.WMUX_RUST_SNAPSHOT = '';
  const baseline = await generateTextSnapshot({ cols: 40, rows: 24, initial: baselineInput.data, geometry: baselineInput.geometry, undimmed: true });
  delete process.env.WMUX_RUST_SNAPSHOT;
  const frozen = nativeRing.freezeNative();
  assert.ok(frozen);
  nativeRing.clear();
  assert.deepEqual(frozen.readAll(), baselineInput.data); frozen.dispose();
  nativeRing.write(baselineInput.data);
  // Recreate geometry after clear so the oracle and native request are identical.
  const exact = new RingBuffer(1024 * 1024, 'rust');
  exact.noteGeometry(80, 24); exact.write(Buffer.from('hello 한글🙂\r\n'));
  exact.noteGeometry(40, 24); exact.write(Buffer.from('\x1b[2mfaint\x1b[0m final'));
  const direct = await enqueueSnapshotJob(() => snapshotRingTextUnqueued(exact, null, { cols: 40, rows: 24, undimmed: true, replayGeometry: true }));
  assert.ok(baseline.ok && direct.ok);
  assert.deepEqual(direct.rows, baseline.rows); assert.equal(direct.bytesIn, baseline.bytesIn);
  checks.push('snapshot: immutable native ring, geometry and undimmed text match xterm');
  await verifyNativeBridge();
  const metadata = await session('metadata', ['a b', '한글', '"quoted"']).done;
  assert.match(metadata.output, /한글 value/);
  assert.match(metadata.output, /"cols":80,"rows":24/);
  assert.match(metadata.output, /a b/);
  checks.push('PTY: explicit environment, arguments, cwd and dimensions');
  if (process.platform === 'win32') {
    for (const bundled of [true, false]) {
      const cmd = await session('cmd', [], undefined, process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'echo SHELL-OK'], bundled).done;
      assert.match(cmd.output, /SHELL-OK/); assert.equal(cmd.exitCode, 0);
      const powershell = await session('powershell', [], undefined, 'powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'Write-Output "SHELL-OK"'], bundled).done;
      assert.match(powershell.output, /SHELL-OK/); assert.equal(powershell.exitCode, 0);
    }
    checks.push('Windows: cmd and PowerShell on bundled and inbox ConPTY');
    if (process.env.WMUX_NATIVE_WSL_DISTRO) {
      const wsl = await session('WSL', [], undefined, 'wsl.exe', ['-d', process.env.WMUX_NATIVE_WSL_DISTRO, '--exec', 'sh', '-c', 'printf WSL-SHELL-OK']).done;
      assert.match(wsl.output, /WSL-SHELL-OK/); assert.equal(wsl.exitCode, 0);
      checks.push('WSL: selected distro command and exit (descendant cleanup requires separate qualification)');
    }
  }
  for (const bundled of process.platform === 'win32' ? [true, false] : [false]) {
    let resizeRequested = false;
    const resized = await session('resize', [], (text, pty) => {
      if (!resizeRequested && text.includes('READY')) { resizeRequested = true; pty.resize(120, 40); }
    }, process.execPath, [fixture, 'resize'], bundled).done;
    assert.match(resized.output, /RESIZED:120x40/);
  }
  const tree = await session('tree').done;
  const grandchild = Number(tree.output.match(/CHILD:(\d+)/)?.[1]);
  assert.ok(grandchild > 0);
  let survived = true;
  for (let attempt = 0; attempt < 500 && survived; attempt++) {
    try { process.kill(grandchild, 0); } catch { survived = false; }
    if (survived) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(survived, false, 'Owned descendant survived root exit');
  checks.push('PTY: child observes resize; owned descendant is gone after root exit');
  const cooked = await session('output', ['3']).done;
  assert.equal(cooked.exitCode, 7);
  assert.match(cooked.output, /FINAL-OUTPUT/);
  if (process.platform !== 'win32') assert.match(cooked.output, /\r\nFINAL-OUTPUT\r\n$/);
  const outputSession = session('output-raw', ['10000']);
  outputSession.pty.pause();
  await new Promise(resolve => setTimeout(resolve, 100));
  outputSession.pty.resume();
  const result = await outputSession.done;
  assert.equal(result.exitCode, 7);
  assert.match(result.output, /FINAL-OUTPUT/);
  if (process.platform !== 'win32') {
    const expected = Array.from({ length: 10000 }, (_, i) => `ROW${String(i).padStart(6, '0')}|한글🙂|${'x'.repeat(30)}\r\n`).join('') + 'FINAL-OUTPUT\r\n';
    assert.equal(crypto.createHash('sha256').update(result.output).digest('hex'), crypto.createHash('sha256').update(expected).digest('hex'));
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(outputSession.exits, 1);
  checks.push('PTY: paused bulk output, UTF-8, final output before one exit');
  await verifyPausedDisposal();
  const input = Buffer.alloc(4 * 1024 * 1024, 'x');
  const inputStarted = performance.now();
  let sent = false;
  const inputArgs = [String(input.length)];
  const inputProgress = path.resolve('out/native-input-progress.json');
  if (process.platform === 'win32') { fs.mkdirSync('out', { recursive: true }); inputArgs.push(inputProgress); }
  const received = await session('input', inputArgs, (text, pty) => {
    if (!sent && text.includes('READY')) { sent = true; pty.write(input); }
  }).done.catch(error => {
    if (process.platform === 'win32') console.error(JSON.stringify({ inputSent: sent,
      childProgress: fs.existsSync(inputProgress) ? fs.readFileSync(inputProgress, 'utf8') : null }));
    throw error;
  });
  assert.match(received.output, new RegExp(`DIGEST:${crypto.createHash('sha256').update(input).digest('hex')}`));
  const inputElapsedMs = Math.round(performance.now() - inputStarted);
  checks.push('PTY: 4 MiB async input hash matches without blocking Node');
  let blocked = false;
  const killed = await session('blocked-input', [], (text, pty) => {
    if (blocked || !text.includes('READY')) return;
    blocked = true;
    const before = performance.now();
    pty.write(Buffer.alloc(8 * 1024 * 1024, 'x'));
    // Past the native queue the adapter holds input, as node-pty's write never throws.
    assert.doesNotThrow(() => pty.write(Buffer.alloc(8 * 1024 * 1024)));
    assert.ok((pty.pendingInputBytes ?? 0) > 8 * 1024 * 1024, 'held input counts as pending');
    assert.ok(performance.now() - before < 1000, 'input must enqueue instead of blocking on OS write');
    pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
  }).done;
  if (process.platform !== 'win32') { assert.equal(killed.signal, 9); assert.equal(killed.exitCode, 0); }
  checks.push('PTY: bounded input queue, held backpressure and blocked-writer termination');
  assert.throws(() => spawnTerminalPty(path.join(os.tmpdir(), 'wmux-no-such-command'), [], {}, () => { throw new Error('Must not retry spawn'); }));
  if (process.platform !== 'win32') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-exec-error-'));
    try {
      const script = path.join(dir, 'broken-interpreter');
      fs.writeFileSync(script, '#!/wmux-no-such-interpreter\n', { mode: 0o700 });
      let fallbackCalled = false;
      // An existing executable reaches exec itself. Closing Command's error
      // pipe in pre_exec incorrectly makes this failure look like a spawn.
      assert.throws(() => spawnTerminalPty(script, [], {}, () => {
        fallbackCalled = true; throw new Error('Must not retry an exec failure');
      }));
      assert.equal(fallbackCalled, false);
      checks.push('PTY: exec failure propagates without closing the spawn-error pipe or replaying the command');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  for (const count of [1, 6, 32]) {
    const sessions = Array.from({ length: count }, () => session('idle', [], (text, pty) => { if (text.includes('READY')) { pty.resize(120, 40); pty.kill(); } }));
    await Promise.all(sessions.map(s => s.done));
    assert.ok(sessions.every(s => s.exits === 1));
  }
  const cycles = Number(process.env.WMUX_NATIVE_CYCLES ?? 100);
  for (let i = 0; i < cycles; i++) await session('metadata').done;
  const soakMs = Number(process.env.WMUX_NATIVE_SOAK_MS ?? 0);
  const soakMemory: Array<{ elapsedMs: number; cycles: number; rss: number; heapUsed: number; external: number }> = [];
  if (soakMs > 0) {
    const started = Date.now(), until = started + soakMs;
    let rounds = 0;
    const expectedOutput = Array.from({ length: 1000 }, (_, i) => `ROW${String(i).padStart(6, '0')}|한글🙂|${'x'.repeat(30)}\r\n`).join('') + 'FINAL-OUTPUT\r\n';
    const sample = () => {
      const { rss, heapUsed, external } = process.memoryUsage();
      soakMemory.push({ elapsedMs: Date.now() - started, cycles: rounds, rss, heapUsed, external });
    };
    sample();
    while (Date.now() < until) {
      const cycle = session('output-raw', ['1000']);
      const ring = new RingBuffer(1024 * 1024, 'rust'), bridge = new DaemonPTYBridge();
      bridge.setupDataForwarding(cycle.pty, ring, 'native-soak');
      try {
        const result = await cycle.done;
        assert.equal(result.exitCode, 7);
        assert.equal(cycle.exits, 1);
        assert.equal(ring.readAll().toString(), result.output);
        if (process.platform !== 'win32' && result.output !== expectedOutput) {
          let index = 0;
          while (index < Math.min(result.output.length, expectedOutput.length) && result.output[index] === expectedOutput[index]) index++;
          const evidence = { cycle: rounds, index, actualLength: result.output.length, expectedLength: expectedOutput.length,
            actualWindow: result.output.slice(Math.max(0, index - 100), index + 100), expectedWindow: expectedOutput.slice(Math.max(0, index - 100), index + 100) };
          fs.mkdirSync('out', { recursive: true });
          fs.writeFileSync(`out/native-soak-mismatch-${process.pid}.json`, JSON.stringify({ ...evidence, actual: result.output, expected: expectedOutput }, null, 2));
          assert.fail(`PTY soak output mismatch: ${JSON.stringify(evidence)}`);
        }
      } finally { cycle.pty.dispose?.(); bridge.cleanup(); ring.dispose(); }
      rounds++;
      if (Date.now() - started - (soakMemory.at(-1)?.elapsedMs ?? 0) >= 2000) sample();
    }
    sample();
    checks.push(`PTY: soak ${soakMs} ms, ${rounds} native bridge/ring output/exit cycles`);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  const threadsAfter = threadCount();
  const native = loadNativeTerminalCore('pty-v1');
  for (let retry = 0; retry < 100 && native.nativeTransportWorkerCount() !== 0; retry++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(native.nativeTransportWorkerCount(), 0, 'Native PTY worker survived disposal');
  if (threadsBefore !== undefined && threadsAfter !== undefined) assert.ok(threadsAfter <= threadsBefore + 2, `Native worker leak: ${threadsBefore} -> ${threadsAfter}`);
  const ring = new (loadNativeTerminalCore('ring-v1').NativeRing)(1024);
  ring.dispose(); ring.dispose(); assert.throws(() => ring.write(Buffer.from('x')), /disposed/);
  checks.push(`PTY: 1/6/32 concurrent sessions and ${cycles} lifecycle cycles`);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, checks, passed: checks.length, inputElapsedMs, threadsBefore, threadsAfter, nativeWorkersAfter: native.nativeTransportWorkerCount(), soakMemory }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
