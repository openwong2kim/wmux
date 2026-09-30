import {createServer} from 'node:http';
import {chmod,lstat,realpath,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer,type RawData} from 'ws';
import {CodexTuiSelectionTracker} from './codexTuiSelection';
import {connectCodexSettings} from './codexSettingsTransport';
import {classify,reviewClientFrame,threadIdsFromResponse,type PolicyContext} from './codexRelayPolicy';
import {codexDecisionFromRequest,type CodexDecisionAnswer,type CodexDecisionRequest} from './codexDecisions';

export class CodexRelayUnavailableError extends Error {
  constructor() {super('Codex account server is not ready');}
}

// Native app/read includes installed app metadata (~11 MiB observed).
// Keep transport bounds separate from the much smaller Chat display budget.
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
/** How long a request that needs the pane's identity waits for the pane to be
 * committed to this relay. A relay still unowned after that is torn down. */
const IDENTITY_WAIT_MS = 3000;
const IDENTITY_POLL_MS = 50;
/** Client frames held while one waits: past either bound the connection is dropped. */
const MAX_HELD_FRAMES = 64;
const MAX_TRACKED_REQUESTS = 256;
/** Server requests delivered to the client and still awaiting its answer;
 * past this the connection is closed rather than an entry being dropped. */
const MAX_PENDING_SERVER_REQUESTS = 256;
const isRequestId = (id:unknown):id is string|number => typeof id === 'string' || Number.isSafeInteger(id);
/** A server request id as a string key; a string id never collides with a numeric one. */
export const codexRequestKey = (id:string|number):string => typeof id === 'number' ? String(id) : `s:${id}`;
export type CodexDecisionSettledReason = 'answered-locally' | 'turn-ended' | 'pane-gone' | 'prompt-gone';
/** `uncertain`: written, but the server never confirmed that this answer took. */
export type CodexAnswerOutcome = 'ok' | 'not-found' | 'unavailable' | 'uncertain';
/** How long a phone's answer waits for the server to report the request resolved. */
const ANSWER_CONFIRM_MS = 5000;
/** Threads whose running turn the relay remembers, and ended turns kept for a cancel's later look. */
const MAX_ACTIVE_TURNS = 64;
/** Ended turns are kept at least this long (past a cancel's 15 s observation
 * window), and dropped oldest-first past the soft bound only once older than
 * it; the hard bound caps memory whatever their age. */
const ENDED_TURN_KEEP_MS = 60_000;
const MAX_ENDED_TURNS = 256;
const MAX_ENDED_TURNS_HARD = 1024;
/** A turn's final `status` on `turn/completed` (`completed`, `interrupted`, `failed`), verbatim. */
export type CodexTurnEnd = string;

/**
 * Deny-by-default request policy (codexRelayPolicy.ts). Without it the relay
 * forwards frames as they are; every pane relay wmux creates passes one.
 */
export interface CodexRelayPolicy {
  paneId: string;
  /** The pane's identity from the daemon's session record; undefined while unowned. */
  identity: () => Record<string,string> | undefined;
  serverProven: () => boolean;
  owner: PolicyContext['owner'];
  /** A server response gave this pane a thread. */
  recordOwner: (threadId:string) => void;
  refused?: (reason:string) => void;
  /** A client response was not forwarded: it answered no server request
   * pending on this connection. `count` is the total for the connection. */
  unmatchedResponse?: (count:number) => void;
  /** An approval a phone may answer (codexDecisions.ts) arrived for a thread
   * this pane owns. `requestId` is `codexRequestKey` of the server's id. */
  decisionPending?: (requestId:string, request:CodexDecisionRequest) => void;
  /** A request reported by `decisionPending` is over without `answer`. */
  decisionSettled?: (requestId:string, threadId:string, reason:CodexDecisionSettledReason) => void;
}

/** How a TUI coming back after its account server went away is re-attached:
 * the relay re-dials the server with a doubling delay from `baseMs` up to
 * `maxMs`, holding the TUI's frames, for at most `windowMs`. */
export interface CodexRelayReconnect {windowMs?:number; baseMs?:number; maxMs?:number}
const RECONNECT_WINDOW_MS = 30_000;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 4000;

