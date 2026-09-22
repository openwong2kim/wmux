import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,stat,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {describe,it,expect} from 'vitest';
import {createCodexTuiRelay,CodexRelayUnavailableError} from '../codexTuiRelay';
const threadId='01234567-89ab-4cde-8123-456789abcdef';
const systemThreadId='11111111-89ab-4cde-8123-456789abcdef';
const otherThreadId='22222222-89ab-4cde-8123-456789abcdef';
async function fixture(options:{onStateChange?:()=>void; onUpstreamRequest?:(request:{id?:unknown;method?:unknown})=>void}={}) {
  // macOS's per-user tmpdir is too long for a Unix socket path (sun_path is
  // 104 bytes there); /tmp keeps the fixture sockets addressable.
  const home=await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(),'wmux-relay-test-'));
  const upstreamPath=path.join(home,'app-server-control','app-server-control.sock');
  await mkdir(path.dirname(upstreamPath));
  const server=createServer();
  const wss=new WebSocketServer({server});
  // The relay's readiness probe connects before the owned TUI does; only the
  // connection opened after creation is the relay's own upstream link.
  let ready=false,live:WebSocket|undefined;
  wss.on('connection',socket=>{
    if(ready)live=socket;
    socket.on('message',bytes=>{
      const request=JSON.parse(bytes.toString());
      if(ready)options.onUpstreamRequest?.(request);
      const system=request.params?.threadSource==='system';
      socket.send(JSON.stringify({id:request.id,result:{thread:{id:system?systemThreadId:threadId,cwd:'/repo'}}}));
    });
  });
  await new Promise<void>(resolve=>server.listen(upstreamPath,resolve));
  const relay=await createCodexTuiRelay({codeHome:home,onStateChange:options.onStateChange});
  ready=true;
  const connect=async(origin?:string)=>{
    const socket=new WebSocket(relay.url.replace('unix://','ws+unix://')+':/rpc',{origin});
    await new Promise<void>((resolve,reject)=>{socket.once('open',()=>resolve());socket.once('error',reject);});
    return socket;
  };
  return {relay,connect,server,upstream:()=>live,async cleanup(){
    await relay.close();for(const client of wss.clients)client.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(home,{recursive:true,force:true});
  }};
}
async function select(client:WebSocket,id:number) {
  const replied=new Promise<void>(resolve=>client.once('message',()=>resolve()));
  client.send(JSON.stringify({id,method:'thread/start',params:{}}));
  await replied;
}
// The relay is Unix-socket only; Windows panes take the ordinary launch path.
describe.skipIf(process.platform === 'win32')('pane-owned Codex Unix relay',()=>{
  it('refuses a stale socket inode before creating a TUI endpoint',async()=>{
    const home=await mkdtemp('/tmp/wmux-stale-codex-');
    const socketPath=path.join(home,'app-server-control','app-server-control.sock');
    await mkdir(path.dirname(socketPath));
    const child=spawn(process.execPath,['-e',"require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'))",socketPath],{stdio:['ignore','pipe','pipe']});
    const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    try {
      await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);});
      child.kill('SIGKILL');await exited;
      expect((await stat(socketPath)).isSocket()).toBe(true);
      await expect(createCodexTuiRelay({codeHome:home})).rejects.toBeInstanceOf(CodexRelayUnavailableError);
    } finally {child.kill('SIGKILL');await exited;await rm(home,{recursive:true,force:true});}
  });
  it('refuses a listening server that rejects protocol initialization',async()=>{
    const home=await mkdtemp('/tmp/wmux-unready-codex-');
    const socketPath=path.join(home,'app-server-control','app-server-control.sock');
    await mkdir(path.dirname(socketPath));
    const server=createServer();const wss=new WebSocketServer({server});
    wss.on('connection',socket=>socket.on('message',bytes=>{
      const message=JSON.parse(bytes.toString());socket.send(JSON.stringify({id:message.id,error:{message:'unsupported version'}}));
    }));
    await new Promise<void>(resolve=>server.listen(socketPath,resolve));
    try {await expect(createCodexTuiRelay({codeHome:home})).rejects.toBeInstanceOf(CodexRelayUnavailableError);}
    finally {
      for(const client of wss.clients)client.terminate();
      await new Promise<void>(resolve=>wss.close(()=>resolve()));
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      await rm(home,{recursive:true,force:true});
    }
  });
  it('uses private permissions, rejects another client, and retires on disconnect without stopping upstream',async()=>{
    const f=await fixture();
    try {
      const socketPath=f.relay.url.slice('unix://'.length);
      expect((await stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      const client=await f.connect();
      await expect(f.connect()).rejects.toThrow();
      const reply=new Promise(resolve=>client.once('message',bytes=>resolve(JSON.parse(bytes.toString()))));
      client.send(JSON.stringify({id:1,method:'thread/start',params:{}}));
      await expect(reply).resolves.toMatchObject({id:1,result:{thread:{id:threadId}}});
      expect(f.relay.current()?.threadId).toBe(threadId);
      expect(f.relay.retired()).toBe(false);
      client.terminate();
      await new Promise<void>(resolve=>client.once('close',()=>resolve()));
      await f.relay.close();
      expect(f.relay.current()).toBeUndefined();
      // The empty selection after close is the RELAY being gone, not the pane
      // reporting an empty foreground, and `retired` is what says so.
      expect(f.relay.retired()).toBe(true);
      expect(f.server.listening).toBe(true);
      await expect(access(socketPath)).rejects.toThrow();
    } finally {await f.cleanup();}
  });
  it('rejects browser origins without consuming the endpoint and closes malformed JSON',async()=>{
    const f=await fixture();
    try {
      await expect(f.connect('https://untrusted.invalid')).rejects.toThrow();
      const client=await f.connect();
      const closed=new Promise<void>(resolve=>client.once('close',()=>resolve()));
      client.send('{bad json}');await closed;
      expect(f.relay.current()).toBeUndefined();
    } finally {await f.cleanup();}
  });
  it('publishes the new selection before the correlated response reaches the TUI',async()=>{
    // Ordering is only observable through the refusal barrier: a response whose
    // state change cannot be published must never be delivered to the TUI.
    const observed:(string|undefined)[]=[];let refuse=false;
    const f=await fixture({onStateChange:()=>{observed.push(f.relay.current()?.threadId);if(refuse)throw new Error('state refused');}});
    try {
      const client=await f.connect();
      const delivered:unknown[]=[];
      client.on('message',bytes=>{delivered.push(JSON.parse(bytes.toString()).id);});
      const first=new Promise<void>(resolve=>client.once('message',()=>resolve()));
      client.send(JSON.stringify({id:1,method:'thread/start',params:{ephemeral:true,threadSource:'system'}}));
      await first;
      expect(delivered).toEqual([1]);expect(observed).toEqual([]);
      refuse=true;
      const closed=new Promise<void>(resolve=>client.once('close',()=>resolve()));
      client.send(JSON.stringify({id:2,method:'thread/start',params:{}}));
      await closed;
      // close() re-announces the retired (now empty) selection after the refusal.
      expect(observed).toEqual([threadId,undefined]);
      expect(delivered).toEqual([1]);
    } finally {await f.cleanup();}
  });
  it('clears the old selection before a new resume request reaches the account server',async()=>{
    const upstreamMethods:string[]=[];const observed:string[]=[];let refuse=false;
    const f=await fixture({
      onStateChange:()=>{observed.push(f.relay.current()?.threadId ?? 'none');if(refuse)throw new Error('state refused');},
      onUpstreamRequest:request=>{if(typeof request.method==='string')upstreamMethods.push(request.method);},
    });
    try {
      const client=await f.connect();
      await select(client,1);
      expect(observed).toEqual([threadId]);expect(upstreamMethods).toEqual(['thread/start']);
      refuse=true;
      const closed=new Promise<void>(resolve=>client.once('close',()=>resolve()));
      client.send(JSON.stringify({id:2,method:'thread/resume',params:{}}));
      await closed;await new Promise<void>(resolve=>setTimeout(resolve,50));
      // The stale hint is dropped first; the request that would invalidate it
      // never reaches the account server when that drop cannot be persisted.
      expect(observed).toEqual([threadId,'none','none']);
      expect(upstreamMethods).toEqual(['thread/start']);
    } finally {await f.cleanup();}
  });
  it('lets automatic-title system threads pass through without changing the binding',async()=>{
    let calls=0;
    const f=await fixture({onStateChange:()=>{calls++;}});
    try {
      const client=await f.connect();
      await select(client,1);
      expect(calls).toBe(1);
      const replied=new Promise<unknown>(resolve=>client.once('message',bytes=>resolve(JSON.parse(bytes.toString()))));
      client.send(JSON.stringify({id:2,method:'thread/start',params:{ephemeral:true,threadSource:'system'}}));
      await expect(replied).resolves.toMatchObject({id:2,result:{thread:{id:systemThreadId}}});
      expect(calls).toBe(1);
      expect(f.relay.current()?.threadId).toBe(threadId);
    } finally {await f.cleanup();}
  });
  it('re-announces the selected thread on completion and ignores unrelated threads',async()=>{
    let calls=0;
    const f=await fixture({onStateChange:()=>{calls++;}});
    try {
      const client=await f.connect();
      await select(client,1);
      calls=0;
      // The rollout can still be missing when the thread is created; a completed
      // turn re-announces the unchanged selection so persistence can retry.
      const first=new Promise<void>(resolve=>client.once('message',()=>resolve()));
      f.upstream()!.send(JSON.stringify({method:'turn/completed',params:{threadId}}));
      await first;
      expect(calls).toBe(1);
      expect(f.relay.current()?.threadId).toBe(threadId);
      const second=new Promise<void>(resolve=>client.once('message',()=>resolve()));
      f.upstream()!.send(JSON.stringify({method:'turn/completed',params:{threadId:otherThreadId}}));
      await second;
      expect(calls).toBe(1);
    } finally {await f.cleanup();}
  });
  it('retires instead of forwarding when persistence refuses, without recursing',async()=>{
    let calls=0;
    const f=await fixture({onStateChange:()=>{calls++;throw new Error('state refused');}});
    try {
      const client=await f.connect();
      let forwarded=0;client.on('message',()=>{forwarded++;});
      const closed=new Promise<void>(resolve=>client.once('close',()=>resolve()));
      client.send(JSON.stringify({id:1,method:'thread/start',params:{}}));
      await closed;
      // One refusal from the frame path, one from close(); cleanup must not loop
      // or hand the TUI a response the daemon could not make durable.
      expect(calls).toBe(2);
      expect(forwarded).toBe(0);
      expect(f.relay.current()).toBeUndefined();
    } finally {await f.cleanup();expect(calls).toBe(2);}
  });
});
