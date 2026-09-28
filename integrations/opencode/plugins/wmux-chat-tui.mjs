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

const DECISIONS_MAX = 16;
const LIMITS = { permission: 64, patterns: 8, pattern: 400, questions: 8, question: 1000, header: 60, options: 16, label: 200 };
const list = value => Array.isArray(value) ? value : [];
/** What a request asks, whole: an answer re-checks it right before it is sent. */
const requestDigest = (kind, request) => createHash('sha256').update(JSON.stringify(kind === 'permission'
  ? [kind, str(request.permission), list(request.patterns).map(str)]
  : [kind, list(request.questions).map(q => [str(q?.question), str(q?.header), q?.multiple === true, q?.custom !== false,
    list(q?.options).map(o => str(o?.label))])])).digest('hex').slice(0, 32);
/**
 * A pending permission or question. `always` is never offered. `truncated`
 * when any of it does not fit the bounds as it is (a long label, too many
 * questions): the daemon then makes no answerable form of it.
 */
function projectDecision(kind, request) {
  const base = { kind, requestId: request.id, sessionId: request.sessionID, digest: requestDigest(kind, request) };
  if (kind === 'permission') {
    const patterns = list(request.patterns).map(str);
    const truncated = str(request.permission).length > LIMITS.permission || patterns.length > LIMITS.patterns ||
      patterns.some(p => p.length > LIMITS.pattern);
    return { ...base, permission: str(request.permission).slice(0, LIMITS.permission),
      patterns: patterns.slice(0, LIMITS.patterns).map(p => p.slice(0, LIMITS.pattern)), ...(truncated ? { truncated: true } : {}) };
  }
  const questions = list(request.questions);
  let truncated = questions.length === 0 || questions.length > LIMITS.questions;
  const projected = questions.slice(0, LIMITS.questions).map(q => {
    const options = list(q?.options).map(o => str(o?.label));
    truncated ||= str(q?.question).length > LIMITS.question || str(q?.header).length > LIMITS.header ||
      options.length > LIMITS.options || options.some(label => !label.trim() || label.length > LIMITS.label);
    return { question: str(q?.question).slice(0, LIMITS.question), header: str(q?.header).slice(0, LIMITS.header),
      multiple: q?.multiple === true, custom: q?.custom !== false,
      options: options.slice(0, LIMITS.options).map(label => ({ label: label.slice(0, LIMITS.label) })) };
  });
  return { ...base, questions: projected, ...(truncated ? { truncated: true } : {}) };
}
/**
 * Option indexes (and a typed answer) back to OpenCode's own labels, or null
 * when the answer does not fit the question as it is now.
 */
function answerLabels(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) return null;
  const out = [];
  for (const [index, answer] of answers.entries()) {
    const question = questions[index];
    const options = list(question?.options);
    const picks = Array.isArray(answer?.options) ? answer.options : null;
    if (!picks || new Set(picks).size !== picks.length ||
        !picks.every(i => Number.isInteger(i) && i >= 0 && i < options.length && str(options[i]?.label))) return null;
    const labels = picks.map(i => str(options[i].label));
    if (answer.other !== undefined) {
      if (question?.custom === false || typeof answer.other !== 'string' || !answer.other.trim() || answer.other.length > 2000) return null;
      labels.push(answer.other);
    }
    if (labels.length === 0 || labels.length > (question?.multiple === true ? options.length + 1 : 1)) return null;
    out.push(labels);
  }
  return out;
}
/** The server's own answer: 404 is the request already gone, any other refusal
 *  changed nothing; a call with no answer may still have reached it. */
const settled = async call => {
  try {
    const answer = await call();
    const status = answer?.response?.status;
    if (status === 404) return 'not_found';
    if (typeof status === 'number' && (status < 200 || status > 299)) return 'refused';
    return answer?.error === undefined || answer?.error === null ? 'ok' : 'refused';
  } catch { return 'unconfirmed'; }
};

// The daemon refuses request ids whose time prefix is 24 h old, and accepts a
// prefix up to 60 s ahead of its clock. The margin keeps a receipt until no
// such id can still be accepted.
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;

