# How to connect to wmux

> **Goal:** open an authenticated JSON-RPC socket to a running wmux daemon, from
> either an in-pane process or an external terminal, on Windows or POSIX.

Assumes you can run Node ≥ 18 and a wmux instance is already running. The full
security model is in [`PROTOCOL.md` §5](../PROTOCOL.md#5-named-pipe-security-model);
this recipe is the wire mechanics.

## Steps

1. **Resolve the auth token.** Two sources, in priority order:
   - If your process was spawned *inside* a wmux pane, the token is in the
     `WMUX_AUTH_TOKEN` environment variable (injected by `PTYManager` — see
     `ENV_KEYS` in `src/shared/constants.ts`). Use it directly.
   - Otherwise (external terminal — `cmd`, Windows Terminal, VS Code, SSH), read
     the token file at `~/.wmux-auth-token`. It is a bare UUID string, **not**
     JSON — do not `JSON.parse` it; just `.trim()`.

2. **Resolve the endpoint.** Also two sources:
   - In-pane: `WMUX_SOCKET_PATH` env var points at the live socket.
   - External: derive the platform default. On Windows it is the named pipe
     `\\.\pipe\wmux-<username>` where `<username>` is `os.userInfo().username`
     (falling back to `default`). On POSIX it is the Unix domain socket
     `<homedir>/.wmux.sock`. `net.connect()` accepts either string directly.

3. **Connect, with the Windows TCP fallback.** On Windows the named pipe can
   reject with `EPERM` (elevated/non-elevated mismatch) or `ENOENT`. When it
   does, read the port number from `~/.wmux-tcp-port` (a bare integer) and
   connect to `127.0.0.1:<port>` instead. The daemon only runs this fallback
   listener on Windows.

4. **Frame requests as newline-delimited JSON.** One JSON object per line,
   terminated by `\n`. Request shape:
   `{ id, method, params, token, clientName?, clientVersion? }`. Buffer incoming
   bytes, split on `\n`, `JSON.parse` each complete line, and correlate replies
   to requests by `id`. Reply shape is `{ id, ok: true, result }` or
   `{ id, ok: false, error, rejection? }`.

5. **Authenticate on every request.** There is no separate login step — the
   `token` field rides every request. The daemon checks it with a constant-time
   compare; a request with a missing or wrong token gets one
   `{ ok: false, error: "unauthorized" }` line and then the socket is destroyed.
   Reconnect and retry with the correct token.

## Code

A minimal standalone variant of the connection logic in
[`examples/event-recorder/wmux-rpc.mjs`](../../examples/event-recorder/wmux-rpc.mjs).
It is self-contained and runnable, but its API does **not** match that module:
the real `wmux-rpc.mjs` exports an `async connect(opts)` that resolves to a
`WmuxClient` whose `client.rpc(method, params)` takes two arguments. The inline
helper below is a deliberately stripped-down illustration of the wire mechanics,
not a drop-in for the module:

```js
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const home = () => process.env.USERPROFILE || process.env.HOME || os.homedir();
function endpoint() {
  if (process.env.WMUX_SOCKET_PATH) return process.env.WMUX_SOCKET_PATH;
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-${os.userInfo().username || 'default'}`;
  return `${os.homedir()}/.wmux.sock`;
}
function loadToken() {
  if (process.env.WMUX_AUTH_TOKEN) return process.env.WMUX_AUTH_TOKEN.trim();
  return fs.readFileSync(`${home()}/.wmux-auth-token`, 'utf8').trim();
}
function tcpFallback() { // Windows EPERM/ENOENT path
  try { const p = Number(fs.readFileSync(`${home()}/.wmux-tcp-port`, 'utf8').trim()); if (p > 0) return { host: '127.0.0.1', port: p }; } catch {}
  return null;
}

export function connect() {
  const token = loadToken();
  const sock = net.connect(endpoint());
  const pending = new Map(); // id -> {resolve, reject}
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    }
  });
  function rpc(method, params = {}, clientName) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sock.write(JSON.stringify({ id, method, params, token, clientName }) + '\n');
    });
  }
  return { sock, rpc };
}
```

The example above connects to the named pipe / socket only. To add the Windows
TCP fallback, retry `net.connect(tcpFallback())` inside the socket's `'error'`
handler when `err.code` is `EPERM` or `ENOENT` and `tcpFallback()` is non-null.

> **Fallback caveat:** `~/.wmux-tcp-port` is removed only on clean daemon
> shutdown. After a crash — or when wmux simply isn't running (`ENOENT`) — a
> stale file can linger, and a client following it would hand the auth token
> to whatever local process now owns that loopback port. Fine under wmux's
> single-user threat model; on shared machines prefer the named pipe and
> treat the port file as advisory.

## Pitfalls

- **The token file is a UUID, not JSON.** `JSON.parse` on it throws. Read it as
  UTF-8 and `.trim()`.
- **Endpoint and token must match the same wmux user.** Both are derived from
  the OS user; you cannot read user A's token and connect to user B's pipe.
- **`clientName` is becoming required.** A request with no `clientName` is
  recorded as `legacy` and grandfathered through the permission gate — but the
  grandfather closes in the first release on or after **2026-09-30** (#1111),
  and from that release such a request is refused. Sending a `clientName` opts
  you into the identity + declaration flow — see
  [react-to-events](./react-to-events.md) and `PROTOCOL.md` §4. Send one now.
- **One reply per `id`; correlate, don't assume order.** Replies can interleave
  if you have multiple in-flight requests. Match on `id`.
- **Caps you can hit:** `MAX_CONNECTIONS = 50` concurrent sockets per daemon;
  50 RPC/s per socket (returns `{ ok: false, error: "rate limited" }`) and
  200 RPC/s global (returns `{ ok: false, error: "rate limited (global)" }`) —
  the two strings differ, so match with `startsWith('rate limited')` rather
  than exact equality; neither closes the socket. 30 new connections/s
  pre-auth (excess sockets are destroyed); 1 MB max unframed line buffer (a
  client that never sends `\n` is disconnected). Open one long-lived socket
  and reuse it rather than reconnecting per call.
- **Unauthorized destroys the socket.** A wrong token does not just error — the
  daemon closes the connection. Reconnect after fixing the token.

## See also

- [`PROTOCOL.md` §5](../PROTOCOL.md#5-named-pipe-security-model) — token auth, connection cap, why the pipe DACL is not tightened.
- [`examples/event-recorder/wmux-rpc.mjs`](../../examples/event-recorder/wmux-rpc.mjs) — the reference connection client (`async connect(opts) → WmuxClient`, `client.rpc(method, params)`); the inline snippet above is a simplified standalone variant, not the same API.
- [Build a substrate plugin](../tutorials/build-a-substrate-plugin.md) — the guided end-to-end lesson.