/** An endpoint for one daemon-owned TUI. It never stops Codex's account
 * server; the pane lifecycle owns and must close this relay. When the server
 * goes away (a restart, an auto-update) the TUI's connection is ended and the
 * endpoint stays, so the TUI's own reconnect lands on a fresh server link. */
export async function createCodexTuiRelay(options:{codeHome?:string; onRequestMethod?:(method:string)=>void; onStateChange?:()=>void; policy?:CodexRelayPolicy; answerConfirmMs?:number;
  /** The server link of a connected TUI was lost; everything pinned to it (turns, requests) is gone. */
  onUpstreamLost?:()=>void;
  /** A re-dial after a loss failed: make sure a server runs (never restarts one). Must not throw. */
  ensureUpstream?:()=>Promise<void>;
  reconnect?:CodexRelayReconnect}) {
  const codeHome = options.codeHome ?? path.join(os.homedir(),'.codex');
  if (!path.isAbsolute(codeHome) || codeHome.includes('\0') || codeHome.includes(':')) throw new Error('Invalid Codex account scope');
  const upstreamPath = codexUpstreamPath(codeHome);
  await verifyUpstreamSocket(upstreamPath);
  // A socket inode alone does not prove a running/compatible account server.
  // Probe before publishing a TUI endpoint; never start or restart the server.
  try {
    const probe = await connectCodexSettings({codeHome,cwd:os.homedir()});
    probe.close();
  } catch {throw new CodexRelayUnavailableError();}
  const directory = await mkdtemp(path.join(os.tmpdir(),'wmux-tui-'));
  const socketPath = path.join(directory,'tui.sock');
  const tracker = new CodexTuiSelectionTracker();
  const server = createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:5000,keepAliveTimeout:1000},(_req,res)=>{res.writeHead(404);res.end();});
  server.maxConnections = 4;
  const wss = new WebSocketServer({noServer:true,maxPayload:MAX_FRAME,perMessageDeflate:false});
  const sockets = new Set<WebSocket>();
  let claimed = false;
  let retired = false;
  // The last connection lost its server link: the next one is the TUI coming back.
  let upstreamLost = false;
  const redials = new Set<NodeJS.Timeout>();
  let closing:Promise<void> | undefined;
  // The live connection's phone-answer path; none before a TUI connects.
  let answerOnConnection:((threadId:string,requestId:string,decision:CodexDecisionAnswer)=>Promise<CodexAnswerOutcome>) | undefined;
  // Turn identity as the pane's own stream reports it (`turn/started`,
  // `turn/completed`): thread -> its running turn, and recently ended turns
  // with their final status. Only this stream proves a turn ended; the
  // answer to a `turn/interrupt` never does.
  const activeTurns = new Map<string,string>();
  const endedTurns = new Map<string,{status:CodexTurnEnd; at:number}>();
  const turnWaiters = new Map<string,Set<(status:CodexTurnEnd | undefined)=>void>>();
  const turnKey = (threadId:string, turnId:string) => `${threadId}\n${turnId}`;
  const settleTurnWaiters = (key:string, status:CodexTurnEnd | undefined) => {
    const waiters = turnWaiters.get(key);
    if (!waiters) return;
    turnWaiters.delete(key);
    for (const resolve of waiters) resolve(status);
  };
  const close = ():Promise<void> => {
    if (closing) return closing;
    retired = true;
    tracker.close();
    activeTurns.clear();
    for (const key of [...turnWaiters.keys()]) settleTurnWaiters(key,undefined);
    try {options.onStateChange?.();} catch {/* Retiring cannot restore authority. */}
    for (const socket of sockets) socket.terminate();
    for (const timer of redials) clearTimeout(timer);
    redials.clear();
    closing = (async()=>{
      await new Promise<void>(resolve=>wss.close(()=>resolve()));
      if (server.listening) await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
      await rm(directory,{recursive:true,force:true});
    })();
    return closing;
  };
  server.on('upgrade',(request,socket,head)=>{
    if (retired || claimed || request.headers.origin || !['/','/rpc'].includes(request.url ?? '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    claimed = true;
    wss.handleUpgrade(request,socket,head,client=>wss.emit('connection',client));
  });
  wss.on('connection',client=>{
    sockets.add(client);
    // The TUI coming back after the server went away, rather than its first connection.
    const rejoining = upstreamLost;
    // False once this connection ended (`drop`) while the relay lives on:
    // nothing of it may act on the relay any more.
    let alive = true;
    // The server link opened at least once.
    let linked = false;
    let upstream:WebSocket | undefined;
    const queued:Buffer[] = [];
    let queuedBytes = 0;
    const retire = () => { void close().catch(()=> { /* noop */ }); };
    const send = (target:WebSocket,bytes:Buffer) => {
      if (!alive) return;
      if (retired || target.readyState !== WebSocket.OPEN || target.bufferedAmount + bytes.length > MAX_BUFFER) { retire();return; }
      target.send(bytes,{binary:false},error=>{if(error && alive)retire();});
    };
    const decode = (raw:RawData,binary:boolean):{bytes:Buffer;message:unknown}|undefined => {
      if (!alive) return;
      if (retired || binary) {retire();return;}
      const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
      if (bytes.length > MAX_FRAME) {retire();return;}
      try {return {bytes,message:JSON.parse(bytes.toString('utf8'))};}
      catch {retire();return;}
    };
    const forward = (bytes:Buffer) => {
      if(upstream?.readyState === WebSocket.OPEN)send(upstream,bytes);
      else if(queued.length < 64 && queuedBytes + bytes.length <= MAX_BUFFER) {
        queued.push(bytes);queuedBytes += bytes.length;
      } else retire();
    };
    const handleClient = (frame:{bytes:Buffer;message:unknown}) => {
      const before = JSON.stringify(tracker.current());
      tracker.fromTui(frame.message);
      if (before !== JSON.stringify(tracker.current())) {
        try {options.onStateChange?.();} catch {retire();return;}
      }
      if (frame.message && typeof frame.message === 'object' && 'method' in frame.message && typeof frame.message.method === 'string') {
        try {options.onRequestMethod?.(frame.message.method);} catch {retire();return;}
      }
      forward(frame.bytes);
    };
    const refuse = (message:unknown, reason:string) => {
      const id = message && typeof message === 'object' && !Array.isArray(message) ? (message as {id?:unknown}).id : undefined;
      try {options.policy?.refused?.(reason);} catch {/* A notice cannot change the refusal. */}
      if (typeof id === 'string' || typeof id === 'number') {
        send(client,Buffer.from(JSON.stringify({id,error:{code:-32603,message:`wmux: ${reason}; the request was not sent`}})));
      }
    };
    // Requests whose responses hand this pane a thread.
    const tracked = new Map<string|number,string>();
    // The relay forwards a client response only for a server request it
    // delivered to this client and that is still awaiting an answer
    // (request id -> thread id, when the request names one).
    const pendingServerRequests = new Map<string|number,string|undefined>();
    // The subset a phone may answer (codexRequestKey -> the server's own id and
    // its thread). `confirm` is set once the phone's answer was written: the
    // request then waits for the server to report it resolved.
    type Decision = {id:string|number; threadId:string; confirm?:(outcome:CodexAnswerOutcome)=>void};
    const decisions = new Map<string,Decision>();
    const settleDecision = (key:string, reason:CodexDecisionSettledReason) => {
      const decision = decisions.get(key);
      if (!decision) return;
      decisions.delete(key);
      if (decision.confirm) { decision.confirm('uncertain');return; }
      try {options.policy?.decisionSettled?.(key,decision.threadId,reason);} catch {/* A notice cannot change the outcome. */}
    };
    /**
     * The one frame the relay writes upstream on its own: the answer to a
     * server request that is still awaiting one on this connection, for a
     * thread this pane owns. It is a response — the server's own id, verbatim,
     * and nothing but `result.decision` — so it can answer nothing else. The
     * request stops being pending here, so the TUI's own later answer to the
     * same id is not forwarded.
     *
     * A written frame is not an answer that took: another client may have
     * answered first, and the server ignores a late answer without a word.
     * `ok` only when the server reports the request resolved after the write;
     * anything else (a write error, the turn ending, the connection closing,
     * no word in time) is `uncertain`, and the record is settled so no card
     * is left up for a request nobody can answer from here any more.
     */
    const answerHere = async (threadId:string, requestId:string, decision:CodexDecisionAnswer):Promise<CodexAnswerOutcome> => {
      const pending = decisions.get(requestId);
      if (!pending || pending.confirm || pending.threadId !== threadId || !pendingServerRequests.has(pending.id)) return 'not-found';
      const owner = options.policy?.owner(threadId);
      if (!options.policy || owner?.paneId !== options.policy.paneId || !owner.live) return 'not-found';
      const bytes = Buffer.from(JSON.stringify({id:pending.id,result:{decision}}));
      const link = upstream;
      if (retired || !alive || !link || link.readyState !== WebSocket.OPEN || link.bufferedAmount + bytes.length > MAX_BUFFER) return 'unavailable';
      pendingServerRequests.delete(pending.id);
      return new Promise<CodexAnswerOutcome>(resolve=>{
        const timer = setTimeout(()=>finish('uncertain'),options.answerConfirmMs ?? ANSWER_CONFIRM_MS);
        timer.unref?.();
        const finish = (outcome:CodexAnswerOutcome) => {
          if (!pending.confirm) return;
          pending.confirm = undefined;
          clearTimeout(timer);
          if (decisions.get(requestId) === pending) decisions.delete(requestId);
          resolve(outcome);
          if (outcome !== 'ok') {
            try {options.policy?.decisionSettled?.(requestId,threadId,'prompt-gone');} catch {/* A notice cannot change the outcome. */}
          }
        };
        pending.confirm = finish;
        link.send(bytes,{binary:false},error=>{
          if (error) {finish('uncertain');if (alive) retire();}
        });
      });
    };
    answerOnConnection = answerHere;
    let unmatchedResponses = 0;
    const needsIdentity = (message:unknown) => {
      const cls = classify(message);
      return cls === 'identity' || cls === 'exec';
    };
    /** `answersPending`: set for a client response, decided when it arrived. */
    const review = async (frame:{bytes:Buffer;message:unknown}, answersPending?:boolean):Promise<void> => {
      if (answersPending !== undefined) {
        if (answersPending) { handleClient(frame);return; }
        // Dropped without a reply: the id belongs to the server's request ids,
        // so an error frame carrying it could be read as an answer to the client's own request.
        unmatchedResponses++;
        try {options.policy?.unmatchedResponse?.(unmatchedResponses);} catch {/* A notice cannot change the outcome. */}
        return;
      }
      const policy = options.policy;
      if (!policy) { handleClient(frame);return; }
      let identity = policy.identity();
      if (!identity && needsIdentity(frame.message)) {
        for (let waited = 0; !identity && waited < IDENTITY_WAIT_MS && !retired && alive; waited += IDENTITY_POLL_MS) {
          await new Promise(resolve=>setTimeout(resolve,IDENTITY_POLL_MS));
          identity = policy.identity();
        }
        if (retired || !alive) return;
        if (!identity) {
          // The pane never took ownership: stop holding the TUI, close the relay.
          refuse(frame.message,'pane identity is not available');
          retire();return;
        }
      }
      if (retired || !alive) return;
      const verdict = await reviewClientFrame(frame.message,{
        paneId:policy.paneId, identity, serverProven:policy.serverProven(), owner:policy.owner,
        query:(method,params)=>queryUpstream(upstreamPath,method,params),
      });
      if (retired || !alive) return;
      if (verdict.kind === 'refuse') { refuse(frame.message,verdict.reason);return; }
      const message = verdict.message ?? frame.message;
      const m = message as {id?:unknown;method?:unknown};
      if (typeof m.method === 'string' && (typeof m.id === 'string' || typeof m.id === 'number') &&
          (classify(message) === 'identity' || m.method === 'review/start')) {
        if (tracked.size >= MAX_TRACKED_REQUESTS) { retire();return; }
        tracked.set(m.id,m.method);
      }
      if (!verdict.message) { handleClient(frame);return; }
      const bytes = Buffer.from(JSON.stringify(verdict.message));
      if (bytes.length > MAX_FRAME) { refuse(frame.message,'request too large');return; }
      handleClient({bytes,message:verdict.message});
    };
    // Client frames are handled strictly in order; frames held behind one
    // that waits are bounded by count and bytes.
    let clientChain:Promise<void> = Promise.resolve();
    let heldFrames = 0, heldBytes = 0;
    client.on('message',(raw,binary)=>{
      const decoded = decode(raw,binary);if(!decoded)return;
      // Upstream receives the frame as the relay parsed and reviewed it.
      const frame = {bytes:Buffer.from(JSON.stringify(decoded.message)),message:decoded.message};
      if (frame.bytes.length > MAX_FRAME) { retire();return; }
      if (heldFrames + 1 > MAX_HELD_FRAMES || heldBytes + frame.bytes.length > MAX_BUFFER) { retire();return; }
      // A response claims its pending request on arrival, not after the frames queued ahead of it.
      let answersPending:boolean|undefined;
      if (classify(frame.message) === 'response') {
        const id = (frame.message as {id?:unknown}).id;
        answersPending = isRequestId(id) && pendingServerRequests.delete(id);
        // The TUI answered: a phone answer to the same request is refused from now on.
        if (answersPending) settleDecision(codexRequestKey(id as string|number),'answered-locally');
      }
      heldFrames++;heldBytes += frame.bytes.length;
      clientChain = clientChain.then(()=>review(frame,answersPending)).catch(()=>{if (alive) retire();})
        .finally(()=>{heldFrames--;heldBytes -= frame.bytes.length;});
    });
    const fromUpstream = (raw:RawData,binary:boolean) => {
      const frame = decode(raw,binary);if(!frame)return;
      const before = JSON.stringify(tracker.current());
      tracker.fromServer(frame.message);
      const message = frame.message as {method?:unknown;params?:{threadId?:unknown;requestId?:unknown;turn?:unknown};id?:unknown;result?:unknown} | null;
      if (message && typeof message.method === 'string' && isRequestId(message.id)) {
        if (!pendingServerRequests.has(message.id) && pendingServerRequests.size >= MAX_PENDING_SERVER_REQUESTS) {
          try {options.policy?.refused?.('too many Codex requests are awaiting an answer; the pane connection was closed');} catch {/* A notice cannot change the outcome. */}
          retire();return;
        }
        const threadId = message.params?.threadId;
        pendingServerRequests.set(message.id,typeof threadId === 'string' ? threadId : undefined);
        const decision = options.policy?.decisionPending ? codexDecisionFromRequest(message) : undefined;
        // Only for a thread this pane owns: the server fans a request out to
        // every connection subscribed to its thread.
        const owner = decision ? options.policy?.owner(decision.threadId) : undefined;
        if (decision && owner?.paneId === options.policy?.paneId && owner?.live) {
          const key = codexRequestKey(message.id);
          decisions.set(key,{id:message.id,threadId:decision.threadId});
          try {options.policy?.decisionPending?.(key,decision);} catch {decisions.delete(key);}
        }
      } else if (message?.method === 'serverRequest/resolved') {
        const requestId = message.params?.requestId;
        if (isRequestId(requestId)) {
          pendingServerRequests.delete(requestId);
          // A phone answer waiting for this confirms; otherwise the TUI or
          // another client answered. A notice without a thread id still names
          // the request by its id.
          const key = codexRequestKey(requestId);
          const decision = decisions.get(key);
          const threadId = message.params?.threadId;
          if (decision && (threadId === undefined || threadId === decision.threadId)) {
            if (decision.confirm) decision.confirm('ok');
            else settleDecision(key,'answered-locally');
          }
        }
      } else if (message?.method === 'turn/started' && typeof message.params?.threadId === 'string') {
        const turn = message.params.turn as {id?:unknown} | null | undefined;
        if (typeof turn?.id === 'string' && turn.id.length <= 128) {
          activeTurns.delete(message.params.threadId);
          activeTurns.set(message.params.threadId,turn.id);
          if (activeTurns.size > MAX_ACTIVE_TURNS) activeTurns.delete(activeTurns.keys().next().value as string);
        }
      } else if (message?.method === 'turn/completed' && typeof message.params?.threadId === 'string') {
        // A finished turn leaves none of its requests awaiting an answer.
        for (const [id,threadId] of pendingServerRequests) if (threadId === message.params.threadId) pendingServerRequests.delete(id);
        for (const [key,decision] of decisions) if (decision.threadId === message.params.threadId) settleDecision(key,'turn-ended');
        const turn = message.params.turn as {id?:unknown;status?:unknown} | null | undefined;
        if (typeof turn?.id === 'string' && turn.id.length <= 128) {
          if (activeTurns.get(message.params.threadId) === turn.id) activeTurns.delete(message.params.threadId);
          const status = typeof turn.status === 'string' && /^[A-Za-z]{1,32}$/.test(turn.status) ? turn.status : 'unknown';
          const key = turnKey(message.params.threadId,turn.id);
          endedTurns.delete(key);
          const at = Date.now();
          endedTurns.set(key,{status,at});
          for (const [old,ended] of endedTurns) {
            if (endedTurns.size <= MAX_ENDED_TURNS || endedTurns.size <= MAX_ENDED_TURNS_HARD && at - ended.at < ENDED_TURN_KEEP_MS) break;
            endedTurns.delete(old);
          }
          settleTurnWaiters(key,status);
        }
      }
      if (message && message.method === undefined && (typeof message.id === 'string' || typeof message.id === 'number')) {
        const method = tracked.get(message.id);
        if (method !== undefined) {
          tracked.delete(message.id);
          for (const threadId of threadIdsFromResponse(method,message.result)) {
            try {options.policy?.recordOwner(threadId);} catch {retire();return;}
          }
        }
      }
      const finished = message?.method === 'turn/completed' && message.params?.threadId === tracker.current()?.threadId;
      if (before !== JSON.stringify(tracker.current()) || finished) {
        try {options.onStateChange?.();} catch {retire();return;}
      }
      send(client,frame.bytes);
    };
    // Request ids restart with the next connection: nothing here is answerable any more.
    const endConnection = () => {
      queued.length=0;queuedBytes=0;tracked.clear();pendingServerRequests.clear();
      for (const key of [...decisions.keys()]) settleDecision(key,'pane-gone');
    };
    let redial:NodeJS.Timeout | undefined;
    /**
     * Ends this connection without retiring the relay, and lets the TUI go so
     * its own reconnect comes back to this endpoint. `lost`: the server link
     * that carried the TUI's session went away (a restart, an auto-update), so
     * the turns it reported running are forgotten; the new server reports its own.
     */
    const drop = (lost:boolean) => {
      if (!alive || retired) return;
      endConnection();
      alive = false;
      claimed = false;
      upstreamLost = true;
      if (answerOnConnection === answerHere) answerOnConnection = undefined;
      if (redial) { clearTimeout(redial);redials.delete(redial);redial = undefined; }
      for (const socket of [client,upstream]) if (socket) { sockets.delete(socket);socket.terminate(); }
      if (!lost) return;
      activeTurns.clear();
      for (const key of [...turnWaiters.keys()]) settleTurnWaiters(key,undefined);
      try {options.onUpstreamLost?.();} catch {/* A notice cannot keep the old link. */}
      try {options.onStateChange?.();} catch {/* The selection did not change. */}
    };
    const clientGone = () => {
      if (!alive) return;
      // A TUI that gave up on a reconnect attempt before the server came back
      // leaves the endpoint for its next attempt.
      if (rejoining && !linked) { drop(false);return; }
      endConnection();retire();
    };
    client.on('error',clientGone);
    client.on('close',clientGone);
    const reconnect = options.reconnect ?? {};
    const windowMs = reconnect.windowMs ?? RECONNECT_WINDOW_MS;
    const maxMs = reconnect.maxMs ?? RECONNECT_MAX_MS;
    let delay = reconnect.baseMs ?? RECONNECT_BASE_MS;
    const since = Date.now();
    let ensured = false;
    /** A re-dial failed: try again after a doubled delay, or let the TUI go once the window is spent. */
    const retryLater = () => {
      if (!alive || retired) return;
      if (!ensured) {
        ensured = true;
        try {void options.ensureUpstream?.().catch(()=> { /* the next dial decides */ });} catch {/* the next dial decides */}
      }
      if (Date.now() - since + delay > windowMs) { drop(false);return; }
      const timer = setTimeout(()=>{
        redials.delete(timer);
        if (redial === timer) redial = undefined;
        void dial();
      },delay);
      timer.unref?.();
      redial = timer;redials.add(timer);
      delay = Math.min(delay * 2,maxMs);
    };
    const dial = async () => {
      if (!alive || retired) return;
      if (rejoining) {
        // A restarted server serves a new socket: it must pass the same checks.
        try {await verifyUpstreamSocket(upstreamPath);} catch {retryLater();return;}
        if (!alive || retired) return;
      }
      const attempt = new WebSocket(`ws+unix://${upstreamPath}:/`,{handshakeTimeout:5000,maxPayload:MAX_FRAME,perMessageDeflate:false,followRedirects:false});
      upstream = attempt;sockets.add(attempt);
      let over = false;
      const failed = () => {
        if (over || !alive || upstream !== attempt) return;
        over = true;
        sockets.delete(attempt);attempt.terminate();
        if (linked) { drop(true);return; }
        // A first connection that never reached the server: as it always was.
        if (!rejoining) { endConnection();retire();return; }
        retryLater();
      };
      attempt.on('open',()=>{
        if (!alive || upstream !== attempt) return;
        linked = true;
        upstreamLost = false;
        for(const bytes of queued)send(attempt,bytes);
        queued.length = 0;queuedBytes = 0;
      });
      attempt.on('message',(raw,binary)=>{ if (upstream === attempt) fromUpstream(raw,binary); });
      attempt.on('error',failed);
      attempt.on('close',failed);
    };
    void dial();
  });
  try {
    await chmod(directory,0o700);
    if (Buffer.byteLength(socketPath) > 100) throw new Error('Codex relay socket path too long');
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject);
      server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});
    });
    server.on('error',()=>{void close().catch(()=> { /* noop */ });});
    await chmod(socketPath,0o600);
    // `retired` lets the owner tell "this relay is live and nothing is selected"
    // from "this relay is gone" — after close() the tracker reports no selection
    // either way, and only the former may erase a durable recovery hint.
    return {url:`unix://${socketPath}`,current:()=>tracker.current(),retired:()=>retired,close,
      /** A phone's answer to a request reported by `decisionPending`. */
      answer:(threadId:string,requestId:string,decision:CodexDecisionAnswer):Promise<CodexAnswerOutcome> =>
        retired || !answerOnConnection ? Promise.resolve('not-found') : answerOnConnection(threadId,requestId,decision),
      /** The thread's running turn as this pane's stream last reported it. */
      activeTurn:(threadId:string):string | undefined => retired ? undefined : activeTurns.get(threadId),
      /** How a recently ended turn ended, as this pane's stream reported it. */
      turnEnded:(threadId:string,turnId:string):CodexTurnEnd | undefined => endedTurns.get(turnKey(threadId,turnId))?.status,
      /**
       * The turn's final status once this pane's stream reports `turn/completed`
       * for it; undefined when `ms` passes, `cancel` is called or the relay closes.
       */
      waitTurnEnd:(threadId:string,turnId:string,ms:number):{ended:Promise<CodexTurnEnd | undefined>; cancel:()=>void} => {
        const key = turnKey(threadId,turnId);
        let done:((status:CodexTurnEnd | undefined)=>void) | undefined;
        const ended = new Promise<CodexTurnEnd | undefined>(resolve=>{
          const seen = endedTurns.get(key)?.status;
          if (retired || seen !== undefined) { resolve(seen);return; }
          const finish = (status:CodexTurnEnd | undefined) => {
            clearTimeout(timer);
            const waiters = turnWaiters.get(key);
            waiters?.delete(finish);
            if (waiters?.size === 0) turnWaiters.delete(key);
            resolve(status);
          };
          const timer = setTimeout(()=>finish(undefined),ms);
          timer.unref?.();
          done = finish;
          const waiters = turnWaiters.get(key) ?? new Set();
          waiters.add(finish);turnWaiters.set(key,waiters);
        });
        return {ended,cancel:()=>done?.(undefined)};
      },
      /** `turn/interrupt` on a side connection (see `interruptUpstream`). */
      interrupt:(threadId:string,turnId:string,timeoutMs?:number):Promise<unknown> =>
        retired ? Promise.reject(new CodexUpstreamError('not-sent')) : interruptUpstream(upstreamPath,threadId,turnId,timeoutMs)};
  } catch(error) {await close();throw error;}
}

