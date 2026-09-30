import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,stat,access,symlink} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {describe,it,expect} from 'vitest';
import {createCodexTuiRelay,CodexRelayUnavailableError,CodexUpstreamError,type CodexRelayPolicy,type CodexDecisionSettledReason} from '../codexTuiRelay';
import type {CodexDecisionRequest} from '../codexDecisions';
import {threadIdentityEnv} from '../codexRelayPolicy';
const threadId='01234567-89ab-4cde-8123-456789abcdef';
const systemThreadId='11111111-89ab-4cde-8123-456789abcdef';
const otherThreadId='22222222-89ab-4cde-8123-456789abcdef';
async function fixture(options:{linked?:boolean; onStateChange?:()=>void; onUpstreamRequest?:(request:{id?:unknown;method?:unknown;params?:Record<string,unknown>},raw:string)=>void; policy?:CodexRelayPolicy; answerConfirmMs?:number; respond?:(request:{id?:unknown;method?:unknown;params?:Record<string,unknown>})=>unknown}={}) {
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
    const previous=live;
    if(ready)live=socket;
    socket.on('message',bytes=>{
      const request=JSON.parse(bytes.toString());
      // A side connection (queries, turn/interrupt) introduces itself; it is
      // never the relay's own upstream link.
      if(request.method==='initialize'&&request.params?.clientInfo?.name==='wmux_relay'&&live===socket)live=previous;
      if(ready)options.onUpstreamRequest?.(request,bytes.toString());
      if(request.id===undefined||request.method===undefined)return;
      const custom=ready?options.respond?.(request):undefined;
      // null: never answer (a request the server holds).
      if(custom===null)return;
      if(custom!==undefined){socket.send(JSON.stringify({id:request.id,...(custom as object)}));return;}
      const system=request.params?.threadSource==='system';
      socket.send(JSON.stringify({id:request.id,result:{thread:{id:system?systemThreadId:threadId,cwd:'/repo'}}}));
    });
  });
  const actualPath = options.linked ? path.join(home, 'actual.sock') : upstreamPath;
  await new Promise<void>(resolve=>server.listen(actualPath,resolve));
  if (options.linked) await symlink(actualPath, upstreamPath);
  const relay=await createCodexTuiRelay({codeHome:home,onStateChange:options.onStateChange,policy:options.policy,answerConfirmMs:options.answerConfirmMs});
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
  it('supports the native daemon short-path socket link without losing ownership checks', async () => {
    const f = await fixture({ linked: true });
    try { const client = await f.connect(); await select(client, 1); expect(f.relay.current()?.threadId).toBe(threadId); client.terminate(); }
    finally { await f.cleanup(); }
  });
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
  it('forwards bounded native app metadata larger than the Chat display budget', async () => {
    const f = await fixture();
    try {
      const client = await f.connect(); await select(client, 1);
      const received = new Promise<number>(resolve => client.once('message', bytes => resolve(Buffer.byteLength(bytes as Buffer))));
      const payload = JSON.stringify({ id: 99, result: { metadata: 'x'.repeat(11 * 1024 * 1024) } });
      f.upstream()?.send(payload);
      expect(await received).toBe(Buffer.byteLength(payload));
      expect(f.relay.retired()).toBe(false);
      client.terminate();
    } finally { await f.cleanup(); }
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

describe.skipIf(process.platform === 'win32')('relay request policy',()=>{
  type Req={id?:unknown;method?:unknown;params?:Record<string,unknown>};
  const ID=threadIdentityEnv({id:'pty-a',env:{WMUX_WORKSPACE_ID:'ws-a'}},{});
  const reply=(client:WebSocket)=>new Promise<Record<string,unknown>>(resolve=>client.once('message',b=>resolve(JSON.parse(b.toString()))));
  const WITH_WMUX={result:{config:{mcp_servers:{wmux:{command:'node'}}}}};
  function policy(over:Partial<CodexRelayPolicy>={}):CodexRelayPolicy & {owners:Map<string,string>; refusals:string[]} {
    const owners=new Map<string,string>();const refusals:string[]=[];
    return {paneId:'pty-a',identity:()=>ID,serverProven:()=>true,
      owner:(t)=>owners.has(t)?{paneId:owners.get(t)!,live:true}:undefined,
      recordOwner:(t)=>{owners.set(t,'pty-a');},refused:(r)=>refusals.push(r),owners,refusals,...over};
  }
  const respondWith=(loaded:string[]=[])=>(r:Req)=>r.method==='config/read'?WITH_WMUX:r.method==='thread/loaded/list'?{result:{data:loaded,nextCursor:null}}:undefined;

  it('injects identity on start/resume/fork (title threads too), overwrites forged keys, and records ownership', async () => {
    const seen:Req[]=[];const p=policy();
    const f=await fixture({policy:p,respond:respondWith(),onUpstreamRequest:r=>seen.push(r)});
    try {
      const client=await f.connect();
      for (const [i,frame] of [
        {method:'thread/start',params:{config:{model:'x','shell_environment_policy.set.WMUX_PTY_ID':'forged',shell_environment_policy:{set:{WMUX_WORKSPACE_ID:'forged'}},'mcp_servers.wmux.env':{WMUX_PTY_ID:'forged'}}}},
        {method:'thread/start',params:{ephemeral:true,threadSource:'system'}},
        {method:'thread/resume',params:{threadId}},
        {method:'thread/fork',params:{threadId}},
      ].entries()) { const got=reply(client);client.send(JSON.stringify({id:i+1,...frame}));await got; }
      const cfgs=seen.filter(r=>typeof r.method==='string'&&/^thread\//.test(r.method)).map(r=>(r.params as {config:Record<string,unknown>}).config);
      expect(cfgs).toHaveLength(4);
      for (const c of cfgs) {
        expect(c).toMatchObject({'shell_environment_policy.set.WMUX_PTY_ID':'pty-a','shell_environment_policy.set.WMUX_WORKSPACE_ID':'ws-a','mcp_servers.wmux.env.WMUX_PTY_ID':'pty-a','shell_environment_policy.set.WMUX_AUTH_TOKEN':''});
        expect(JSON.stringify(c)).not.toContain('forged');
      }
      expect(cfgs[0].model).toBe('x');
      expect(p.owners.get(threadId)).toBe('pty-a');
      client.terminate();
    } finally { await f.cleanup(); }
  });

  it('command/exec: WMUX_* in env replaced by the pane identity', async () => {
    const seen:Req[]=[];
    const f=await fixture({policy:policy(),onUpstreamRequest:r=>seen.push(r),respond:(r)=>r.method==='command/exec'?{result:{exitCode:0}}:undefined});
    try {
      const client=await f.connect();const got=reply(client);
      client.send(JSON.stringify({id:1,method:'command/exec',params:{command:['env'],env:{WMUX_PTY_ID:'forged',FOO:'1'}}}));
      await got;
      const env=(seen.find(r=>r.method==='command/exec')!.params as {env:Record<string,unknown>}).env;
      expect(env).toMatchObject({FOO:'1',WMUX_PTY_ID:'pty-a',WMUX_WORKSPACE_ID:'ws-a',WMUX_AUTH_TOKEN:null});
      client.terminate();
    } finally { await f.cleanup(); }
  });

  it('refuses batches, unknown methods, and turns on a thread this pane does not own', async () => {
    const seen:Req[]=[];const p=policy();
    const f=await fixture({policy:p,onUpstreamRequest:r=>seen.push(r)});
    try {
      const client=await f.connect();
      let got=reply(client);client.send(JSON.stringify([{id:1,method:'thread/list'}]));
      await new Promise(r=>setTimeout(r,100));
      got=reply(client);client.send(JSON.stringify({id:2,method:'thread/secretNewThing',params:{}}));
      expect(await got).toMatchObject({id:2,error:{}});
      got=reply(client);client.send(JSON.stringify({id:3,method:'turn/start',params:{threadId:otherThreadId,input:[]}}));
      expect(await got).toMatchObject({id:3,error:{}});
      expect(seen.filter(r=>r.method!=='initialize')).toEqual([]);
      expect(p.refusals).toHaveLength(3);
      client.terminate();
    } finally { await f.cleanup(); }
  });

  it('refuses a resume of a thread owned by another live pane, or already loaded elsewhere', async () => {
    const seen:Req[]=[];const p=policy();p.owners.set(otherThreadId,'pty-b');
    const f=await fixture({policy:p,respond:respondWith([systemThreadId]),onUpstreamRequest:r=>seen.push(r)});
    try {
      const client=await f.connect();
      let got=reply(client);client.send(JSON.stringify({id:1,method:'thread/resume',params:{threadId:otherThreadId}}));
      expect(await got).toMatchObject({id:1,error:{}});
      got=reply(client);client.send(JSON.stringify({id:2,method:'thread/resume',params:{threadId:systemThreadId}}));
      expect(await got).toMatchObject({id:2,error:{}});
      expect(seen.some(r=>r.method==='thread/resume')).toBe(false);
      client.terminate();
    } finally { await f.cleanup(); }
  });

  it('on an unproven server, refuses when the MCP config or thread ownership cannot be determined', async () => {
    const seen:Req[]=[];
    const f=await fixture({policy:policy({serverProven:()=>false}),respond:(r)=>r.method==='config/read'||r.method==='thread/loaded/list'?{error:{message:'nope'}}:undefined,onUpstreamRequest:r=>seen.push(r)});
    try {
      const client=await f.connect();
      let got=reply(client);client.send(JSON.stringify({id:1,method:'thread/start',params:{}}));
      expect(await got).toMatchObject({id:1,error:{}});
      got=reply(client);client.send(JSON.stringify({id:2,method:'config/mcpServer/reload',params:{}}));
      expect(await got).toMatchObject({id:2,error:{}});
      expect(seen.some(r=>r.method==='thread/start'||r.method==='config/mcpServer/reload')).toBe(false);
      client.terminate();
    } finally { await f.cleanup(); }
  });

  it('tears the relay down when the pane never commits, instead of holding frames', async () => {
    const seen:Req[]=[];
    const f=await fixture({policy:policy({identity:()=>undefined}),onUpstreamRequest:r=>seen.push(r)});
    try {
      const client=await f.connect();
      const got=reply(client);
      client.send(JSON.stringify({id:1,method:'thread/start',params:{}}));
      expect(await got).toMatchObject({id:1,error:{}});
      await new Promise(r=>setTimeout(r,50));
      expect(f.relay.retired()).toBe(true);
      expect(seen.some(r=>r.method==='thread/start')).toBe(false);
    } finally { await f.cleanup(); }
  }, 10000);

  it('drops the connection when held frames exceed the bound', async () => {
    let release!:(v:Record<string,string>)=>void;
    let identity:Record<string,string>|undefined;
    void new Promise<Record<string,string>>(r=>{release=r;}).then(v=>{identity=v;});
    const f=await fixture({policy:policy({identity:()=>identity})});
    try {
      const client=await f.connect();
      client.send(JSON.stringify({id:0,method:'thread/start',params:{}}));
      for (let i=1;i<=70;i++) client.send(JSON.stringify({id:i,method:'model/list',params:{}}));
      await new Promise(r=>setTimeout(r,200));
      expect(f.relay.retired()).toBe(true);
      release(ID);
    } finally { await f.cleanup(); }
  });
});

describe.skipIf(process.platform === 'win32')('relay client responses',()=>{
  type Frame={id?:unknown;method?:unknown;params?:Record<string,unknown>;result?:unknown};
  // Frames measured against codex-cli 0.157.1: a server request, the TUI's answer, and the resolution notice.
  const approval=(id:number)=>({method:'item/commandExecution/requestApproval',id,params:{threadId,turnId:'turn-1',itemId:`call_${id}`}});
  const resolved=(id:number)=>({method:'serverRequest/resolved',params:{threadId,requestId:id}});
  const ID=threadIdentityEnv({id:'pty-a',env:{}},{});
  async function open(o:{unmatched?:number[];refusals?:string[];raw?:string[];identity?:()=>Record<string,string>|undefined}={}) {
    const answers:Frame[]=[];
    const policy:CodexRelayPolicy={paneId:'pty-a',identity:o.identity ?? (()=>ID),serverProven:()=>true,
      owner:()=>undefined,recordOwner:()=>{/* not exercised here */},
      refused:(reason)=>{o.refusals?.push(reason);},unmatchedResponse:(count)=>{o.unmatched?.push(count);}};
    const f=await fixture({policy,onUpstreamRequest:(r,raw)=>{o.raw?.push(raw);if(r.method===undefined)answers.push(r as Frame);}});
    const client=await f.connect();
    const deliver=async(frame:object)=>{
      const got=new Promise<void>(resolve=>client.once('message',()=>resolve()));
      up.send(JSON.stringify(frame));await got;
    };
    // A round trip through the relay: every client frame sent before it has been handled.
    const settle=async()=>{
      const got=new Promise<void>(resolve=>client.once('message',()=>resolve()));
      client.send(JSON.stringify({id:101,method:'model/list',params:{}}));await got;
    };
    await settle();
    // The relay's own upstream link; an identity request later opens a side query connection.
    const up=f.upstream()!;
    return {f,client,answers,deliver,settle,up};
  }

  it('forwards the TUI answer to a server request delivered on this connection', async () => {
    const {f,client,answers,deliver,settle}=await open();
    try {
      await deliver(approval(0));
      client.send(JSON.stringify({id:0,result:{decision:'accept'}}));
      await deliver(approval(3));
      client.send(JSON.stringify({id:3,error:{code:-32000,message:'cancelled'}}));
      await settle();
      expect(answers).toEqual([{id:0,result:{decision:'accept'}},{id:3,error:{code:-32000,message:'cancelled'}}]);
      expect(f.relay.retired()).toBe(false);
    } finally { client.terminate();await f.cleanup(); }
  });

  it('does not forward a response whose id has no pending server request, and sends nothing back', async () => {
    const unmatched:number[]=[];
    const {f,client,answers,deliver,settle}=await open({unmatched});
    try {
      await deliver(approval(1));
      const replies:unknown[]=[];client.on('message',b=>replies.push(JSON.parse(b.toString())));
      client.send(JSON.stringify({id:7,result:{decision:'accept'}}));
      client.send(JSON.stringify({id:'1',result:{decision:'accept'}}));
      await settle();
      expect(answers).toEqual([]);
      expect(unmatched).toEqual([1,2]);
      expect(replies.filter(r=>(r as Frame).id!==101)).toEqual([]);
      expect(f.relay.retired()).toBe(false);
    } finally { client.terminate();await f.cleanup(); }
  });

  it('forwards only the first response to a server request', async () => {
    const {f,client,answers,deliver,settle}=await open();
    try {
      await deliver(approval(4));
      client.send(JSON.stringify({id:4,result:{decision:'cancel'}}));
      client.send(JSON.stringify({id:4,result:{decision:'accept'}}));
      await settle();
      expect(answers).toEqual([{id:4,result:{decision:'cancel'}}]);
    } finally { client.terminate();await f.cleanup(); }
  });

  it('stops expecting an answer once the server reports the request resolved', async () => {
    const {f,client,answers,deliver,settle}=await open();
    try {
      await deliver(approval(2));
      await deliver(resolved(2));
      client.send(JSON.stringify({id:2,result:{decision:'accept'}}));
      await settle();
      expect(answers).toEqual([]);
    } finally { client.terminate();await f.cleanup(); }
  });

  it('forwards a normalized frame upstream', async () => {
    const raw:string[]=[];
    const {f,client,settle}=await open({raw});
    try {
      raw.length=0;
      client.send('{ "id": 7, "params": {"x": 1}, "method": "thread/list", "params": {} }');
      await settle();
      expect(raw[0]).toBe('{"id":7,"params":{},"method":"thread/list"}');
    } finally { client.terminate();await f.cleanup(); }
  });

  it('forwards an answer received while an earlier request waits, even if the request resolves meanwhile', async () => {
    let identity:Record<string,string>|undefined;
    const {f,client,answers,deliver}=await open({identity:()=>identity});
    try {
      const started=new Promise<void>(resolve=>client.on('message',b=>{if(JSON.parse(b.toString()).id===8)resolve();}));
      client.send(JSON.stringify({id:8,method:'thread/start',params:{}}));
      await deliver(approval(5));
      client.send(JSON.stringify({id:5,result:{decision:'accept'}}));
      await new Promise(r=>setTimeout(r,50));
      await deliver(resolved(5));
      identity=ID;
      await started;
      await new Promise(r=>setTimeout(r,50));
      expect(answers).toEqual([{id:5,result:{decision:'accept'}}]);
    } finally { client.terminate();await f.cleanup(); }
  });

  it('stops expecting answers for a thread once its turn completes', async () => {
    const {f,client,answers,deliver,settle}=await open();
    try {
      await deliver(approval(6));
      await deliver({method:'turn/completed',params:{threadId,turn:{id:'turn-1'}}});
      client.send(JSON.stringify({id:6,result:{decision:'accept'}}));
      await settle();
      expect(answers).toEqual([]);
    } finally { client.terminate();await f.cleanup(); }
  });

  it('closes the connection with a notice when too many requests await an answer', async () => {
    const refusals:string[]=[];
    const {f,client,up}=await open({refusals});
    try {
      let received=0;
      const all=new Promise<void>(resolve=>client.on('message',()=>{if(++received===257)resolve();}));
      for (let i=0;i<256;i++) up.send(JSON.stringify(approval(i)));
      up.send(JSON.stringify(approval(0)));
      await all;
      expect(f.relay.retired()).toBe(false);
      const closed=new Promise<void>(resolve=>client.once('close',()=>resolve()));
      up.send(JSON.stringify(approval(256)));
      await closed;
      expect(f.relay.retired()).toBe(true);
      expect(refusals).toHaveLength(1);
    } finally { client.terminate();await f.cleanup(); }
  });
});

// Phone answers to Codex approvals. The relay writes one kind of frame
// upstream on its own: the bare answer to a server request that is still
// awaiting one on this connection, for a thread this pane owns.
describe.skipIf(process.platform === 'win32')('phone answers to Codex approvals',()=>{
  const measured=JSON.parse(readFileSync(path.join(__dirname,'fixtures','codex-server-requests.json'),'utf8')) as
    {serverRequests:Record<string,{request:{method:string;id:number;params:Record<string,unknown>}}>};
  const command=measured.serverRequests['item/commandExecution/requestApproval']!.request;
  const owned=command.params.threadId as string;
  const foreign='33333333-89ab-4cde-8123-456789abcdef';
  const request=(id:number|string,params:Record<string,unknown>={})=>({...command,id,params:{...command.params,...params}});
  type Owner=(threadId:string)=>{paneId:string;live:boolean}|undefined;
  async function open(o:{owner?:Owner;answerConfirmMs?:number}={}) {
    const raw:string[]=[];const unmatched:number[]=[];
    const pending:Array<{requestId:string;request:CodexDecisionRequest}>=[];
    const settled:Array<{requestId:string;threadId:string;reason:CodexDecisionSettledReason}>=[];
    const owners:{current:Owner}={current:o.owner ?? (id=>id===owned ? {paneId:'pty-a',live:true} : {paneId:'pty-b',live:true})};
    const policy:CodexRelayPolicy={paneId:'pty-a',identity:()=>threadIdentityEnv({id:'pty-a',env:{}},{}),serverProven:()=>true,
      owner:(id)=>owners.current(id),recordOwner:()=>{/* not exercised here */},
      unmatchedResponse:(count)=>{unmatched.push(count);},
      decisionPending:(requestId,r)=>{pending.push({requestId,request:r});},
      decisionSettled:(requestId,threadId,reason)=>{settled.push({requestId,threadId,reason});}};
    const f=await fixture({policy,answerConfirmMs:o.answerConfirmMs,onUpstreamRequest:(r,text)=>{if(r.method===undefined)raw.push(text);}});
    const client=await f.connect();
    const deliver=async(frame:object)=>{
      const got=new Promise<void>(resolve=>client.once('message',()=>resolve()));
      f.upstream()!.send(JSON.stringify(frame));await got;
    };
    // A round trip through the relay: every frame sent before it has been handled.
    const settle=async()=>{
      const got=new Promise<void>(resolve=>client.once('message',()=>resolve()));
      client.send(JSON.stringify({id:101,method:'model/list',params:{}}));await got;
    };
    await settle();
    return {f,client,raw,unmatched,pending,settled,owners,deliver,settle};
  }

  it('records an owned approval, injects the bare answer under the server id (id 0 included), and confirms it only on resolved', async () => {
    const t=await open();
    try {
      await t.deliver(request(0));
      expect(t.pending).toEqual([{requestId:'0',request:{method:'item/commandExecution/requestApproval',threadId:owned,
        question:'Create out.txt in the project?',toolName:'command',summary:"/bin/zsh -lc 'touch out.txt'"}}]);
      let outcome:string|undefined;
      const answered=t.f.relay.answer(owned,'0','accept').then(o=>{outcome=o;return o;});
      await t.settle();
      expect(t.raw).toEqual(['{"id":0,"result":{"decision":"accept"}}']);
      // Written is not answered: still waiting for the server's word.
      expect(outcome).toBeUndefined();
      // Phone first: the TUI's later answer to the same id is not forwarded,
      // and a second phone answer is refused.
      t.client.send(JSON.stringify({id:0,result:{decision:'cancel'}}));
      await expect(t.f.relay.answer(owned,'0','accept')).resolves.toBe('not-found');
      await t.deliver({method:'serverRequest/resolved',params:{threadId:owned,requestId:0}});
      await expect(answered).resolves.toBe('ok');
      await t.settle();
      expect(t.raw).toHaveLength(1);
      expect(t.unmatched).toEqual([1]);
      expect(t.settled).toEqual([]);
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('is uncertain, and settles the record, when the server never confirms the answer', async () => {
    const t=await open({answerConfirmMs:30});
    try {
      await t.deliver(request(11));
      await expect(t.f.relay.answer(owned,'11','accept')).resolves.toBe('uncertain');
      expect(t.settled).toEqual([{requestId:'11',threadId:owned,reason:'prompt-gone'}]);
      // A resolved notice after that changes nothing.
      await t.deliver({method:'serverRequest/resolved',params:{threadId:owned,requestId:11}});
      expect(t.settled).toHaveLength(1);
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('is uncertain when the connection drops before the server confirms, and settles the record', async () => {
    const t=await open();
    try {
      await t.deliver(request(12));
      const answered=t.f.relay.answer(owned,'12','cancel');
      await new Promise(r=>setTimeout(r,20));
      t.f.upstream()!.terminate();
      await expect(answered).resolves.toBe('uncertain');
      expect(t.settled).toEqual([{requestId:'12',threadId:owned,reason:'prompt-gone'}]);
      expect(t.f.relay.retired()).toBe(true);
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('is uncertain, settles the record and retires the relay when the write fails', async () => {
    const t=await open();
    const send=WebSocket.prototype.send;
    try {
      await t.deliver(request(15));
      WebSocket.prototype.send=function(this:WebSocket,data:unknown,...rest:unknown[]){
        const cb=rest.find(a=>typeof a==='function') as ((e?:Error)=>void)|undefined;
        if (String(data).includes('"decision"')) { cb?.(new Error('write failed'));return; }
        return (send as (...a:unknown[])=>void).call(this,data,...rest);
      } as typeof send;
      await expect(t.f.relay.answer(owned,'15','accept')).resolves.toBe('uncertain');
      WebSocket.prototype.send=send;
      expect(t.settled).toEqual([{requestId:'15',threadId:owned,reason:'prompt-gone'}]);
      expect(t.f.relay.retired()).toBe(true);
    } finally { WebSocket.prototype.send=send;t.client.terminate();await t.f.cleanup(); }
  });

  it('confirms on a resolved notice that carries no thread id', async () => {
    const t=await open();
    try {
      await t.deliver(request(13));
      const answered=t.f.relay.answer(owned,'13','accept');
      await t.settle();
      await t.deliver({method:'serverRequest/resolved',params:{requestId:13}});
      await expect(answered).resolves.toBe('ok');
      await t.deliver(request(14));
      await t.deliver({method:'serverRequest/resolved',params:{requestId:14}});
      expect(t.settled).toEqual([{requestId:'14',threadId:owned,reason:'answered-locally'}]);
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('keeps a string server id a string, apart from the numeric id of the same digits', async () => {
    const t=await open();
    try {
      await t.deliver(request('7'));
      expect(t.pending[0]?.requestId).toBe('s:7');
      await expect(t.f.relay.answer(owned,'7','cancel')).resolves.toBe('not-found');
      const answered=t.f.relay.answer(owned,'s:7','cancel');
      await t.settle();
      expect(t.raw).toEqual(['{"id":"7","result":{"decision":"cancel"}}']);
      await t.deliver({method:'serverRequest/resolved',params:{threadId:owned,requestId:'7'}});
      await expect(answered).resolves.toBe('ok');
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('TUI first: settles the moment its answer arrives; a phone answer before the late resolved is never injected', async () => {
    const t=await open();
    try {
      await t.deliver(request(1));
      t.client.send(JSON.stringify({id:1,result:{decision:'accept'}}));
      await t.settle();
      expect(t.settled).toEqual([{requestId:'1',threadId:owned,reason:'answered-locally'}]);
      // resolved has not arrived yet: the phone still finds nothing to answer.
      await expect(t.f.relay.answer(owned,'1','cancel')).resolves.toBe('not-found');
      await t.deliver({method:'serverRequest/resolved',params:{threadId:owned,requestId:1}});
      await t.settle();
      expect(t.raw).toEqual(['{"id":1,"result":{"decision":"accept"}}']);
      expect(t.settled).toHaveLength(1);
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('settles the same way when another client answered first', async () => {
    const t=await open();
    try {
      await t.deliver(request(2));
      await t.deliver({method:'serverRequest/resolved',params:{threadId:owned,requestId:2}});
      expect(t.settled).toEqual([{requestId:'2',threadId:owned,reason:'answered-locally'}]);
      await expect(t.f.relay.answer(owned,'2','accept')).resolves.toBe('not-found');
      expect(t.raw).toEqual([]);
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('ignores a thread this pane does not own, and one whose owning pane is not live', async () => {
    const t=await open({owner:id=>id===owned ? {paneId:'pty-a',live:false} : {paneId:'pty-b',live:true}});
    try {
      await t.deliver(request(3));
      await t.deliver(request(4,{threadId:foreign}));
      expect(t.pending).toEqual([]);
      await expect(t.f.relay.answer(owned,'3','accept')).resolves.toBe('not-found');
      await expect(t.f.relay.answer(foreign,'4','accept')).resolves.toBe('not-found');
      await t.settle();
      expect(t.raw).toEqual([]);
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('refuses an answer naming another thread, or after another pane took the thread', async () => {
    const t=await open();
    try {
      await t.deliver(request(5));
      await expect(t.f.relay.answer(foreign,'5','accept')).resolves.toBe('not-found');
      t.owners.current=()=>({paneId:'pty-b',live:true});
      await expect(t.f.relay.answer(owned,'5','accept')).resolves.toBe('not-found');
      await t.settle();
      expect(t.raw).toEqual([]);
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('offers only a request whose own choices include accept and cancel', async () => {
    const t=await open();
    try {
      await t.deliver(request(6,{availableDecisions:['accept',{acceptWithExecpolicyAmendment:{execpolicy_amendment:['x']}},'decline']}));
      await t.deliver({method:'mcpServer/elicitation/request',id:7,params:{threadId:owned,mode:'form',message:'m'}});
      expect(t.pending).toEqual([]);
      await expect(t.f.relay.answer(owned,'6','accept')).resolves.toBe('not-found');
    } finally { t.client.terminate();await t.f.cleanup(); }
  });

  it('settles on turn/completed, and everything on disconnect, since ids restart with the next connection', async () => {
    const t=await open();
    try {
      await t.deliver(request(8));
      await t.deliver({method:'turn/completed',params:{threadId:owned,turn:{id:'turn-1'}}});
      expect(t.settled).toEqual([{requestId:'8',threadId:owned,reason:'turn-ended'}]);
      await t.deliver(request(10));
      const closed=new Promise<void>(resolve=>t.client.once('close',()=>resolve()));
      t.client.terminate();await closed;
      await new Promise(r=>setTimeout(r,20));
      expect(t.settled.at(-1)).toEqual({requestId:'10',threadId:owned,reason:'pane-gone'});
      await expect(t.f.relay.answer(owned,'10','accept')).resolves.toBe('not-found');
    } finally { await t.f.cleanup(); }
  });
});
describe.skipIf(process.platform === 'win32')('Codex relay turn identity and native interrupt',()=>{
  const deliver=async(f:Awaited<ReturnType<typeof fixture>>,client:WebSocket,message:unknown)=>{
    const seen=new Promise<void>(resolve=>client.once('message',()=>resolve()));
    f.upstream()?.send(JSON.stringify(message));
    await seen;
  };
  it('keeps the running turn from turn/started until that turn\'s turn/completed, and reports how it ended',async()=>{
    const f=await fixture();
    try {
      const client=await f.connect();await select(client,1);
      await deliver(f,client,{method:'turn/started',params:{threadId,turn:{id:'turn-1',status:'inProgress'}}});
      expect(f.relay.activeTurn(threadId)).toBe('turn-1');
      const wait=f.relay.waitTurnEnd(threadId,'turn-1',2000);
      let settled:string|undefined='pending';
      void wait.ended.then(status=>{settled=status;});
      // Another turn's end is not this turn's.
      await deliver(f,client,{method:'turn/completed',params:{threadId,turn:{id:'turn-0',status:'interrupted'}}});
      expect(settled).toBe('pending');
      expect(f.relay.activeTurn(threadId)).toBe('turn-1');
      await deliver(f,client,{method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'interrupted'}}});
      await expect(wait.ended).resolves.toBe('interrupted');
      expect(f.relay.activeTurn(threadId)).toBeUndefined();
      expect(f.relay.turnEnded(threadId,'turn-1')).toBe('interrupted');
      // A wait for a turn already seen ending answers at once.
      await expect(f.relay.waitTurnEnd(threadId,'turn-1',2000).ended).resolves.toBe('interrupted');
      // A wait with no end in time reads undefined; so does one after close.
      await expect(f.relay.waitTurnEnd(threadId,'turn-2',20).ended).resolves.toBeUndefined();
      const open=f.relay.waitTurnEnd(threadId,'turn-3',5000);
      client.terminate();await f.relay.close();
      await expect(open.ended).resolves.toBeUndefined();
      expect(f.relay.activeTurn(threadId)).toBeUndefined();
    } finally {await f.cleanup();}
  });
  it('keeps a recently ended turn through a burst of other turns (a cancel\'s observation window)',async()=>{
    const f=await fixture();
    try {
      const client=await f.connect();await select(client,1);
      await deliver(f,client,{method:'turn/completed',params:{threadId,turn:{id:'turn-aimed',status:'interrupted'}}});
      for(let i=0;i<300;i++)await deliver(f,client,{method:'turn/completed',params:{threadId:otherThreadId,turn:{id:`burst-${i}`,status:'completed'}}});
      expect(f.relay.turnEnded(threadId,'turn-aimed')).toBe('interrupted');
      client.terminate();
    } finally {await f.cleanup();}
  });
  it('sends turn/interrupt on a side connection: an error answer is a refusal, silence is bounded, {} is only an answer',async()=>{
    const interrupts:Array<Record<string,unknown>|undefined>=[];
    const f=await fixture({respond:request=>{
      if(request.method!=='turn/interrupt')return undefined;
      interrupts.push(request.params);
      if(request.params?.turnId==='wrong')return {error:{code:-32600,message:'expected active turn id turn-1 but found wrong'}};
      if(request.params?.turnId==='finished')return null;
      return {result:{}};
    }});
    try {
      const client=await f.connect();await select(client,1);
      await expect(f.relay.interrupt(threadId,'wrong',2000)).rejects.toMatchObject({kind:'refused'});
      const hung=f.relay.interrupt(threadId,'finished',100);
      await expect(hung).rejects.toBeInstanceOf(CodexUpstreamError);
      await expect(hung).rejects.toMatchObject({kind:'uncertain'});
      await expect(f.relay.interrupt(threadId,'turn-1',2000)).resolves.toEqual({});
      expect(interrupts).toEqual([{threadId,turnId:'wrong'},{threadId,turnId:'finished'},{threadId,turnId:'turn-1'}]);
      // The pane's own link is untouched: its stream still reaches the TUI.
      await deliver(f,client,{method:'turn/started',params:{threadId,turn:{id:'turn-9'}}});
      expect(f.relay.activeTurn(threadId)).toBe('turn-9');
      client.terminate();
    } finally {await f.cleanup();}
  });
});
