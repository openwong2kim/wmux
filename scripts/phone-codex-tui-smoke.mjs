// Real TUI attribution and recovery against an owned loopback-only provider fixture.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,access,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

// Keep below Unix sockaddr path limits even on macOS's long TMPDIR.
const directory=await mkdtemp('/tmp/wmux-codex-socket-');
const socketPath=path.join(directory,'app-server-control','app-server-control.sock');
await mkdir(path.dirname(socketPath),{mode:0o700});
let child,closed,connection,tui,tuiClosed,relay,registry,managed,httpServer,manager;
const methods=[];
const paneId='web-01234567-89ab-4cde-8123-456789abcdef';
let terminalText='';
let firstText='';
let trustedFixture=false;
let stderr='';
let providerRequests=0;
const provider=createServer((req,res)=>{
  providerRequests++;req.resume();
  res.writeHead(400,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:{message:'Intentional local recovery fixture failure',type:'invalid_request_error',code:'fixture_refusal'}}));
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const providerURL=`http://127.0.0.1:${provider.address().port}/v1`;
try {
  const bundle=path.join(directory,'transport.cjs');
  await build({entryPoints:['src/daemon/web/codexSettingsTransport.ts'],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent'});
  const {connectCodexSettings}=await import(pathToFileURL(bundle).href);
  const relayBundle=path.join(directory,'relay.cjs');
  await build({entryPoints:['src/daemon/web/codexPaneRelays.ts'],bundle:true,platform:'node',format:'cjs',outfile:relayBundle,logLevel:'silent'});
  const {CodexPaneRelays}=await import(pathToFileURL(relayBundle).href);
  const paneBundle=path.join(directory,'pane.cjs');
  await build({stdin:{contents:"export {paneCodexSettings} from './src/daemon/web/paneCodexSettings'; export {WebTerminalServer} from './src/daemon/web/WebTerminalServer'; export {recoverCodexPane} from './src/daemon/web/recoverCodexPane'; export {DaemonSessionManager} from './src/daemon/DaemonSessionManager';",resolveDir:process.cwd(),loader:'ts'},plugins:[{name:'native-pty',setup(builder){builder.onResolve({filter:/^node-pty$/},()=>({path:createRequire(import.meta.url).resolve('node-pty'),external:true}));}}],bundle:true,platform:'node',format:'cjs',outfile:paneBundle,logLevel:'silent'});
  const {paneCodexSettings,WebTerminalServer,recoverCodexPane,DaemonSessionManager}=await import(pathToFileURL(paneBundle).href);
  child=spawn('codex',['app-server','--listen',`unix://${socketPath}`,
    '-c','tui.animations=false','-c','model_provider="wmux_fixture"','-c','model="fixture-a"',
    '-c','model_providers.wmux_fixture.name="wmux fixture"',
    '-c',`model_providers.wmux_fixture.base_url="${providerURL}"`,
    '-c','model_providers.wmux_fixture.wire_api="responses"',
    '-c','model_providers.wmux_fixture.requires_openai_auth=false'],{
      cwd:directory,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CODEX_HOME:directory},stdio:['ignore','ignore','pipe'],detached:true,
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
  const rawRelayBundle=path.join(directory,'raw-relay.cjs');
  await build({entryPoints:['src/daemon/web/codexTuiRelay.ts'],bundle:true,platform:'node',format:'cjs',outfile:rawRelayBundle,logLevel:'silent'});
  const {createCodexTuiRelay}=await import(pathToFileURL(rawRelayBundle).href);
  registry=new CodexPaneRelays(options=>createCodexTuiRelay({...options,onRequestMethod:method=>{if(methods.length<256)methods.push(method);}}));
  const lease=await registry.prepare(paneId,directory);
  relay={url:lease.url,current:()=>registry.selection(paneId,managed),close:()=>registry.shutdown()};
  manager=new DaemonSessionManager();
  manager.on('session:died',({id})=>{void registry.retire(id);});
  manager.on('session:destroyed',({id})=>{void registry.retire(id);});
  const originalCommand='codex --model fixture-a -c model_reasoning_effort=low';
  const paneEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CODEX_HOME:directory,TERM:'xterm-256color'};
  await manager.createSessionAsync({id:paneId,cmd:'/bin/zsh',cwd:directory,cols:120,rows:40,env:paneEnv,
    exec:{command:originalCommand},execLaunchCommand:`${originalCommand} --remote ${lease.url} --no-alt-screen`});
  managed=manager.getSession(paneId);
  assert(managed,'The real manager must own the created PTY');
  tui=managed.ptyProcess;
  assert.equal(manager.listSessions()[0].exec.command,originalCommand);
  assert(!JSON.stringify(manager.listSessions()).includes(lease.url));
  assert(lease.commit(managed),'The relay must bind to the created pane');
  tuiClosed=new Promise(resolve=>tui.onExit(resolve));
  const observeTui=()=>tui.onData(data=>{
    terminalText=(terminalText+data).slice(-8192);
    if(firstText.length<16384)firstText+=data;
    const visible=firstText.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\s/g,'');
    if(!trustedFixture && visible.includes('Doyoutrustthecontentsofthisdirectory?') && visible.includes('Yes,continue')) {
      trustedFixture=true;
      setTimeout(()=>tui?.write('\r'),300); // Own empty fixture directory only.
    }
    if(data.includes('\x1b[6n'))tui.write('\x1b[1;1R');
  });
  observeTui();
  const tuiDeadline=Date.now()+15000;
  while(!relay.current() && Date.now()<tuiDeadline)await new Promise(resolve=>setTimeout(resolve,50));
  assert(relay.current(),`TUI did not select a thread; trusted=${trustedFixture}; methods=${JSON.stringify(methods)}; screen=${firstText}`);
  const threadId=relay.current().threadId;
  connection=await connectCodexSettings({cwd:directory,codeHome:directory});
  assert.equal((await connection.rpc('thread/read',{threadId,includeTurns:false})).thread.model,'fixture-a');
  await connection.rpc('thread/settings/update',{threadId,model:'fixture-b',effort:'low'});
  connection.close();connection=undefined;
  // A second production connection must observe the same live thread.
  connection=await connectCodexSettings({cwd:directory,codeHome:directory});
  assert.equal((await connection.rpc('thread/read',{threadId,includeTurns:false})).thread.model,'fixture-b');
  await new Promise(resolve=>setTimeout(resolve,500));
  tui.write('/new');
  await new Promise(resolve=>setTimeout(resolve,300));
  tui.write('\r');
  const switchDeadline=Date.now()+5000;
  while((!relay.current() || relay.current().threadId===threadId) && Date.now()<switchDeadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert(relay.current(),'A new thread must be confirmed');
  assert.notEqual(relay.current().threadId,threadId,`A TUI /new must select a different correlated thread; methods=${JSON.stringify(methods)}; screen=${terminalText}`);
  const next=await connection.rpc('thread/read',{threadId:relay.current().threadId,includeTurns:false});
  assert.equal(next.thread.id,relay.current().threadId);
  const dependencies={session:()=>managed,agentName:()=> 'Codex CLI',selection:()=>{
    return registry.selection(paneId,managed);
  }};
  httpServer=new WebTerminalServer({sessionManager:manager,assetsDir:directory,log:()=>{},
    agentSettings:(id,authorized,choice)=>paneCodexSettings(dependencies,id,authorized,choice)});
  const status=await httpServer.start({host:'127.0.0.1',port:0,allowInput:true,allowTranscript:true,allowUpload:false});
  const base=`http://127.0.0.1:${status.port}`;
  const headers={Authorization:`Bearer ${status.token}`,'Content-Type':'application/json'};
  const config=await (await fetch(`${base}/api/config`,{headers})).json();
  assert.equal(config.agentSettings,true);
  const read=await fetch(`${base}/api/sessions/${paneId}/agent-settings`,{headers});
  assert.equal(read.status,200);
  const snapshot=await read.json();
  const choice=snapshot.models[0];
  assert(choice,'The server must advertise at least one model for this control probe');
  const changed=await fetch(`${base}/api/sessions/${paneId}/agent-settings`,{method:'POST',headers,
    body:JSON.stringify({model:choice.model,effort:choice.defaultEffort,expectedRevision:snapshot.revision})});
  assert.equal(changed.status,200);
  const confirmed=await changed.json();
  assert.equal(confirmed.model,choice.model);assert.equal(confirmed.effort,choice.defaultEffort);

  // Exercise the recovery helper with the actual manager, native PTY and relay.
  // This remains an in-process harness, not a full daemon process restart.
  const resumedThread=relay.current().threadId;
  // Empty TUI threads have no durable rollout. Make one deliberately failed
  // turn against the owned loopback fixture so disk-based resume is exercised.
  await new Promise(resolve=>setTimeout(resolve,500));
  tui.write('Local recovery fixture');
  await new Promise(resolve=>setTimeout(resolve,300));tui.write('\r');
  const persistedDeadline=Date.now()+15000;
  let durable=false;
  let persistenceState;
  while(Date.now()<persistedDeadline) {
    const state=(await connection.rpc('thread/read',{threadId:resumedThread,includeTurns:false})).thread;
    persistenceState={status:state.status,path:state.path};
    if(providerRequests>0 && ['idle','systemError'].includes(state.status.type) && state.path) {
      try{await access(state.path);durable=true;break;}catch{}
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(durable,`The failed local fixture turn must leave a durable non-running thread: requests=${providerRequests}, state=${JSON.stringify(persistenceState)}, methods=${JSON.stringify(methods)}, screen=${terminalText}`);
  const previousRelay=relay.current().relayId;
  connection.close();connection=undefined;
  tui.kill();
  const exitTimer=setTimeout(()=>{try{tui.kill('SIGKILL');}catch{}},1000);
  await tuiClosed;clearTimeout(exitTimer);
  await registry.retire(paneId);
  assert.equal(relay.current(),undefined);
  manager.destroySession(paneId);
  await recoverCodexPane(manager,registry,{id:paneId,cmd:'/bin/zsh',cwd:directory,cols:120,rows:40,env:paneEnv,
    exec:{command:originalCommand},
    execLaunchCommand:`codex resume ${resumedThread} --model fixture-a -c model_reasoning_effort=low`});
  managed=manager.getSession(paneId);
  assert(managed,'Recovery must install a real managed session');
  tui=managed.ptyProcess;
  tuiClosed=new Promise(resolve=>tui.onExit(resolve));observeTui();
  assert.equal(manager.listSessions()[0].exec.command,originalCommand);
  assert(!JSON.stringify(manager.listSessions()).includes('--remote'));
  const recoveryDeadline=Date.now()+15000;
  while(!relay.current() && Date.now()<recoveryDeadline)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(relay.current()?.threadId,resumedThread,`Recovery must confirm the exact resumed thread; screen=${terminalText}`);
  assert.notEqual(relay.current().relayId,previousRelay);
  const recoveredRead=await fetch(`${base}/api/sessions/${paneId}/agent-settings`,{headers});
  if(recoveredRead.status!==200) {
    connection=await connectCodexSettings({cwd:directory,codeHome:directory});
    const state=(await connection.rpc('thread/read',{threadId:resumedThread,includeTurns:false})).thread;
    throw new Error(`Recovered settings refused: HTTP ${recoveredRead.status}, status=${JSON.stringify(state.status)}, selection=${JSON.stringify(relay.current())}`);
  }
  const recoveredSettings=await recoveredRead.json();
  assert.notEqual(recoveredSettings.revision,confirmed.revision);
  const stale=await fetch(`${base}/api/sessions/${paneId}/agent-settings`,{method:'POST',headers,
    body:JSON.stringify({model:choice.model,effort:choice.defaultEffort,expectedRevision:confirmed.revision})});
  assert.equal(stale.status,409);
  const repaired=await fetch(`${base}/api/sessions/${paneId}/agent-settings`,{method:'POST',headers,
    body:JSON.stringify({model:choice.model,effort:choice.defaultEffort,expectedRevision:recoveredSettings.revision})});
  assert.equal(repaired.status,200);
  assert.equal((await repaired.json()).model,choice.model);


  assert(methods.includes('turn/start') && providerRequests>0,'The recovery fixture must reach only its owned loopback provider');
  console.log(JSON.stringify({ok:true,transport:'unix-websocket',productionTransport:true,realTUI:true,paneSettingsControl:true,httpSettings:true,paneRelayRegistry:true,realSessionManager:true,correlatedThread:true,newThreadSwitch:true,reconnect:true,recoveredTUI:true,staleRecoveryRevision:true,failedTurnSettingsRepair:true,tuiMethods:methods,turnStarted:true,providerNetwork:'owned-loopback-fixture',providerRequests}));
} catch(error) {
  console.error(String(error));if(stderr)console.error(stderr);process.exitCode=1;
} finally {
  provider.closeAllConnections();
  await new Promise(resolve=>provider.close(resolve));
  await httpServer?.stop();
  connection?.close();
  if(tui) {
    try{tui.kill();}catch{}
    const timer=setTimeout(()=>{try{tui.kill('SIGKILL');}catch{}},1000);
    await tuiClosed;clearTimeout(timer);
  }
  manager?.disposeAll();
  await relay?.close();
  if(child) {
    const killGroup=signal=>{if(child.pid)try{process.kill(-child.pid,signal);}catch{}};
    killGroup('SIGTERM');
    const timer=setTimeout(()=>killGroup('SIGKILL'),2000);
    await closed;clearTimeout(timer);killGroup('SIGKILL');
  }
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