/** The read-only methods a side connection may send. `getAuthStatus` and
 * `account/rateLimits/read` serve the phone's account status (no model call). */
export type CodexUpstreamRead = 'config/read'|'thread/loaded/list'|'getAuthStatus'|'account/rateLimits/read';

/** An account server's control socket under a Codex home. */
export const codexUpstreamPath = (codeHome:string):string => path.join(codeHome,'app-server-control','app-server-control.sock');

/**
 * The control socket belongs to this user. Checked before the first dial and
 * again before every re-dial: a restarted server serves a new socket inode.
 */
async function verifyUpstreamSocket(upstreamPath:string):Promise<void> {
  const link = await lstat(upstreamPath);
  const target = link.isSymbolicLink() ? await realpath(upstreamPath) : upstreamPath;
  const stat = await lstat(target);
  if (link.isSymbolicLink()) {
    // Current Codex places its Unix socket in a private short-path directory.
    // Accept that indirection only when both directories belong to this user
    // and cannot be written by anyone else; never accept a foreign socket.
    for (const directory of [path.dirname(upstreamPath), path.dirname(target)]) {
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.mode & 0o022 || typeof process.getuid === 'function' && parent.uid !== process.getuid()) throw new Error('Unsafe Codex socket directory');
    }
  }
  if (!stat.isSocket() || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Codex account socket unavailable');
}