/** Exported separately for protocol/identity tests without opening a socket. */
export function terminalChatHandler(api, epoch = randomBytes(16).toString('hex')) {
  const requests = new Map();
  const pending = new Map();
  let selected;
  let generation = 0;
  // Running episodes per session: the id is minted once on idle -> running
  // (an accepted send or the first busy observation) and held until the
  // session is seen complete. Messages arriving mid-turn never change it.
  const turns = new Map();
  let turnSeq = 0;
  // Sessions seen asking or being created, so a route's direct children can be
  // found: the TUI state has no session list. Each is re-checked by parentID.
  // Full, it lets go of the oldest session holding no request; never a live one.
  const seen = new Set();
  const see = id => {
    if (typeof id !== 'string' || !id || seen.has(id)) return;
    if (seen.size >= 2048) { for (const old of seen) if (!pendingOn(old)) { seen.delete(old); break; } }
    seen.add(id);
  };
  for (const type of ['session.created', 'permission.asked', 'question.asked']) {
    try { api.event?.on?.(type, event => { const p = event?.properties ?? {}; see(p.sessionID ?? p.info?.id); }); } catch { /* No event bus: own-session requests only. */ }
  }
  const parentOf = id => str(api.state.session.get(id)?.parentID);
  // Children the route's own task calls started: found after a TUI restart
  // too, when no event announced them to this process.
  const taskChildren = id => {
    const found = [];
    for (const message of api.state.session.messages(id).slice(-300)) {
      if (message.role !== 'assistant') continue;
      for (const part of api.state.part(message.id)) {
        const child = part?.type === 'tool' && part.tool === 'task' ? str(part.state?.metadata?.sessionId) : '';
        if (child) found.push(child);
      }
    }
    return found;
  };
  // What the TUI draws on route R: R's own requests and its direct children's.
  // A child route draws none; a grandchild is not a direct child.
  const visibleSessions = id => parentOf(id) ? [] :
    [id, ...new Set([...seen, ...taskChildren(id)].filter(child => child !== id && parentOf(child) === id))];
  const pendingOn = id => api.state.session.permission(id).length > 0 || api.state.session.question(id).length > 0;
  const openTurn = (id, at) => {
    const turn = { id: `t1:oc.${createHash('sha256').update(JSON.stringify([epoch, id, ++turnSeq])).digest('hex').slice(0, 24)}`, open: true, startedAt: at };
    turns.set(id, turn);
    return turn;
  };
  const current = () => {
    const route = api.route.current;
    const id = route.name === 'session' ? str(route.params?.sessionID) : '';
    if (selected !== id) { selected = id; generation++; }
    const session = id && api.state.session.get(id);
    if (!api.state.ready || !session || session.id !== id) return undefined;
    // A direct child's permission is drawn on this route and blocks it too.
    const prompt = pendingOn(id) || visibleSessions(id).some(pendingOn);
    // A picker or palette the user opened is not the agent waiting: it never
    // changes phase (or the phone's blocked state); only send holds for it.
    const dialog = !!api.ui.dialog.open;
    const busy = ['busy', 'retry'].includes(api.state.session.status(id)?.type);
    const dispatch = pending.get(id);
    if (dispatch) {
      dispatch.sawBusy ||= busy;
      const completed = api.state.session.messages(id).some(message =>
        message.role === 'assistant' && message.time?.completed && !dispatch.messages.has(message.id));
      if (!dispatch.sending && !busy && (dispatch.sawBusy || completed)) pending.delete(id);
    }
    // Admission fence: a send was accepted but the TUI has not gone busy yet.
    // There is nothing native to abort yet.
    const fence = !busy && pending.has(id);
    const phase = prompt ? 'awaiting_input' : busy || pending.has(id) ? 'running' : 'complete';
    let turn = turns.get(id);
    if (busy || pending.has(id)) { if (!turn?.open) turn = openTurn(id, Date.now()); }
    else if (phase === 'complete' && turn) turn.open = false;
    // Before the first episode: an idle id with no start.
    if (!turn) { turn = openTurn(id, undefined); turn.open = false; }
    return { id, phase, epoch: `${epoch}:${generation}:${id}`, busy, prompt, dialog, fence, turnId: turn.id,
      ...(turn.startedAt !== undefined ? { turnStartedAt: turn.startedAt } : {}) };
  };
  const actions = typeof api.client?.session?.abort === 'function' ? ['read', 'send', 'abort'] : ['read', 'send'];
  if (typeof api.client?.permission?.reply === 'function' && typeof api.client?.question?.reply === 'function' &&
      typeof api.client?.question?.reject === 'function') actions.push('decisions');
  const listed = (kind, sessionId) => kind === 'permission' ? api.state.session.permission(sessionId) : api.state.session.question(sessionId);
  // Decisions answer the request where it lives, whatever the route shows now:
  // a route switch between the phone's read and its answer must not misdirect it.
  const decisions = async request => {
    if (!api.state.ready) return { available: false, reason: 'not-ready' };
    if (request.action === 'decisions.read') {
      const route = api.route.current;
      const id = route.name === 'session' ? str(route.params?.sessionID) : '';
      const found = [];
      for (const sessionId of id ? visibleSessions(id) : []) {
        for (const kind of ['permission', 'question']) {
          for (const item of listed(kind, sessionId)) if (item?.sessionID === sessionId && typeof item.id === 'string') found.push(projectDecision(kind, item));
        }
      }
      // Of the requests the daemon holds, the ones their own session no longer lists.
      const known = Array.isArray(request.known) ? request.known.slice(0, 64) : [];
      const gone = known.filter(k => typeof k?.requestId === 'string' && typeof k.sessionId === 'string' &&
        !['permission', 'question'].some(kind => listed(kind, k.sessionId).some(item => item?.id === k.requestId))).map(k => k.requestId);
      return { available: true, sessionId: id, decisions: found.slice(0, DECISIONS_MAX), gone };
    }
    const requestId = str(request.requestId); const sessionId = str(request.sessionId);
    if (!requestId || !sessionId || !['permission', 'question'].includes(request.kind)) return { result: 'error' };
    // A root session or a root's direct child: the only ones a TUI draws.
    const parent = parentOf(sessionId);
    if (!api.state.session.get(sessionId) || parent && parentOf(parent)) return { result: 'not_found' };
    const item = listed(request.kind, sessionId).find(entry => entry?.id === requestId);
    if (!item) return { result: 'not_found' };
    // The same id asking something else now: the card the phone showed is stale.
    if (request.digest !== requestDigest(request.kind, item)) return { result: 'changed' };
    if (request.kind === 'permission') {
      // `always` would widen what the agent may do without asking again.
      if (!['once', 'reject'].includes(request.reply)) return { result: 'refused' };
      return { result: await settled(() => api.client.permission.reply({ requestID: requestId, reply: request.reply })) };
    }
    if (request.reject === true) return { result: await settled(() => api.client.question.reject({ requestID: requestId })) };
    const answers = answerLabels(list(item.questions), request.answers);
    if (!answers) return { result: 'refused' };
    return { result: await settled(() => api.client.question.reply({ requestID: requestId, answers })) };
  };
  return async request => {
    if (actions.includes('decisions') && (request.action === 'decisions.read' || request.action === 'decisions.reply')) return decisions(request);
    const state = current();
    if (!state) return { available: false, reason: 'stale-session' };
    if (request.action === 'read') {
      return { available: true, sessionId: state.id, phase: state.phase, epoch: state.epoch, actions, turnId: state.turnId,
        ...(state.turnStartedAt !== undefined ? { turnStartedAt: state.turnStartedAt } : {}), ...projectTuiMessages(api, state.id) };
    }
    if (request.action === 'abort' && actions.includes('abort')) {
      // The same selected-session and generation checks as send.
      if (request.sessionId !== state.id || request.epoch !== state.epoch) return { result: 'session_changed' };
      const answer = result => ({ result, turnId: state.turnId, phase: state.phase });
      if (request.turnId !== undefined && request.turnId !== state.turnId) return answer('not_running');
      // Only the agent's own permission or question is a prompt; a picker or
      // palette the user opened does not stop an abort.
      if (state.prompt) return answer('prompt_active');
      if (state.fence) return answer('pending');
      if (!state.busy) return answer('not_running');
      try {
        await api.client.session.abort({ sessionID: state.id }, { throwOnError: true });
        return answer('sent');
      } catch { return answer('unconfirmed'); /* The abort may have reached the server. */ }
    }
    if (request.action !== 'send') throw new Error('Unsupported operation');
    if (request.sessionId !== state.id || request.epoch !== state.epoch) return { result: 'session_changed' };
    const text = str(request.text);
    const requestId = str(request.requestId);
    if (!text.trim() || text.length > 16000 || !/^[a-zA-Z0-9-]{16,128}$/.test(requestId)) return { result: 'error' };
    const fingerprint = createHash('sha256').update(JSON.stringify([state.id, text])).digest('hex');
    const previous = requests.get(requestId);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : { result: 'session_changed' };
    if (state.phase === 'awaiting_input' || state.dialog) return { result: 'blocked' };
    if (state.phase === 'running') return { result: 'busy' };
    // A receipt past the retention can never be replayed: drop it.
    if (requests.size >= 512) {
      const oldest = Date.now() - RECEIPT_RETENTION_MS;
      for (const [id, receipt] of requests) if (receipt.at <= oldest) requests.delete(id);
    }
    // Refuse when full rather than evict a younger receipt and make a replay
    // executable. `unavailable` keeps an older daemon reading it as a refusal.
    if (requests.size >= 512) return { result: 'unavailable', reason: 'receipts-full' };
    const record = { fingerprint, at: Date.now(), result: { result: 'unconfirmed' } };
    requests.set(requestId, record);
    // HTTP acceptance can precede the TUI's busy event. Keep an admission
    // fence until native completion is observed; elapsed time is not proof.
    const dispatch = { sending: true, sawBusy: false,
      messages: new Set(api.state.session.messages(state.id).map(message => message.id)) };
    pending.set(state.id, dispatch);
    // The turn starts when its prompt is accepted.
    openTurn(state.id, Date.now());
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
  // The epoch is minted independently: it is serialized to the daemon and must
  // not carry any part of the loopback bearer token.
  const handler = terminalChatHandler(api);
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
