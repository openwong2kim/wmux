import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import type { CodexSettingsMethod, CodexSettingsRPC } from './codexLiveSettings';

const METHODS = new Set<CodexSettingsMethod>(['thread/read','model/list','thread/settings/update']);
interface Pending { resolve:(value:unknown)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> }
export interface CodexSettingsConnection { rpc: CodexSettingsRPC; close():void }

/** Attach to an existing account's Unix WebSocket. Never start or stop its server. */
export async function connectCodexSettings(options: {codeHome?:string; cwd:string}): Promise<CodexSettingsConnection> {
  if (!path.isAbsolute(options.cwd) || options.cwd.includes('\0') ||
      options.codeHome !== undefined && (!path.isAbsolute(options.codeHome) || options.codeHome.includes('\0'))) throw new Error('Invalid Codex account scope');
  const socketPath = path.join(options.codeHome ?? path.join(os.homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
  // ws+unix parses ':' as its path separator; reject ambiguous account paths.
  if (socketPath.includes(':')) throw new Error('Invalid Codex account scope');
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
    handshakeTimeout:5000,maxPayload:2 * 1024 * 1024,perMessageDeflate:false,followRedirects:false,
  });
  const connection = new SettingsTransport(socket);
  try {
    await new Promise<void>((resolve,reject) => {
      socket.once('open',resolve);
      socket.once('error',() => reject(new Error('Codex socket unavailable')));
      socket.once('close',() => reject(new Error('Codex socket closed')));
    });
    await connection.initialize();
    return connection;
  } catch (error) { connection.close(); throw error; }
}

export class SettingsTransport implements CodexSettingsConnection {
  private nextID = 0;
  private pending = new Map<number,Pending>();
  private totalBytes = 0;
  private closed = false;
  private ready = false;
  private lifetime: ReturnType<typeof setTimeout>;

  constructor(private readonly socket: WebSocket, private readonly timeoutMs = 5000,
    private readonly maxFrameBytes = 2 * 1024 * 1024) {
    this.lifetime = setTimeout(() => this.stop(new Error('Codex connection expired')), 30000);
    socket.on('message', (bytes:Buffer, binary:boolean) => {
      if (binary) return this.stop(new Error('Invalid Codex response'));
      this.receive(bytes);
    });
    socket.on('error', () => this.stop(new Error('Codex socket unavailable')));
    socket.on('close', () => this.stop(new Error('Codex socket closed')));
  }

  async initialize(): Promise<void> {
    await this.request('initialize',{clientInfo:{name:'wmux_phone',version:'1.0.0'},capabilities:{experimentalApi:true,requestAttestation:false}});
    if (this.closed) throw new Error('Codex proxy closed');
    this.write({method:'initialized'});
    this.ready = true;
  }

  rpc: CodexSettingsRPC = async (method,params) => {
    if (!this.ready || !METHODS.has(method)) throw new Error('Unsupported Codex settings operation');
    return this.request(method,params);
  };

  close():void { this.stop(new Error('Codex settings connection closed')); }

  private request(method:string,params:Record<string,unknown>):Promise<unknown> {
    if (this.closed || this.pending.size >= 8) return Promise.reject(new Error('Codex settings connection unavailable'));
    const id = ++this.nextID;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => this.stop(new Error('Codex settings request timed out')),this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      this.write({id,method,params});
    });
  }

  private write(message:Record<string,unknown>):void {
    if (this.closed) return;
    try {
      const line = JSON.stringify(message);
      if (Buffer.byteLength(line) > 64 * 1024) { this.stop(new Error('Codex request too large')); return; }
      this.socket.send(line,error => { if (error) this.stop(new Error('Codex transport closed')); });
    } catch { this.stop(new Error('Codex transport closed')); }
  }

  private accountBytes(count:number):boolean {
    this.totalBytes += count;
    if (this.totalBytes > 8 * 1024 * 1024) this.stop(new Error('Codex response budget exceeded'));
    return !this.closed;
  }

  private receive(bytes:Buffer):void {
    if (!this.accountBytes(bytes.length)) return;
    if (bytes.length > this.maxFrameBytes) { this.stop(new Error('Codex response too large')); return; }
    const line = bytes.toString('utf8');
    let message:Record<string,unknown>;
    try {
      const parsed:unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid frame');
      message = parsed as Record<string,unknown>;
    } catch { this.stop(new Error('Invalid Codex response')); return; }
    if (typeof message.method === 'string') {
      // This connection cannot approve or execute server-initiated requests.
      if (typeof message.id === 'string' || typeof message.id === 'number') {
        this.write({id:message.id,error:{code:-32601,message:'Unsupported by settings client'}});
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if ('error' in message) entry.reject(new Error('Codex settings request refused'));
    else if ('result' in message) entry.resolve(message.result);
    else { entry.reject(new Error('Invalid Codex response')); this.stop(new Error('Invalid Codex response')); return; }
  }

  private stop(error:Error):void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.lifetime);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.socket.terminate();
  }
}