/**
 * A side-connection request that did not answer. `refused`: the server
 * answered with an error, so it did nothing. `not-sent`: the request never
 * left. `uncertain`: it was written and no answer came (timeout or close).
 */
export class CodexUpstreamError extends Error {
  constructor(readonly kind:'refused'|'not-sent'|'uncertain', message = 'Codex query failed') {super(message);}
}

/**
 * One read-only request on a separate, short-lived connection to the account
 * server, so the relay's own stream (and its request ids) stay untouched.
 */
export function queryUpstream(upstreamPath:string, method:CodexUpstreamRead, params:Record<string,unknown>, timeoutMs = 5000):Promise<unknown> {
  return requestUpstream(upstreamPath,method,params,timeoutMs);
}

/**
 * The one write a side connection sends: `turn/interrupt` for a turn this
 * pane's stream reported running. Its answer is not an outcome: `{}` can
 * arrive for a turn that is not interrupted (a request for an already
 * finished turn is held and later answered when another turn is
 * interrupted), and such a request may never be answered at all, so
 * `timeoutMs` always bounds it. Only the pane's own `turn/completed` proves
 * the turn ended. Never `thread/resume` from a side connection: it broadcasts
 * to every connection on the thread.
 */
export function interruptUpstream(upstreamPath:string, threadId:string, turnId:string, timeoutMs = 5000):Promise<unknown> {
  return requestUpstream(upstreamPath,'turn/interrupt',{threadId,turnId},timeoutMs);
}

