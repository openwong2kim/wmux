// Live smoke for the phone plan-dialog answer (decision-v2 `plan` form) against
// a REAL, logged-in Claude Code in an isolated daemon (its own data dir,
// pipe and token; the agent's environment is an allowlist, so no CLAUDE*,
// ANTHROPIC*, AI_AGENT or WMUX_* variable of the caller leaks into it).
//
// It drives ExitPlanMode three times through the phone routes:
//   0. refusals that must type nothing: a text carrying the bracketed-paste
//      terminator, and (on a 60x30 pane) a text wider than the field can show.
//   1. `feedback` with a long text — the stepwise driver (feedback row, one
//      bracketed paste, echo check, Enter). Claude must re-plan.
//   2. `/decline` (one Esc) — what Esc does on this dialog is recorded.
//   3. `approve-manual` — one key; the record resolves once the dialog closes.
// and checks that the driver's own keys never read as a human's: no
// `prompt-changed`, no supersede and no partial step in the daemon log.
//
// Usage: node scripts/phone-decision-smoke.mjs   (uses the `claude` on PATH;
// makes real model calls; needs a Claude login in the keychain)
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

// Under /tmp like the other phone smokes (a project there skips Claude's
// first-run trust prompt when /tmp is already trusted).
const directory=await mkdtemp('/tmp/wmux-plan-smoke-');
const project=path.join(directory,'proj');
const suffix=`-dfplan-${randomUUID().slice(0,8)}`;
const dataDir=path.join(os.homedir(),`.wmux${suffix}`);
const pipePath=path.join(directory,'control.sock');
const token=randomUUID();
const require=createRequire(import.meta.url);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const COLS=100,ROWS=40;
const CAPS={'X-Wmux-Client-Caps':'terminal-prompt-answer, terminal-prompt-decline, decision-v2'};
// An allowlist, not a scrub list: nothing of the caller's session reaches the daemon or the agent.
const environment={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,USER:process.env.USER,LANG:process.env.LANG ?? 'en_US.UTF-8',SHELL:'/bin/zsh',WMUX_DATA_SUFFIX:suffix};
let daemon,daemonClosed,control,terminal,daemonLog='',ownsDataDir=false,dumpScreen=async()=>'';
const report={};

