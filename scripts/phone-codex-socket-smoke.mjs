// Real Unix WebSocket + production settings transport, with no provider turn.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,access,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {build} from 'esbuild';

// Keep below Unix sockaddr path limits even on macOS's long TMPDIR.
const directory=await mkdtemp('/tmp/wmux-codex-socket-');
const socketPath=path.join(directory,'app-server-control','app-server-control.sock');
await mkdir(path.dirname(socketPath),{mode:0o700});
let child,closed,owner,connection;
let stderr='';
const pending=new Map();
let serial=0;
try {
  const bundle=path.join(directory,'transport.cjs');
  await build({entryPoints:['src/daemon/web/codexSettingsTransport.ts'],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent'});
  const {connectCodexSettings}=await import(pathToFileURL(bundle).href);
  child=spawn('codex',['app-server','--listen',`unix://${socketPath}`,
    '-c','model_provider="wmux_fixture"','-c','model="fixture-a"',
    '-c','model_providers.wmux_fixture.name="wmux fixture"',
    '-c','model_providers.wmux_fixture.base_url="http://127.0.0.1:9/v1"',
    '-c','model_providers.wmux_fixture.wire_api="responses"',
    '-c','model_providers.wmux_fixture.requires_openai_auth=false'],{
      cwd:directory,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CODEX_HOME:directory},stdio:['ignore','ignore','pipe'],
    });
  closed=new Promise(resolve=>child.once('close',resolve));
  let startError;
  child.on('error',error=>{startError=error;});
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-4096);});
  const deadline=Date.now()+10000;
  while(true) {
    if(startError || child.exitCode!==null || child.signalCode!==null) throw startError ?? new Error('Server exited');
    try {await access(socketPath);break;} catch {}
    if(Date.now()>deadline) throw new Error('Socket startup timed out');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  owner=new WebSocket(`ws+unix://${socketPath}:/`,{handshakeTimeout:5000,maxPayload:2*1024*1024,perMessageDeflate:false});
  owner.on('error',()=>{});
  owner.on('message',bytes=>{
    const message=JSON.parse(bytes.toString());
    const entry=pending.get(message.id);
    if(!entry)return;
    pending.delete(message.id);clearTimeout(entry.timer);
    if(message.error)entry.reject(new Error('Fixture RPC failed'));else entry.resolve(message.result);
  });
  await new Promise((resolve,reject)=>{owner.once('open',resolve);owner.once('error',reject);});
  const request=(method,params)=>new Promise((resolve,reject)=>{
    const id=++serial;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timed out: ${method}`));},5000);
    pending.set(id,{resolve,reject,timer});owner.send(JSON.stringify({id,method,params}));
  });
  await request('initialize',{clientInfo:{name:'wmux_socket_fixture',version:'1.0.0'},capabilities:{experimentalApi:true,requestAttestation:false}});
  owner.send(JSON.stringify({method:'initialized'}));
  const started=await request('thread/start',{model:'fixture-a',modelProvider:'wmux_fixture',cwd:directory,ephemeral:true,approvalPolicy:'never',sandbox:'read-only'});
  const threadId=started.thread.id;
  connection=await connectCodexSettings({cwd:directory,codeHome:directory});
  assert.equal((await connection.rpc('thread/read',{threadId,includeTurns:false})).thread.model,'fixture-a');
  await connection.rpc('thread/settings/update',{threadId,model:'fixture-b',effort:'low'});
  connection.close();connection=undefined;
  const after=await request('thread/read',{threadId,includeTurns:false});
  assert.equal(after.thread.model,'fixture-b');assert.equal(after.thread.reasoningEffort,'low');
  // A second production connection must observe the same live thread.
  connection=await connectCodexSettings({cwd:directory,codeHome:directory});
  assert.equal((await connection.rpc('thread/read',{threadId,includeTurns:false})).thread.model,'fixture-b');
  console.log(JSON.stringify({ok:true,transport:'unix-websocket',productionTransport:true,independentOwnerReadback:true,reconnect:true,turnStarted:false}));
} catch(error) {
  console.error(String(error));if(stderr)console.error(stderr);process.exitCode=1;
} finally {
  connection?.close();owner?.terminate();
  for(const entry of pending.values())clearTimeout(entry.timer);
  if(child) {child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await closed;clearTimeout(timer);}
  await rm(directory,{recursive:true,force:true});
}