function requestUpstream(upstreamPath:string, method:string, params:Record<string,unknown>, timeoutMs:number):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    let sent = false;
    const socket = new WebSocket(`ws+unix://${upstreamPath}:/`,{handshakeTimeout:timeoutMs,maxPayload:MAX_FRAME,perMessageDeflate:false,followRedirects:false});
    let done = false;
    const finish = (error:Error|undefined, value?:unknown) => {
      if (done) return; done = true; clearTimeout(timer);
      socket.terminate();
      if (error) reject(error); else resolve(value);
    };
    const lost = (message:string) => new CodexUpstreamError(sent ? 'uncertain' : 'not-sent',message);
    const timer = setTimeout(()=>finish(lost('Codex query timed out')),timeoutMs);
    socket.on('error',()=>finish(lost('Codex query failed')));
    socket.on('close',()=>finish(lost('Codex query closed')));
    socket.on('open',()=>{
      socket.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'wmux_relay',version:'1.0.0'},capabilities:{experimentalApi:true,requestAttestation:false}}}));
    });
    socket.on('message',(raw,binary)=>{
      if (binary) return finish(lost('Codex query failed'));
      let message:{id?:unknown;result?:unknown;error?:unknown};
      try { message = JSON.parse(raw.toString()); } catch { return finish(lost('Codex query failed')); }
      if (message.id === 1) {
        if (message.error) return finish(lost('Codex query failed'));
        socket.send(JSON.stringify({method:'initialized'}));
        sent = true;
        socket.send(JSON.stringify({id:2,method,params}));
      } else if (message.id === 2) {
        return message.error ? finish(new CodexUpstreamError('refused')) : finish(undefined,message.result);
      }
    });
  });
}
