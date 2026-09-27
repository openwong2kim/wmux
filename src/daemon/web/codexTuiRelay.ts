import {createServer} from 'node:http';
import {chmod,lstat,realpath,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer,type RawData} from 'ws';
import {CodexTuiSelectionTracker} from './codexTuiSelection';
import {connectCodexSettings} from './codexSettingsTransport';
import {needsThreadIdentity,rewriteThreadFrame} from './codexThreadIdentity';

export class CodexRelayUnavailableError extends Error {
  constructor() {super('Codex account server is not ready');}
}

// Native app/read includes installed app metadata (~11 MiB observed).
// Keep transport bounds separate from the much smaller Chat display budget.
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
/** How long a thread request waits for the pane to be committed to this relay. */
const IDENTITY_WAIT_MS = 3000;
const IDENTITY_POLL_MS = 50;

/**
 * Pane identity injection (codexThreadIdentity.ts). `identity` returns the
 * pane's identity from the daemon's session record, or undefined while the
 * relay has no owner. A thread request that cannot carry identity is answered
 * with an error and never forwarded.
 */
export interface CodexRelayThreadIdentity {
  identity: () => Record<string,string> | undefined;
  mcp: () => boolean;
  refused?: (reason:string) => void;
}

/** A single-use endpoint for a daemon-owned TUI. It never starts/stops Codex's
 * account server; the pane lifecycle owns and must close this relay. */
export async function createCodexTuiRelay(options:{codeHome?:string; onRequestMethod?:(method:string)=>void; onStateChange?:()=>void; threadIdentity?:CodexRelayThreadIdentity}) {
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
      const id = (message as {id?:unknown}).id;
      try {options.threadIdentity?.refused?.(reason);} catch {/* A notice cannot change the refusal. */}
      if (typeof id === 'string' || typeof id === 'number') {
        send(client,Buffer.from(JSON.stringify({id,error:{code:-32603,message:`wmux: ${reason}; the thread was not started`}})));
      }
    };
    const withIdentity = async (frame:{bytes:Buffer;message:unknown}):Promise<void> => {
      const inject = options.threadIdentity;
      if (!inject || !needsThreadIdentity(frame.message)) { handleClient(frame);return; }
      let identity = inject.identity();
      for (let waited = 0; !identity && waited < IDENTITY_WAIT_MS && !retired; waited += IDENTITY_POLL_MS) {
        await new Promise(resolve=>setTimeout(resolve,IDENTITY_POLL_MS));
        identity = inject.identity();
      }
      if (retired) return;
      const result = rewriteThreadFrame(frame.message,identity,{mcp:inject.mcp()});
      if (result.kind === 'refuse') { refuse(frame.message,result.reason);return; }
      if (result.kind === 'pass') { handleClient(frame);return; }
      const bytes = Buffer.from(JSON.stringify(result.message));
      if (bytes.length > MAX_FRAME) { refuse(frame.message,'thread request too large');return; }
      handleClient({bytes,message:result.message});
    };
    // Client frames are handled strictly in order: a thread request that waits
    // for the pane's identity holds back everything the TUI sends after it.
    let clientChain:Promise<void> = Promise.resolve();
    client.on('message',(raw,binary)=>{
      const frame = decode(raw,binary);if(!frame)return;
      clientChain = clientChain.then(()=>withIdentity(frame)).catch(()=>retire());
    });
    upstream.on('message',(raw,binary)=>{
      const frame = decode(raw,binary);if(!frame)return;
      const before = JSON.stringify(tracker.current());
      tracker.fromServer(frame.message);
      const message = frame.message as {method?:unknown;params?:{threadId?:unknown}} | null;
      const finished = message?.method === 'turn/completed' && message.params?.threadId === tracker.current()?.threadId;
      if (before !== JSON.stringify(tracker.current()) || finished) {
        try {options.onStateChange?.();} catch {retire();return;}
      }
      send(client,frame.bytes);
    });
    for(const socket of [client,upstream]) {
      socket.on('error',retire);
      socket.on('close',()=>{queued.length=0;queuedBytes=0;retire();});
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
