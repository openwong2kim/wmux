import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({load:vi.fn(), native:vi.fn(),close:vi.fn()}));
vi.mock('../../../../daemon/transcript/chatSkills',()=>({loadChatSkills:f.load}));
vi.mock('../../../../daemon/web/codexSettingsTransport',()=>({connectCodexSettings:async()=>({rpc:f.native,close:f.close})}));
import { compatibleChatSkills, compatibleCodexSettings } from '../chatSkillCompatibility';
function fixture() {
  const pane={id:'pty',pid:42,incarnationId:'owned',cwd:'/repo',state:'attached',env:{CODEX_HOME:'/account'}};
  const status={available:true,agentAlive:true,agentSessionId:'11111111-1111-4111-8111-111111111111',terminal:{agent:'codex',nativeSessionId:'11111111-1111-4111-8111-111111111111'}};
  const rpc=vi.fn(async(method:string)=>method==='daemon.listSessions'?[pane]:method==='daemon.transcript.status'?status:{agentName:'Codex CLI'});
  return {pane,status,rpc};
}
beforeEach(()=>{vi.clearAllMocks();f.load.mockResolvedValue({state:'ready',skills:[{name:'qa',invocation:'$qa',source:'user',description:''}]});f.native.mockImplementation(async(method:string)=>method==='thread/read'?{thread:{id:'11111111-1111-4111-8111-111111111111',cwd:'/selected',model:'model-a',reasoningEffort:'low',status:{type:'idle'}}}:method==='model/list'?{data:[{model:'model-a',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}],nextCursor:null}:{});});
describe('desktop compatibility without restarting the daemon',()=>{
  it('uses daemon-owned account and selected native thread cwd, returning metadata only',async()=>{
    const {rpc}=fixture();expect((await compatibleChatSkills(rpc,'pty','codex')).state).toBe('ready');
    expect(f.load).toHaveBeenCalledWith('codex','/selected',{CODEX_HOME:'/account'});expect(f.close).toHaveBeenCalled();
  });
  it('discards a catalogue when pane incarnation changes during the read',async()=>{
    const {rpc,pane}=fixture();f.load.mockImplementation(async()=>{pane.incarnationId='replacement';return{state:'ready',skills:[]};});
    expect((await compatibleChatSkills(rpc,'pty','codex')).state).toBe('unavailable');
  });
  it('never reads an account for a mismatched or dead agent',async()=>{
    const {rpc,status}=fixture();status.agentAlive=false;expect((await compatibleChatSkills(rpc,'pty','codex')).state).toBe('unavailable');expect(f.load).not.toHaveBeenCalled();expect(f.native).not.toHaveBeenCalled();
  });
  it('binds model settings revisions to the pane incarnation and account',async()=>{
    const {rpc,pane}=fixture();const settings=await compatibleCodexSettings(rpc,'pty');expect(settings.model).toBe('model-a');
    pane.incarnationId='replacement';await expect(compatibleCodexSettings(rpc,'pty',{model:'model-a',effort:'high',expectedRevision:settings.revision})).rejects.toThrow('stale');
    expect(f.native.mock.calls.some(([method])=>method==='thread/settings/update')).toBe(false);
  });
  it('confirms an explicitly selected model change by reading the same runtime again',async()=>{
    const {rpc}=fixture();const settings=await compatibleCodexSettings(rpc,'pty');
    const previous=f.native.getMockImplementation()!;let changed=false;
    f.native.mockImplementation(async(method,params)=>{if(method==='thread/settings/update'){changed=true;return{};}const result=await previous(method,params);if(changed&&method==='thread/read')result.thread.reasoningEffort='high';return result;});
    expect((await compatibleCodexSettings(rpc,'pty',{model:'model-a',effort:'high',expectedRevision:settings.revision})).effort).toBe('high');
    expect(f.native).toHaveBeenCalledWith('thread/settings/update',expect.objectContaining({threadId:'11111111-1111-4111-8111-111111111111',effort:'high'}));
  });
});
