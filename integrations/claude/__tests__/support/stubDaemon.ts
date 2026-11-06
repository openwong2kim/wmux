/**
 * A stand-in for the daemon or main pipe, for driving wmux-bridge.mjs end to
 * end. It listens on a unix socket (POSIX) or a named pipe (Windows), records
 * every request line it reads, and answers in one of a few ways the real
 * servers (DaemonPipeServer, PipeServer) can:
 *
 *   reply            read the whole line, then write `lines` (templated: the
 *                    string "$ID" becomes the request id)
 *   reply-early      write the reply as soon as the request id has arrived and
 *                    stop reading: the rest of the request stays unread
 *   reply-early-close the same, then destroy the socket at once (the servers
 *                    destroy after an error reply)
 *   close-after-read read the whole line, then end the socket with no reply
 *   hold             read the whole line and never answer
 *   over-long        what both servers do with a line over 1 MiB: destroy the
 *                    socket once the unterminated tail passes the limit
 *   reset            accept, then destroy the socket at once, reading nothing
 */
import { createServer, type Server, type Socket } from 'node:net';

export const SERVER_MAX_LINE = 1024 * 1024;

export type StubLine = unknown;

export type StubBehaviour =
  | { mode: 'reply'; lines: StubLine[] }
  | { mode: 'reply-early' | 'reply-early-close'; lines: StubLine[] }
  | { mode: 'close-after-read' }
  | { mode: 'hold' }
  | { mode: 'over-long' }
  | { mode: 'reset' };

/** What one connection delivered. `request` is the parsed line, when whole. */
export interface StubConnection {
  request?: unknown;
  /** reply-early*: the id it answered, and whether the newline had arrived by then. */
  answeredEarly?: { id: string; sawNewline: boolean };
  /** over-long: the socket was destroyed past the limit. */
  destroyedOverLong?: boolean;
  /** reset: accepted and destroyed unread. */
  reset?: boolean;
}

export interface StubDaemon {
  connections: StubConnection[];
  close(): Promise<void>;
}

function render(line: StubLine, id: string): string {
  const text = typeof line === 'object' && line !== null && 'raw' in line
    ? String((line as { raw: unknown }).raw)
    : JSON.stringify(line, (_key, value) => (value === '$ID' ? id : value));
  return `${text}\n`;
}

export function startStubDaemon(endpoint: string, behaviour: StubBehaviour): Promise<StubDaemon> {
  const connections: StubConnection[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* the bridge destroys its end freely */ });
    const record: StubConnection = {};
    connections.push(record);
    if (behaviour.mode === 'reset') {
      record.reset = true;
      socket.destroy();
      return;
    }
    let text = '';
    let done = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (done) return;
      text += chunk;
      if (behaviour.mode === 'reply-early' || behaviour.mode === 'reply-early-close') {
        const match = /^\{"id":"([^"]+)"/.exec(text);
        if (!match) return;
        done = true;
        record.answeredEarly = { id: match[1], sawNewline: text.includes('\n') };
        const reply = behaviour.lines.map((line) => render(line, match[1])).join('');
        if (behaviour.mode === 'reply-early-close') {
          socket.write(reply, () => socket.destroy());
        } else {
          socket.pause();
          socket.write(reply);
        }
        return;
      }
      const nl = text.indexOf('\n');
      if (behaviour.mode === 'over-long' && (nl === -1 ? text.length : nl) > SERVER_MAX_LINE) {
        done = true;
        record.destroyedOverLong = true;
        socket.destroy();
        return;
      }
      if (nl === -1) return;
      done = true;
      const line = text.slice(0, nl);
      try {
        record.request = JSON.parse(line);
      } catch {
        record.request = { unparsable: line.length };
      }
      const id = (record.request as { id?: unknown })?.id;
      if (behaviour.mode === 'reply') {
        socket.write(behaviour.lines.map((l) => render(l, typeof id === 'string' ? id : '')).join(''));
      } else if (behaviour.mode === 'close-after-read') {
        socket.end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      resolve({
        connections,
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
