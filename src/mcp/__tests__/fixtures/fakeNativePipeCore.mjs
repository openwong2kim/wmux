// A stand-in terminal core for brokerWin32Wiring.os.test.ts: the native pipe
// listener's contract (pipe-listener-v2, see src/mcp/nativePipe.ts and
// nativePipeSocket.ts) over Node's own named-pipe server, so the broker's
// Windows wiring runs without the built core. The broker loads it through
// WMUX_TERMINAL_CORE_MODULE (an ES module: the loader's require() takes it).
//
// What the listener reports for each accepted client, and how the token read
// answers, come from the JSON file named by WMUX_FAKE_PIPE_CONTROL, read at
// each accept:
//   peer       fields of NativePipePeer, over a default same-session peer
//   facts      the token facts; null never answers (the broker's wait ends)
//   owner      what nativePipeOwnedByUs answers ('none' by default)
//   listenError  a code the broker's own listener throws with at construction
//   failNow    true: the listener reports a failure at the next accept
// The broker's self-check (a name with "-pc-") always reads this process,
// as this user.
import fs from 'node:fs';
import net from 'node:net';

function control() {
  const file = process.env.WMUX_FAKE_PIPE_CONTROL;
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const SAME_USER_FACTS = { ok: true, sameUser: true, integrityRid: 0x2000, elevated: false };

class FakeConn {
  constructor(socket, notify, peer, facts) {
    this.socket = socket;
    this.notify = notify;
    this.peerInfo = peer;
    this.facts = facts;
    this.chunks = [];
    this.eof = false;
    this.wantRead = false;
    this.max = 0;
    this.ready = null;
    this.readsDone = 0;
    this.nextId = 1;
    this.done = [];
    this.err = null;
    this.isClosed = false;
    this.factsPending = false;
    this.factsReady = null;
    socket.on('data', (data) => {
      this.chunks.push(data);
      this.fill();
    });
    socket.on('end', () => {
      this.eof = true;
      this.fill();
    });
    socket.on('close', () => {
      this.eof = true;
      this.fill();
    });
    socket.on('error', () => {
      this.eof = true;
      this.fill();
    });
  }

  wake() {
    setImmediate(this.notify);
  }

  peer() {
    return this.peerInfo;
  }

  requestRead(max) {
    if (this.wantRead || this.ready !== null) throw new Error('a read is already outstanding');
    this.wantRead = true;
    this.max = max;
    this.fill();
  }

  fill() {
    if (!this.wantRead) return;
    if (this.chunks.length > 0) {
      const all = Buffer.concat(this.chunks);
      this.ready = Buffer.from(all.subarray(0, this.max));
      this.chunks = all.length > this.max ? [all.subarray(this.max)] : [];
    } else if (this.eof) {
      this.ready = 'eof';
    } else {
      return;
    }
    this.wantRead = false;
    this.readsDone++;
    this.wake();
  }

  takeRead() {
    const read = this.ready;
    this.ready = null;
    return read;
  }

  write(data) {
    const id = this.nextId++;
    this.socket.write(Buffer.from(data), (error) => {
      if (error) this.err = error.message;
      else this.done.push(id);
      this.wake();
    });
    return id;
  }

  takeWritten() {
    const done = this.done;
    this.done = [];
    return done;
  }

  error() {
    return this.err;
  }

  end() {
    this.socket.end(() => {
      this.isClosed = true;
      this.wake();
    });
  }

  closed() {
    return this.isClosed;
  }

  destroy() {
    this.socket.destroy();
    this.isClosed = true;
  }

  requestTokenFacts() {
    if (this.factsPending) return;
    this.factsPending = true;
    if (this.readsDone === 0) {
      this.answer({ ok: false, reason: 'no-read-yet' });
      return;
    }
    if (this.facts === null) return;
    this.answer(this.facts);
  }

  answer(facts) {
    setImmediate(() => {
      this.factsPending = false;
      this.factsReady = facts;
      this.wake();
    });
  }

  takeTokenFacts() {
    const facts = this.factsReady;
    this.factsReady = null;
    return facts;
  }
}

class NativePipeListener {
  constructor(name, maxInstances, notify) {
    const selfCheck = name.includes('-pc-');
    const first = control();
    if (!selfCheck && first.listenError) {
      const error = new Error(`fake listener: ${first.listenError}`);
      error.code = first.listenError;
      throw error;
    }
    this.queue = [];
    this.notify = notify;
    this.failed = null;
    this.server = net.createServer((socket) => {
      const c = control();
      const peer = selfCheck
        ? { pid: process.pid, sessionId: 1, sameSession: true, sameUser: true, integrityRid: 0x2000, created: Date.now(), ppid: process.ppid, reason: null }
        : { pid: 0, sessionId: 1, sameSession: true, sameUser: true, integrityRid: 0x2000, created: Date.now(), ppid: null, reason: null, ...c.peer };
      const facts = selfCheck ? SAME_USER_FACTS : (c.facts === undefined ? SAME_USER_FACTS : c.facts);
      this.queue.push(new FakeConn(socket, notify, peer, facts));
      if (!selfCheck && c.failNow) this.failed = 'fake listener failure';
      setImmediate(notify);
    });
    this.server.maxConnections = maxInstances + 1;
    this.server.listen(name);
  }

  takeAccepted() {
    return this.queue.shift() ?? null;
  }

  failure() {
    return this.failed;
  }

  close() {
    this.server.close();
  }
}

export const nativeCoreAbiVersion = () => 1;
export const nativeCoreCapabilities = () => ['pipe-listener-v1', 'pipe-listener-v2'];
export const nativeTransportWorkerCount = () => 0;
export const nativePipeOwnedByUs = () => control().owner ?? 'none';
export { NativePipeListener };
