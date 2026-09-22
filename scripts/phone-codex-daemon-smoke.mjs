// Full isolated daemon process launch/restart against an owned local Codex provider.
// Default: graceful `daemon.shutdown` restart. With `--kill`: no shutdown RPC and no
// state-saving RPC after the fixture turns — the daemon is SIGKILLed, so only the
// event-driven relay persistence can make each pane's thread binding durable.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat,access,rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const directory=await mkdtemp('/tmp/wmux-phone-daemon-');
const suffix=`-phone-${randomUUID().slice(0,8)}`;
const dataDir=path.join(os.homedir(),`.wmux${suffix}`);
const pipePath=path.join(directory,'control.sock');
const serverSocket=path.join(directory,'app-server-control','app-server-control.sock');
const token=randomUUID();
const require=createRequire(import.meta.url);
const killMode=process.argv.includes('--kill');
// `--account-server-death`: the ACCOUNT SERVER dies, not the daemon. Losing the
// relay transport must preserve each pane's last confirmed resume hint.
const deathMode=process.argv.includes('--account-server-death');
const statePath=path.join(dataDir,'sessions.json');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminals=new Set();
let daemon,daemonClosed,codex,codexClosed,control,terminal;
let daemonLog='',codexLog='',screen='',trusted=false,providerRequests=0,ownsDataDir=false;
const provider=createServer((req,res)=>{providerRequests++;req.resume();res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Local recovery fixture',type:'invalid_request_error'}}));});
const environment={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CODEX_HOME:directory,WMUX_DATA_SUFFIX:suffix};
async function until(check,description,timeout=20000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await delay(50);}
  throw new Error(`Timed out: ${description}`);
}
function connect(socketPath){return new Promise((resolve,reject)=>{const s=net.createConnection(socketPath);s.once('error',reject);s.once('connect',()=>resolve(s));});}
async function rpc(method,params={}) {
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
    let buffer='';
    const cleanup=()=>{clearTimeout(timer);control?.off('data',onData);};
    const onData=chunk=>{
      buffer+=chunk.toString();const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines){let value;try{value=JSON.parse(line);}catch{continue;}
        if(value.id===id){cleanup();if(value.ok)resolve(value.result);else reject(new Error(`${method}: ${value.error}`));}}
    };
    const timer=setTimeout(()=>{cleanup();reject(new Error(`RPC timeout: ${method}`));},15000);
    control.on('data',onData);control.write(JSON.stringify({id,method,params,token})+'\n');
  });
}
function killGroup(child,signal){if(child?.pid)try{process.kill(-child.pid,signal);}catch{}}
async function stop(child,closed){if(!child)return;killGroup(child,'SIGTERM');const timer=setTimeout(()=>killGroup(child,'SIGKILL'),5000);await closed;clearTimeout(timer);killGroup(child,'SIGKILL');}
// Reassigns `codex`/`codexClosed` so the outer `finally` always reaps whichever
// account server is current, including the one restarted after its own death.
async function startAccountServer(){
  await rm(serverSocket,{force:true});
  codex=spawn('codex',['app-server','--listen',`unix://${serverSocket}`],{cwd:directory,env:environment,stdio:['ignore','ignore','pipe'],detached:true});
  codexClosed=new Promise(resolve=>codex.once('close',resolve));codex.stderr.on('data',bytes=>{codexLog=(codexLog+bytes).slice(-4000);});
  await until(async()=>{try{await access(serverSocket);return true;}catch{return false;}},'account server');
}
async function startDaemon(){
  daemonLog='';daemon=spawn(process.execPath,[path.join(directory,'daemon.cjs')],{cwd:process.cwd(),env:environment,stdio:['ignore','pipe','pipe'],detached:true});
  daemonClosed=new Promise(resolve=>daemon.once('close',resolve));
  for(const stream of [daemon.stdout,daemon.stderr])stream.on('data',bytes=>{daemonLog=(daemonLog+bytes).slice(-24000);});
  await until(()=>{if(daemon.exitCode!==null || daemon.signalCode!==null)throw new Error('Daemon exited before readiness');return daemonLog.includes('Daemon ready');},'daemon readiness',30000);
  control=await connect(pipePath);
}
// `keep` holds earlier terminals open: the kill path must drive both panes after
// every state-saving RPC has already happened.
async function attach(id,keep=false){
  if(!keep){terminal?.destroy();terminals.delete(terminal);terminal=undefined;}
  screen='';await rpc('daemon.attachSession',{id});await rpc('daemon.resizeSession',{id,cols:120,rows:40});
  const socket=await connect(path.join(dataDir,`session-${id}.sock`));
  socket.on('error',()=>{});
  socket.on('data',bytes=>{
    const text=bytes.toString();screen=(screen+text).slice(-24000);
    const visible=screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\s/g,'');
    if(!trusted && visible.includes('Doyoutrustthecontentsofthisdirectory?') && visible.includes('Yes,continue')){trusted=true;setTimeout(()=>socket.write('\r'),300);}
    if(text.includes('\x1b[6n'))socket.write('\x1b[1;1R');
  });
  socket.write(token+'\n');
  terminal=socket;terminals.add(socket);
  return socket;
}
async function turn(socket,prompt){await delay(500);socket.write(prompt);await delay(300);socket.write('\r');}
function hint(state,id){return state.sessions.find(row=>row.id===id)?.codexRelayResume?.threadId;}
/** Ground truth from the account's own rollout files, independent of daemon state. */
async function rolloutThread(text) {
  const found=[];
  const walk=async dir=>{
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const full=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(full);
      else if(entry.name.endsWith('.jsonl') && (await readFile(full,'utf8')).includes(text))found.push(full);
    }
  };
  await walk(path.join(directory,'sessions'));
  assert.equal(found.length,1,`rollouts containing ${JSON.stringify(text)}: ${found.length}`);
  return /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path.basename(found[0]))?.[1];
}
try {
  await mkdir(dataDir,{mode:0o700});ownsDataDir=true;
  await mkdir(path.dirname(serverSocket),{mode:0o700});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const providerURL=`http://127.0.0.1:${provider.address().port}/v1`;
  await writeFile(path.join(directory,'config.toml'),`model_provider = "wmux_fixture"\nmodel = "fixture-a"\n[model_providers.wmux_fixture]\nname = "wmux fixture"\nbase_url = "${providerURL}"\nwire_api = "responses"\nrequires_openai_auth = false\n`,{mode:0o600});
  await writeFile(path.join(dataDir,'config.json'),JSON.stringify({version:1,daemon:{pipeName:pipePath,logLevel:'info',autoStart:false},session:{defaultShell:'/bin/zsh',defaultCols:120,defaultRows:40,bufferSizeMb:1,bufferMaxMb:16,deadSessionTtlHours:24,deadSessionDumpBuffer:true}}),{mode:0o600});
  await writeFile(path.join(dataDir,'daemon-auth-token'),token,{mode:0o600});
  await build({entryPoints:['src/daemon/index.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(directory,'daemon.cjs'),logLevel:'silent',plugins:[{name:'native-dependencies',setup(builder){builder.onResolve({filter:/^(node-pty|koffi)$/},args=>({path:require.resolve(args.path),external:true}));}}]});
  await startAccountServer();
  await startDaemon();
  const portProbe=net.createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
  const web=await rpc('daemon.web.start',{port,host:'127.0.0.1',allowInput:true,allowTranscript:true});
  const base=`http://127.0.0.1:${web.port}`;
  const headers={Authorization:`Bearer ${web.token}`,'Content-Type':'application/json'};
  const created=await fetch(`${base}/api/sessions`,{method:'POST',headers,body:JSON.stringify({cwd:directory,agentLaunch:{agent:'codex'}})});
  assert.equal(created.status,201,`Session creation: ${created.status} ${await created.clone().text()}`);
  const pane=await created.json();assert(pane.id);
  await attach(pane.id);
  let settings;
  await until(async()=>{const r=await fetch(`${base}/api/sessions/${pane.id}/agent-settings`,{headers});if(r.status!==200)return false;settings=await r.json();return true;},'phone-created Codex settings');
  assert.equal(settings.model,'fixture-a');
  const first=terminal;
  if(deathMode) {
    const secondCreated=await fetch(`${base}/api/sessions`,{method:'POST',headers,body:JSON.stringify({cwd:directory,agentLaunch:{agent:'codex'}})});
    assert.equal(secondCreated.status,201);const secondPane=await secondCreated.json();
    const second=await attach(secondPane.id,true);
    await until(async()=> (await fetch(`${base}/api/sessions/${secondPane.id}/agent-settings`,{headers})).status===200,'second pane settings');
    await turn(first,'Alpha account death fixture');
    await until(()=>providerRequests>0,'first account-death fixture turn');
    const requestsBeforeSecond=providerRequests;
    await turn(second,'Bravo account death fixture');
    await until(()=>providerRequests>requestsBeforeSecond,'second account-death fixture turn');
    await delay(2000);
    const expectedFirst=await rolloutThread('Alpha account death fixture');
    const expectedSecond=await rolloutThread('Bravo account death fixture');
    assert(expectedFirst && expectedSecond);assert.notEqual(expectedFirst,expectedSecond);
    const live=JSON.parse(await readFile(statePath,'utf8'));
    assert.equal(hint(live,pane.id),expectedFirst,`first hint while relays live: ${hint(live,pane.id)}`);
    assert.equal(hint(live,secondPane.id),expectedSecond,`second hint while relays live: ${hint(live,secondPane.id)}`);
    // Kill ONLY the account server. Every relay loses its upstream and retires;
    // no foreground thread change was ever requested.
    killGroup(codex,'SIGKILL');await codexClosed;
    await until(async()=>{
      const states=await Promise.all([pane.id,secondPane.id].map(async id=>
        (await fetch(`${base}/api/sessions/${id}/agent-settings`,{headers})).status));
      return states.every(status=>status!==200);
    },'daemon observing the lost relays');
    await delay(1000);
    const afterDeath=JSON.parse(await readFile(statePath,'utf8'));
    const paneStates=Object.fromEntries(afterDeath.sessions.filter(row=>[pane.id,secondPane.id].includes(row.id)).map(row=>[row.id,row.state]));
    assert.equal(hint(afterDeath,pane.id),expectedFirst,`first hint erased by transport loss: ${hint(afterDeath,pane.id)} (states ${JSON.stringify(paneStates)})`);
    assert.equal(hint(afterDeath,secondPane.id),expectedSecond,`second hint erased by transport loss: ${hint(afterDeath,secondPane.id)} (states ${JSON.stringify(paneStates)})`);
    for(const socket of terminals)socket.destroy();
    terminals.clear();terminal=undefined;control.destroy();control=undefined;
    process.kill(daemon.pid,'SIGKILL');
    await until(()=>daemon.exitCode!==null || daemon.signalCode!==null,'daemon SIGKILL');await daemonClosed;
    killGroup(daemon,'SIGKILL');
    const killed=JSON.parse(await readFile(statePath,'utf8'));
    assert.equal(hint(killed,pane.id),expectedFirst,`first hint after daemon kill: ${hint(killed,pane.id)}`);
    assert.equal(hint(killed,secondPane.id),expectedSecond,`second hint after daemon kill: ${hint(killed,secondPane.id)}`);
    // Recover ONCE with no account socket at all. Relay preparation falls back
    // to an ordinary spawn, so nothing live rewrites the hint — and the hint was
    // only ever read to build the resume command, never copied into the
    // recovered pane's meta, so this recovery's own state save erased it.
    await startDaemon();
    await until(async()=>{
      const recovered=JSON.parse(await readFile(statePath,'utf8'));
      return hint(recovered,pane.id)!==undefined && hint(recovered,secondPane.id)!==undefined;
    },'recovery without a relay preserving both hints',40000);
    const relayless=JSON.parse(await readFile(statePath,'utf8'));
    assert.equal(hint(relayless,pane.id),expectedFirst,`first hint erased by relayless recovery: ${hint(relayless,pane.id)}`);
    assert.equal(hint(relayless,secondPane.id),expectedSecond,`second hint erased by relayless recovery: ${hint(relayless,secondPane.id)}`);
    control.destroy();control=undefined;
    await stop(daemon,daemonClosed);
    // The account server must be back before the LIVE recovery: relay preparation probes it.
    await startAccountServer();
    await startDaemon();
    await attach(pane.id);await attach(secondPane.id,true);
    for(const id of [pane.id,secondPane.id])
      await until(async()=>{try{return (await fetch(`${base}/api/sessions/${id}/agent-settings`,{headers})).status===200;}catch{return false;}},`restored settings ${id}`,40000);
    await rpc('daemon.attachSession',{id:secondPane.id});
    const afterRestart=JSON.parse(await readFile(statePath,'utf8'));
    assert.equal(hint(afterRestart,pane.id),expectedFirst,'first pane did not resume its own thread after account-server death');
    assert.equal(hint(afterRestart,secondPane.id),expectedSecond,'second pane did not resume its own thread after account-server death');
    assert.equal((await fetch(`${base}/api/sessions/${pane.id}`,{method:'DELETE',headers})).status,204);
    assert.equal((await fetch(`${base}/api/sessions/${secondPane.id}`,{method:'DELETE',headers})).status,204);
    console.log(JSON.stringify({ok:true,mode:'account-server-death',hintSurvivedTransportLoss:true,
      hintSurvivedRelaylessRecovery:true,
      twoPaneExactRecovery:true,fullDaemonProcess:true,paneStatesAfterDeath:paneStates,
      providerNetwork:'owned-loopback-fixture',providerRequests}));
  } else if(killMode) {
    // Second pane and every attach/resize RPC happen BEFORE any fixture turn, so
    // no RPC forces a state save once a durable rollout exists.
    const secondCreated=await fetch(`${base}/api/sessions`,{method:'POST',headers,body:JSON.stringify({cwd:directory,agentLaunch:{agent:'codex'}})});
    assert.equal(secondCreated.status,201);const secondPane=await secondCreated.json();
    const second=await attach(secondPane.id,true);
    await until(async()=> (await fetch(`${base}/api/sessions/${secondPane.id}/agent-settings`,{headers})).status===200,'second pane settings');
    const beforeTurns=JSON.parse(await readFile(statePath,'utf8'));
    const hintsBeforeTurns={first:hint(beforeTurns,pane.id) ?? null,second:hint(beforeTurns,secondPane.id) ?? null};
    const savedBeforeTurns=(await stat(statePath)).mtimeMs;
    const turnsStartedAt=Date.now();
    await turn(first,'Alpha kill recovery fixture');
    await until(()=>providerRequests>0,'first kill fixture turn');
    const requestsBeforeSecond=providerRequests;
    await turn(second,'Bravo kill recovery fixture');
    await until(()=>providerRequests>requestsBeforeSecond,'second kill fixture turn');
    await delay(2000);
    const expectedFirst=await rolloutThread('Alpha kill recovery fixture');
    const expectedSecond=await rolloutThread('Bravo kill recovery fixture');
    assert(expectedFirst && expectedSecond);assert.notEqual(expectedFirst,expectedSecond);
    const killWindowMs=Date.now()-turnsStartedAt;
    for(const socket of terminals)socket.destroy();
    terminals.clear();terminal=undefined;control.destroy();control=undefined;
    process.kill(daemon.pid,'SIGKILL');
    await until(()=>daemon.exitCode!==null || daemon.signalCode!==null,'daemon SIGKILL');await daemonClosed;
    assert.equal(daemon.signalCode,'SIGKILL');
    killGroup(daemon,'SIGKILL');
    const killed=JSON.parse(await readFile(statePath,'utf8'));
    const savedAfterKill=(await stat(statePath)).mtimeMs;
    assert.equal(hint(killed,pane.id),expectedFirst,`first pane hint after SIGKILL: ${hint(killed,pane.id)} != ${expectedFirst}`);
    assert.equal(hint(killed,secondPane.id),expectedSecond,`second pane hint after SIGKILL: ${hint(killed,secondPane.id)} != ${expectedSecond}`);
    await startDaemon();
    await attach(pane.id);await attach(secondPane.id,true);
    for(const id of [pane.id,secondPane.id])
      await until(async()=>{try{return (await fetch(`${base}/api/sessions/${id}/agent-settings`,{headers})).status===200;}catch{return false;}},`restored settings ${id}`,40000);
    await rpc('daemon.attachSession',{id:secondPane.id});
    const afterRestart=JSON.parse(await readFile(statePath,'utf8'));
    assert.equal(hint(afterRestart,pane.id),expectedFirst,'first pane did not resume its own thread after SIGKILL');
    assert.equal(hint(afterRestart,secondPane.id),expectedSecond,'second pane did not resume its own thread after SIGKILL');
    assert.equal(afterRestart.sessions.filter(row=>[pane.id,secondPane.id].includes(row.id)).length,2);
    assert.equal((await fetch(`${base}/api/sessions/${pane.id}`,{method:'DELETE',headers})).status,204);
    assert.equal((await fetch(`${base}/api/sessions/${secondPane.id}`,{method:'DELETE',headers})).status,204);
    console.log(JSON.stringify({ok:true,mode:'sigkill',twoPaneExactRecovery:true,fullDaemonProcess:true,
      killedWithoutShutdownRpc:true,hintsBeforeTurns,stateSavedDuringTurnWindow:savedAfterKill!==savedBeforeTurns,
      killWindowMs,providerNetwork:'owned-loopback-fixture',providerRequests}));
  } else {
    await delay(500);terminal.write('Local daemon recovery fixture');await delay(300);terminal.write('\r');
    await until(()=>providerRequests>0,'local fixture turn');
    await delay(1500);
    const before=await fetch(`${base}/api/sessions/${pane.id}/agent-settings`,{headers});assert.equal(before.status,200);settings=await before.json();
    // A second durable conversation in the SAME cwd must not redirect pane A.
    const secondCreated=await fetch(`${base}/api/sessions`,{method:'POST',headers,body:JSON.stringify({cwd:directory,agentLaunch:{agent:'codex'}})});
    assert.equal(secondCreated.status,201);const secondPane=await secondCreated.json();
    await attach(secondPane.id);
    await until(async()=> (await fetch(`${base}/api/sessions/${secondPane.id}/agent-settings`,{headers})).status===200,'second pane settings');
    const requestsBeforeSecond=providerRequests;
    await delay(500);terminal.write('Second local daemon recovery fixture');await delay(300);terminal.write('\r');
    await until(()=>providerRequests>requestsBeforeSecond,'second local fixture turn');await delay(1500);
    // attachSession saves a production state snapshot after both selections exist.
    await rpc('daemon.attachSession',{id:secondPane.id});
    const beforeRestart=JSON.parse(await readFile(path.join(dataDir,'sessions.json'),'utf8'));
    const firstThread=beforeRestart.sessions.find(row=>row.id===pane.id)?.codexRelayResume?.threadId;
    const secondThread=beforeRestart.sessions.find(row=>row.id===secondPane.id)?.codexRelayResume?.threadId;
    assert(firstThread && secondThread);assert.notEqual(firstThread,secondThread);
    terminal.destroy();terminal=undefined;
    await rpc('daemon.shutdown');
    await until(()=>daemon.exitCode!==null || daemon.signalCode!==null,'daemon shutdown');await daemonClosed;
    control.destroy();control=undefined;
    const saved=JSON.parse(await readFile(path.join(dataDir,'sessions.json'),'utf8'));
    const savedPane=saved.sessions.find(row=>row.id===pane.id);assert(savedPane);assert.equal(savedPane.exec.command,'codex');assert(!JSON.stringify(savedPane).includes('--remote'));
    // Shutdown suspends both panes and keeps the hints captured while the relays
    // were still live; retiring the relays must not erase the suspended binding.
    assert.equal(savedPane.state,'suspended');
    assert.equal(saved.sessions.find(row=>row.id===secondPane.id)?.state,'suspended');
    assert.equal(hint(saved,pane.id),firstThread,`suspended first hint: ${hint(saved,pane.id)}`);
    assert.equal(hint(saved,secondPane.id),secondThread,`suspended second hint: ${hint(saved,secondPane.id)}`);
    await startDaemon();await attach(pane.id);
    let restored;
    await until(async()=>{try{const r=await fetch(`${base}/api/sessions/${pane.id}/agent-settings`,{headers});if(r.status!==200)return false;restored=await r.json();return true;}catch{return false;}},'restored settings');
    assert.notEqual(restored.revision,settings.revision);
    await attach(secondPane.id);
    await until(async()=> (await fetch(`${base}/api/sessions/${secondPane.id}/agent-settings`,{headers})).status===200,'second pane restored settings');
    await rpc('daemon.attachSession',{id:secondPane.id});
    const afterRestart=JSON.parse(await readFile(path.join(dataDir,'sessions.json'),'utf8'));
    assert.equal(afterRestart.sessions.find(row=>row.id===pane.id)?.codexRelayResume?.threadId,firstThread);
    assert.equal(afterRestart.sessions.find(row=>row.id===secondPane.id)?.codexRelayResume?.threadId,secondThread);

    const choice=restored.models[0];assert(choice);
    const stale=await fetch(`${base}/api/sessions/${pane.id}/agent-settings`,{method:'POST',headers,body:JSON.stringify({model:choice.model,effort:choice.defaultEffort,expectedRevision:settings.revision})});assert.equal(stale.status,409);
    const changed=await fetch(`${base}/api/sessions/${pane.id}/agent-settings`,{method:'POST',headers,body:JSON.stringify({model:choice.model,effort:choice.defaultEffort,expectedRevision:restored.revision})});assert.equal(changed.status,200);
    assert.equal((await changed.json()).model,choice.model);
    const removed=await fetch(`${base}/api/sessions/${pane.id}`,{method:'DELETE',headers});assert.equal(removed.status,204);
    assert.equal((await fetch(`${base}/api/sessions/${pane.id}/agent-settings`,{headers})).status,404);
    assert.equal((await fetch(`${base}/api/sessions/${secondPane.id}`,{method:'DELETE',headers})).status,204);
    console.log(JSON.stringify({ok:true,twoPaneExactRecovery:true,fullDaemonProcess:true,httpCreatedPane:true,durableRecovery:true,restoredWebCredentials:true,staleRevisionRejected:true,settingsChanged:true,providerNetwork:'owned-loopback-fixture',providerRequests}));
  }
} catch(error){console.error(String(error));console.error(`Fixture screen (trusted=${trusted}): ${screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-6000)}`);console.error(daemonLog);if(codexLog)console.error(codexLog);process.exitCode=1;}
finally {
  for(const socket of terminals)socket.destroy();
  terminal?.destroy();control?.destroy();
  await stop(daemon,daemonClosed);await stop(codex,codexClosed);
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  if(ownsDataDir)await rm(dataDir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