async function until(check,description,timeout=30000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await check();if(value)return value;await delay(200);}
  throw new Error(`Timed out: ${description}`);
}
function connect(socketPath){return new Promise((resolve,reject)=>{const s=net.createConnection(socketPath);s.once('error',reject);s.once('connect',()=>resolve(s));});}
async function rpc(method,params={}){
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

try{
  await mkdir(project,{recursive:true});
  await mkdir(dataDir,{mode:0o700});ownsDataDir=true;
  await writeFile(path.join(dataDir,'config.json'),JSON.stringify({version:1,daemon:{pipeName:pipePath,logLevel:'info',autoStart:false},session:{defaultShell:'/bin/zsh',defaultCols:COLS,defaultRows:ROWS,bufferSizeMb:1,bufferMaxMb:16,deadSessionTtlHours:24,deadSessionDumpBuffer:true}}),{mode:0o600});
  await writeFile(path.join(dataDir,'daemon-auth-token'),token,{mode:0o600});
  // The worktree's own hook bridge, PermissionRequest included, and nothing
  // from the user's settings (`--setting-sources project`).
  const bridge=path.resolve('integrations/claude/bin/wmux-bridge.mjs');
  const hook=event=>[{matcher:'',hooks:[{type:'command',command:`node "${bridge}" ${event}`}]}];
  const settings={hooks:Object.fromEntries(['SessionStart','UserPromptSubmit','Stop','PermissionRequest','PreToolUse','PostToolUse'].map(e=>[e,hook(e)]))};
  const settingsFile=path.join(directory,'claude-settings.json');
  await writeFile(settingsFile,JSON.stringify(settings));
  await build({entryPoints:['src/daemon/index.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(directory,'daemon.cjs'),logLevel:'silent',plugins:[{name:'native-dependencies',setup(builder){builder.onResolve({filter:/^(node-pty|koffi)$/},args=>({path:require.resolve(args.path),external:true}));}}]});
  daemon=spawn(process.execPath,[path.join(directory,'daemon.cjs')],{cwd:process.cwd(),env:environment,stdio:['ignore','pipe','pipe'],detached:true});
  daemonClosed=new Promise(resolve=>daemon.once('close',resolve));
  for(const stream of [daemon.stdout,daemon.stderr])stream.on('data',bytes=>{daemonLog+=bytes;});
  await until(()=>{if(daemon.exitCode!==null)throw new Error('daemon exited');return daemonLog.includes('Daemon ready');},'daemon readiness');
  control=await connect(pipePath);
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const web=await rpc('daemon.web.start',{port,host:'127.0.0.1',allowInput:true,allowTranscript:true});
  const base=`http://127.0.0.1:${web.port}`;
  const headers={Authorization:`Bearer ${web.token}`,'Content-Type':'application/json',...CAPS};
  const config=await (await fetch(`${base}/api/config`,{headers})).json();
  assert.deepEqual(config.decisionForms,['plan']);
  const created=await fetch(`${base}/api/sessions`,{method:'POST',headers,body:JSON.stringify({cwd:project})});
  assert.equal(created.status,201,await created.clone().text());
  const pane=(await created.json()).id;
  await rpc('daemon.attachSession',{id:pane});await rpc('daemon.resizeSession',{id:pane,cols:COLS,rows:ROWS});
  terminal=await connect(path.join(dataDir,`session-${pane}.sock`));
  terminal.on('error',()=>{});
  terminal.on('data',bytes=>{if(bytes.toString().includes('\x1b[6n'))terminal.write('\x1b[1;1R');});
  terminal.write(token+'\n');
  const rows=async()=>{const r=await rpc('daemon.readSessionText',{id:pane,scrollback:0});return r.mode==='rows'?r.rows.map(x=>typeof x==='string'?x:x.text):[];};
  const screenText=async()=>(await rows()).join('\n');
  dumpScreen=screenText;
  const type=async text=>{terminal.write(text);await delay(300);terminal.write('\r');};

  await delay(1500);
  await type(`claude --setting-sources project --settings '${settingsFile}' --strict-mcp-config --permission-mode plan`);
  // First launch in a fresh directory: the trust prompt.
  await until(async()=>{const s=await screenText();if(/Yes, I trust this folder/i.test(s))throw new Error('Claude asks to trust the project directory: trust /tmp once, then rerun');return /plan mode on/i.test(s);},'claude ready in plan mode',60000);
  await type('Plan a change: create hello.txt in the current directory containing the single word hi. Keep the plan to 3 short lines, then call ExitPlanMode. Do not ask questions.');

  const listPending=async()=>(await (await fetch(`${base}/api/approvals`,{headers})).json()).pending;
  const planRecord=async(seen)=>until(async()=>(await listPending()).find(r=>r.kind==='terminal_prompt'&&!seen.has(r.id)&&r.form?.kind==='plan'),'a plan record',180000);
  const seen=new Set();
  const answer=async(record,body)=>{
    const res=await fetch(`${base}/api/approvals/${record.id}/answer`,{method:'POST',headers,body:JSON.stringify({formFingerprint:record.formFingerprint,clientAnswerId:randomUUID(),...body})});
    return {status:res.status,body:await res.json()};
  };

  // 1. Feedback, long text.
  const first=await planRecord(seen);seen.add(first.id);
  report.form=first.form;report.hasDetail=first.hasDetail===true;
  const detail=await (await fetch(`${base}/api/approvals/${first.id}/detail`,{headers})).json();
  report.detailBytes=detail.commandBytes;
  await delay(1600);
  // 0. Refused before any key.
  const terminator=await answer(first,{action:'feedback',text:'x\x1b[201~1\r'});
  report.terminator=terminator;
  assert.equal(terminator.status,400);assert.equal(terminator.body.error,'invalid-text');
  await rpc('daemon.resizeSession',{id:pane,cols:60,rows:30});
  await delay(2000);
  const tooWide=await answer(first,{action:'feedback',text:'word '.repeat(180).trim()});
  report.tooWide=tooWide;
  assert.equal(tooWide.status,400,JSON.stringify(tooWide.body));assert.equal(tooWide.body.error,'invalid-text');
  await rpc('daemon.resizeSession',{id:pane,cols:COLS,rows:ROWS});
  await delay(2000);
  assert(/Tell Claude what to change/.test(await screenText()),'the feedback field was typed into');
  assert(!daemonLog.includes('step=1/'),'a refused answer typed a key');
  const feedback='Please name the file greeting.txt instead of hello.txt, and put the word hello in it rather than hi. '.repeat(3).trim();
  const fb=await answer(first,{action:'feedback',text:feedback});
  report.feedback={status:fb.status,body:fb.body,textChars:feedback.length};
  assert.equal(fb.status,200,JSON.stringify(fb.body));
  assert.equal(fb.body.state,'resolved');

  // 2. Esc through /decline on the re-planned dialog.
  const second=await planRecord(seen);seen.add(second.id);
  report.replanned=true;
  report.secondSummary=second.summary;
  await delay(1600);
  const declined=await fetch(`${base}/api/approvals/${second.id}/decline`,{method:'POST',headers,body:JSON.stringify({promptFingerprint:second.promptFingerprint})});
  report.decline={status:declined.status,body:await declined.json()};
  await delay(4000);
  report.afterEsc=(await rows()).filter(r=>r.trim()).slice(-14);
  const afterEsc=await until(async()=>{
    const list=await (await fetch(`${base}/api/approvals`,{headers})).json();
    return [...list.pending,...list.recentlyResolved].find(r=>r.id===second.id&&r.state!=='pending');
  },'the declined record settles',30000).catch(()=>null);
  report.declineRecordState=afterEsc?.state ?? 'pending';

  // 3. Approve (manual edits) on a fresh plan.
  if(!/plan mode on/i.test(await screenText()))report.escLeftPlanMode=true;
  await type('Plan it again exactly as before and call ExitPlanMode.');
  const third=await planRecord(seen);seen.add(third.id);
  await delay(1600);
  const ok=await answer(third,{action:'approve-manual'});
  report.approve={status:ok.status,body:ok.body};
  assert.equal(ok.status,200,JSON.stringify(ok.body));
  const settled=await until(async()=>{
    const list=await (await fetch(`${base}/api/approvals`,{headers})).json();
    return list.recentlyResolved.find(r=>r.id===third.id);
  },'the approved record resolves',30000);
  report.approveRecordState=settled.state;
  // Claude asks for the Write after approval (manual edits): leave it unanswered.
  await delay(3000);
  report.afterApprove=(await rows()).filter(r=>r.trim()).slice(-8);

  const planLines=daemonLog.split('\n').filter(l=>l.includes('[approvals]'));
  report.approvalLog=planLines.slice(-40);
  const falseHuman=planLines.filter(l=>/plan answer outcome=prompt-changed|partial|superseded/.test(l));
  report.falseHuman=falseHuman;
  assert.equal(falseHuman.length,0,'the driver\'s own keys read as a human\'s');
  console.log(JSON.stringify({ok:true,...report},null,1));
}catch(error){
  console.error(String(error?.stack ?? error));
  console.error(JSON.stringify(report,null,1));
  console.error(await dumpScreen().catch(()=>'(no screen)'));
  console.error(daemonLog.split('\n').filter(l=>/approvals|hooks|error/i.test(l)).slice(-60).join('\n'));
  process.exitCode=1;
}finally{
  terminal?.destroy();control?.destroy();
  if(daemon){killGroup(daemon,'SIGTERM');const t=setTimeout(()=>killGroup(daemon,'SIGKILL'),5000);await daemonClosed;clearTimeout(t);killGroup(daemon,'SIGKILL');}
  if(ownsDataDir)await rm(dataDir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
