import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureCodexRelayResume,codexRelayResumeCommand} from '../codexRelayResume';
type Pane=Parameters<typeof captureCodexRelayResume>[0];
const a='01234567-89ab-4cde-8123-456789abcdef';
const b='11234567-89ab-4cde-8123-456789abcdef';
function fixture(run:(f:{pane:Pane;root:string;selection:{threadId:string;cwd:string;generation:number;transcriptPath:string}})=>void) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wmux-resume-'));
  try {
    fs.mkdirSync(path.join(root,'sessions'));
    const transcriptPath=path.join(root,'sessions',`rollout-fixture-${a}.jsonl`);fs.writeFileSync(transcriptPath,'fixture');
    const pane:Pane={id:`web-${a}`,exec:{command:'codex --model model-a -c model_reasoning_effort=low'},env:{CODEX_HOME:root},cwd:root};
    run({pane,root,selection:{threadId:a,cwd:root,generation:1,transcriptPath}});
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}
describe('owned Codex relay recovery identity',()=>{
  it('resumes the exact pane thread even when a newer conversation exists in the same cwd',()=>fixture(({pane,root,selection})=>{
    captureCodexRelayResume(pane,{live:true,selection});
    fs.writeFileSync(path.join(root,'sessions',`rollout-newer-${b}.jsonl`),'another conversation');
    const persisted=JSON.parse(JSON.stringify(pane));
    expect(codexRelayResumeCommand(persisted)).toBe(`codex resume ${a} --model model-a -c model_reasoning_effort=low`);
  }));
  it.each(['missing','switched-empty','pending','deleted','different-account','different-cwd'])('never chooses the latest conversation after %s',condition=>fixture(({pane,root,selection})=>{
    captureCodexRelayResume(pane,{live:true,selection});
    if(condition==='missing')delete pane.codexRelayResume;
    if(condition==='switched-empty')captureCodexRelayResume(pane,{live:true,selection:{...selection,threadId:b,transcriptPath:path.join(root,'sessions',`missing-${b}.jsonl`)}});
    // A LIVE relay reporting no selection is the erase signal, and stays one.
    if(condition==='pending')captureCodexRelayResume(pane,{live:true});
    if(condition==='deleted')fs.unlinkSync(selection.transcriptPath);
    if(condition==='different-account'){const other=path.join(root,'other');fs.mkdirSync(other);pane.env.CODEX_HOME=other;}
    if(condition==='different-cwd'){const other=path.join(root,'cwd');fs.mkdirSync(other);pane.cwd=other;}
    expect(codexRelayResumeCommand(pane)).toBe(pane.exec!.command);
  }));
  // Previously this pinned the opposite: any absent selection — including one
  // caused by the relay closing — erased the hint, so an account-server death
  // cost the pane its conversation on the next recovery.
  it('keeps the last confirmed hint when the relay itself is gone',()=>fixture(({pane,selection})=>{
    captureCodexRelayResume(pane,{live:true,selection});
    captureCodexRelayResume(pane,{live:false});
    expect(pane.codexRelayResume?.threadId).toBe(a);
    expect(codexRelayResumeCommand(pane)).toContain(`resume ${a}`);
  }));
  it('rejects a rollout symlink escaping the account session directory',()=>fixture(({pane,root,selection})=>{
    const outside=path.join(root,`outside-${a}.jsonl`);fs.writeFileSync(outside,'private');
    fs.unlinkSync(selection.transcriptPath);fs.symlinkSync(outside,selection.transcriptPath);
    captureCodexRelayResume(pane,{live:true,selection});
    expect(pane.codexRelayResume).toBeUndefined();
  }));
  it('accepts canonical cwd aliases without switching account or thread',()=>fixture(({pane,root,selection})=>{
    const alias=path.join(root,'alias');fs.symlinkSync(root,alias);pane.cwd=alias;
    captureCodexRelayResume(pane,{live:true,selection});
    expect(codexRelayResumeCommand(pane)).toContain(`resume ${a}`);
  }));
  // The caller's cwd guard sits BEHIND this function's early return, so the
  // rule has to hold here. It did, but only because the revalidation below
  // dereferences the cwd and throws; this pins it as the function's own
  // contract rather than a side effect of how the binding happens to be
  // checked. (`undefined` and the bare command spawn alike today — the manager
  // defaults execLaunchCommand to exec.command.)
  it('returns no launch command when the pane cwd is gone',()=>fixture(({pane,selection})=>{
    captureCodexRelayResume(pane,{live:true,selection});
    pane.cwd=path.join(pane.cwd,'deleted-directory');
    expect(codexRelayResumeCommand(pane)).toBeUndefined();
  }));
  it('does not rewrite arbitrary desktop commands',()=>fixture(({pane,selection})=>{
    pane.id='desktop-pane';captureCodexRelayResume(pane,{live:true,selection});
    expect(codexRelayResumeCommand(pane)).toBeUndefined();
  }));
});
