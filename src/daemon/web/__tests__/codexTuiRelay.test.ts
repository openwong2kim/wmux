import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,stat,access,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {describe,it,expect} from 'vitest';
import {createCodexTuiRelay,CodexRelayUnavailableError,type CodexRelayPolicy} from '../codexTuiRelay';
import {threadIdentityEnv} from '../codexRelayPolicy';
const threadId='01234567-89ab-4cde-8123-456789abcdef';
const systemThreadId='11111111-89ab-4cde-8123-456789abcdef';
const otherThreadId='22222222-89ab-4cde-8123-456789abcdef';
async function fixture(options:{linked?:boolean; onStateChange?:()=>void; onUpstreamRequest?:(request:{id?:unknown;method?:unknown;params?:Record<string,unknown>})=>void; policy?:CodexRelayPolicy; respond?:(request:{id?:unknown;method?:unknown;params?:Record<string,unknown>})=>unknown}={}) {
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
      if(request.id===undefined)return;
      const custom=ready?options.respond?.(request):undefined;
      if(custom!==undefined){socket.send(JSON.stringify({id:request.id,...(custom as object)}));return;}
      const system=request.params?.threadSource==='system';
      socket.send(JSON.stringify({id:request.id,result:{thread:{id:system?systemThreadId:threadId,cwd:'/repo'}}}));
    });
  });
  const actualPath = options.linked ? path.join(home, 'actual.sock') : upstreamPath;
  await new Promise<void>(resolve=>server.listen(actualPath,resolve));
  if (options.linked) await symlink(actualPath, upstreamPath);
  const relay=await createCodexTuiRelay({codeHome:home,onStateChange:options.onStateChange,policy:options.policy});
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
