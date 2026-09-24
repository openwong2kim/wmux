// wmux-managed: opencode-terminal-chat
// Independently implemented against @opencode-ai/plugin 1.18.32's TUI API.
// Runs INSIDE the existing TUI. No server/session/model process is started.
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const str = x => typeof x === 'string' ? x : '';
const textBody = text => ({ n: 1, bytes: Buffer.byteLength(text), inline: text.slice(0, 4000), ...(text.length > 4000 ? { truncated: true } : {}) });
export function projectTuiMessages(api, sessionId) {
  const events = [];
  let truncated = false;
  const messages = api.state.session.messages(sessionId).slice(-300);
  for (const message of messages) {
    if (message.sessionID !== sessionId || !['user', 'assistant'].includes(message.role)) continue;
    const parts = api.state.part(message.id);
    truncated ||= parts.length > 128;
    for (const part of parts.slice(-128)) {
      if (part.sessionID !== sessionId || part.messageID !== message.id || typeof part.id !== 'string') continue;
      const base = { id: part.id, ts: message.time?.created };
      if (part.type === 'text' || part.type === 'reasoning') {
        if (part.synthetic || part.ignored) continue;
        const text = str(part.text);
        events.push({ ...base, kind: message.role === 'user' ? 'user_text' : 'assistant_text', text: text.slice(0, 8000),
          ...(text.length > 8000 ? { truncated: true } : {}), ...(part.type === 'reasoning' ? { thinking: true } : {}) });
      } else if (part.type === 'tool' && message.role === 'assistant') {
        const state = part.state ?? {};
        const input = JSON.stringify(state.input ?? {});
        events.push({ ...base, kind: 'tool_use', toolUseId: part.id, name: str(part.tool), argSummary: input.replace(/\s+/g, ' ').slice(0, 120), input: textBody(input) });
        if (['completed', 'error'].includes(state.status)) {
          const output = str(state.output ?? state.error);
          events.push({ ...base, id: `${part.id}:result`, kind: 'tool_result', toolUseId: part.id,
            ok: state.status === 'completed', bytes: Buffer.byteLength(output), output: textBody(output) });
        }
      }
    }
  }
  if (events.length > 2000) truncated = true;
  let retained = events.slice(-2000);
  // Keep the IPC budget below the daemon's shared control-pipe frame limit.
  while (retained.length && Buffer.byteLength(JSON.stringify(retained)) > 96000) retained = retained.slice(Math.max(1, Math.floor(retained.length / 8)));
  return { events: retained, truncated: truncated || retained.length !== events.length || messages.length >= 300 };
}

/** Exported separately for protocol/identity tests without opening a socket. */
export function terminalChatHandler(api, epoch = randomBytes(16).toString('hex')) {
  const requests = new Map();
  const pending = new Map();
  let selected;
  let generation = 0;
  const current = () => {
    const route = api.route.current;
    const id = route.name === 'session' ? str(route.params?.sessionID) : '';
    if (selected !== id) { selected = id; generation++; }
    const session = id && api.state.session.get(id);
    if (!api.state.ready || !session || session.id !== id) return undefined;
    const blocked = api.ui.dialog.open || api.state.session.permission(id).length > 0 || api.state.session.question(id).length > 0;
    const busy = ['busy', 'retry'].includes(api.state.session.status(id)?.type);
    const dispatch = pending.get(id);
    if (dispatch) {
      dispatch.sawBusy ||= busy;
      const completed = api.state.session.messages(id).some(message =>
        message.role === 'assistant' && message.time?.completed && !dispatch.messages.has(message.id));
      if (!dispatch.sending && !busy && (dispatch.sawBusy || completed)) pending.delete(id);
    }
    return { id, phase: blocked ? 'awaiting_input' : busy || pending.has(id) ? 'running' : 'complete', epoch: `${epoch}:${generation}:${id}` };
  };
  return async request => {
    const state = current();
    if (!state) return { available: false, reason: 'stale-session' };
    if (request.action === 'read') return { available: true, sessionId: state.id, phase: state.phase, epoch: state.epoch, ...projectTuiMessages(api, state.id) };
    if (request.action !== 'send') throw new Error('Unsupported operation');
    if (request.sessionId !== state.id || request.epoch !== state.epoch) return { result: 'session_changed' };
    const text = str(request.text);
    const requestId = str(request.requestId);
    if (!text.trim() || text.length > 16000 || !/^[a-zA-Z0-9-]{16,128}$/.test(requestId)) return { result: 'error' };
    const fingerprint = createHash('sha256').update(JSON.stringify([state.id, text])).digest('hex');
    const previous = requests.get(requestId);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : { result: 'session_changed' };
    if (state.phase === 'awaiting_input') return { result: 'blocked' };
    if (state.phase === 'running') return { result: 'busy' };
    // Refuse when full rather than evict a receipt and make a replay executable.
    if (requests.size >= 512) return { result: 'unavailable' };
    const record = { fingerprint, result: { result: 'unconfirmed' } };
    requests.set(requestId, record);
    // HTTP acceptance can precede the TUI's busy event. Keep an admission
    // fence until native completion is observed; elapsed time is not proof.
    const dispatch = { sending: true, sawBusy: false,
      messages: new Set(api.state.session.messages(state.id).map(message => message.id)) };
    pending.set(state.id, dispatch);
    try {
      // Use THIS TUI's client and selected native session. Native events update
      // its screen as well as Chat. Local composer drafts remain untouched.
      await api.client.session.promptAsync({ sessionID: state.id, parts: [{ type: 'text', text }] }, { throwOnError: true });
      record.result = { result: 'sent' };
    } catch { /* Dispatch may have succeeded; never retry it here. */ }
    finally { dispatch.sending = false; }
    return record.result;
  };
}

export async function tui(api) {
  const ptyId = process.env.WMUX_PTY_ID;
  if (!ptyId || !api.route || !api.state?.session || !api.client?.session?.promptAsync || !api.lifecycle?.onDispose) return;
  const directory = join(homedir(), `.wmux${process.env.WMUX_DATA_SUFFIX || ''}`, 'terminal-chat');
  const file = join(directory, `${createHash('sha256').update(ptyId).digest('hex')}.json`);
  const token = randomBytes(32).toString('hex');
  const handler = terminalChatHandler(api, token.slice(0, 32));
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (req, res) => {
    const authorization = str(req.headers.authorization);
    const expected = `Bearer ${token}`;
    if (req.method !== 'POST' || req.url !== '/' || req.headers.origin || !/^Bearer [0-9a-f]{64}$/.test(authorization) ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) { res.writeHead(403); res.end(); return; }
    let bytes = 0; const chunks = [];
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 24000) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      void (async () => {
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString());
          const result = await handler(request);
          if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); }
        } catch { if (!res.destroyed) { res.writeHead(400); res.end(); } }
      })();
    });
  });
  server.maxConnections = 8;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.on('error', () => { server.close(); });
  const address = server.address();
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, agent: 'opencode', pid: process.pid, port: address.port, token }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch { server.close(); return; }
  api.lifecycle.onDispose(() => {
    server.closeAllConnections(); server.close();
    // A newer process may already own the pane's descriptor: leave cleanup to
    // the daemon's PID check instead of unlinking another process's binding.
  });
}
export default { id: 'wmux-terminal-chat', tui };
