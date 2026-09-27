import {createServer} from 'node:http';
import {chmod,lstat,realpath,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer,type RawData} from 'ws';
import {CodexTuiSelectionTracker} from './codexTuiSelection';
import {connectCodexSettings} from './codexSettingsTransport';
import {classify,reviewClientFrame,threadIdsFromResponse,type PolicyContext} from './codexRelayPolicy';

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
}

/** A single-use endpoint for a daemon-owned TUI. It never starts/stops Codex's
 * account server; the pane lifecycle owns and must close this relay. */
export async function createCodexTuiRelay(options:{codeHome?:string; onRequestMethod?:(method:string)=>void; onStateChange?:()=>void; policy?:CodexRelayPolicy}) {
  const codeHome = options.codeHome ?? path.join(os.homedir(),'.codex');
  if (!path.isAbsolute(codeHome) || codeHome.includes('\0') || codeHome.includes(':')) throw new Error('Invalid Codex account scope');
  const upstreamPath = path.join(codeHome,'app-server-control','app-server-control.sock');
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
  let closing:Promise<void> | undefined;
  const close = ():Promise<void> => {
    if (closing) return closing;
    retired = true;
    tracker.close();
    try {options.onStateChange?.();} catch {/* Retiring cannot restore authority. */}
    for (const socket of sockets) socket.terminate();
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
    const upstream = new WebSocket(`ws+unix://${upstreamPath}:/`,{handshakeTimeout:5000,maxPayload:MAX_FRAME,perMessageDeflate:false,followRedirects:false});
    sockets.add(client);sockets.add(upstream);
    const queued:Buffer[] = [];
    let queuedBytes = 0;
    const retire = () => { void close().catch(()=> { /* noop */ }); };
    const send = (target:WebSocket,bytes:Buffer) => {
      if (retired || target.readyState !== WebSocket.OPEN || target.bufferedAmount + bytes.length > MAX_BUFFER) { retire();return; }
      target.send(bytes,{binary:false},error=>{if(error)retire();});
    };
    const decode = (raw:RawData,binary:boolean):{bytes:Buffer;message:unknown}|undefined => {
      if (retired || binary) {retire();return;}
      const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
      if (bytes.length > MAX_FRAME) {retire();return;}
      try {return {bytes,message:JSON.parse(bytes.toString('utf8'))};}
      catch {retire();return;}
    };
    upstream.on('open',()=>{
      for(const bytes of queued)send(upstream,bytes);
      queued.length = 0;queuedBytes = 0;
    });
    const forward = (bytes:Buffer) => {
      if(upstream.readyState === WebSocket.OPEN)send(upstream,bytes);
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
    const needsIdentity = (message:unknown) => {
      const cls = classify(message);
      return cls === 'identity' || cls === 'exec';
    };
    const review = async (frame:{bytes:Buffer;message:unknown}):Promise<void> => {
      const policy = options.policy;
      if (!policy) { handleClient(frame);return; }
      let identity = policy.identity();
      if (!identity && needsIdentity(frame.message)) {
        for (let waited = 0; !identity && waited < IDENTITY_WAIT_MS && !retired; waited += IDENTITY_POLL_MS) {
          await new Promise(resolve=>setTimeout(resolve,IDENTITY_POLL_MS));
          identity = policy.identity();
        }
        if (retired) return;
        if (!identity) {
          // The pane never took ownership: stop holding the TUI, close the relay.
          refuse(frame.message,'pane identity is not available');
          retire();return;
        }
      }
      if (retired) return;
      const verdict = await reviewClientFrame(frame.message,{
        paneId:policy.paneId, identity, serverProven:policy.serverProven(), owner:policy.owner,
        query:(method,params)=>queryUpstream(upstreamPath,method,params),
      });
      if (retired) return;
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
      const frame = decode(raw,binary);if(!frame)return;
      if (heldFrames + 1 > MAX_HELD_FRAMES || heldBytes + frame.bytes.length > MAX_BUFFER) { retire();return; }
      heldFrames++;heldBytes += frame.bytes.length;
      clientChain = clientChain.then(()=>review(frame)).catch(()=>retire())
        .finally(()=>{heldFrames--;heldBytes -= frame.bytes.length;});
    });
    upstream.on('message',(raw,binary)=>{
      const frame = decode(raw,binary);if(!frame)return;
      const before = JSON.stringify(tracker.current());
      tracker.fromServer(frame.message);
      const message = frame.message as {method?:unknown;params?:{threadId?:unknown};id?:unknown;result?:unknown} | null;
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
    });
    for(const socket of [client,upstream]) {
      socket.on('error',retire);
      socket.on('close',()=>{queued.length=0;queuedBytes=0;tracked.clear();retire();});
    }
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
    return {url:`unix://${socketPath}`,current:()=>tracker.current(),retired:()=>retired,close};
  } catch(error) {await close();throw error;}
}

/**
 * One read-only request on a separate, short-lived connection to the account
 * server, so the relay's own stream (and its request ids) stay untouched.
 */
export function queryUpstream(upstreamPath:string, method:'config/read'|'thread/loaded/list', params:Record<string,unknown>, timeoutMs = 5000):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    const socket = new WebSocket(`ws+unix://${upstreamPath}:/`,{handshakeTimeout:timeoutMs,maxPayload:MAX_FRAME,perMessageDeflate:false,followRedirects:false});
    let done = false;
    const finish = (error:Error|undefined, value?:unknown) => {
      if (done) return; done = true; clearTimeout(timer);
      socket.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(()=>finish(new Error('Codex query timed out')),timeoutMs);
    socket.on('error',()=>finish(new Error('Codex query failed')));
    socket.on('close',()=>finish(new Error('Codex query closed')));
    socket.on('open',()=>{
      socket.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'wmux_relay',version:'1.0.0'},capabilities:{experimentalApi:true,requestAttestation:false}}}));
    });
    socket.on('message',(raw,binary)=>{
      if (binary) return finish(new Error('Codex query failed'));
      let message:{id?:unknown;result?:unknown;error?:unknown};
      try { message = JSON.parse(raw.toString()); } catch { return finish(new Error('Codex query failed')); }
      if (message.id === 1) {
        if (message.error) return finish(new Error('Codex query failed'));
        socket.send(JSON.stringify({method:'initialized'}));
        socket.send(JSON.stringify({id:2,method,params}));
      } else if (message.id === 2) {
        return message.error ? finish(new Error('Codex query failed')) : finish(undefined,message.result);
      }
    });
  });
}
