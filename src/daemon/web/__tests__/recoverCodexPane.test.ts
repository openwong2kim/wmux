import {describe,it,expect,vi} from 'vitest';
import type {DaemonSessionManager,ManagedSession} from '../../DaemonSessionManager';
import {recoverCodexPane} from '../recoverCodexPane';
import {CodexRelayUnavailableError} from '../codexTuiRelay';
const id='web-01234567-89ab-4cde-8123-456789abcdef';
function fixture() {
  const params:Parameters<DaemonSessionManager['createSessionAsync']>[0]={id,cwd:'/repo',env:{CODEX_HOME:'/account'},exec:{command:'codex --model model-a -c model_reasoning_effort=low'},execLaunchCommand:'codex resume --last --model model-a -c model_reasoning_effort=low'};
  const owner={meta:{id,pid:123,incarnationId:'new',state:'attached'}} as ManagedSession;
  const manager={createSessionAsync:vi.fn(async()=>({...owner.meta})),getSession:vi.fn(()=>owner),destroySession:vi.fn()};
  const lease={url:'unix:///tmp/wmux-new/socket',commit:vi.fn(()=>true),close:vi.fn(async()=> { /* noop */ })};
  const relays={prepare:vi.fn(async()=>lease)};
  return {params,owner,manager,lease,relays};
}
describe('phone Codex recovery launch',()=>{
  it('adds a fresh runtime URL while preserving resume flags and persisted metadata',async()=>{
    const f=fixture();
    const result=await recoverCodexPane(f.manager,f.relays,f.params,'darwin');
    expect(f.relays.prepare).toHaveBeenCalledWith(id,'/account');
    expect(f.manager.createSessionAsync).toHaveBeenCalledWith({...f.params,execLaunchCommand:`${f.params.execLaunchCommand} --remote ${f.lease.url}`});
    expect(f.params.exec?.command).not.toContain('--remote');
    expect(f.lease.commit).toHaveBeenCalledWith(f.owner);
    expect(result.pid).toBe(123);
    expect(f.lease.close).not.toHaveBeenCalled();
  });
  it.each(['non-phone','shell-syntax','remote','prompt','wsl','windows'])('leaves unsupported recovery commands unchanged: %s',async kind=>{
    const f=fixture();
    if(kind==='non-phone')f.params.id='desktop-pane';
    if(kind==='shell-syntax')f.params.exec!.command='codex; echo other';
    if(kind==='remote')f.params.execLaunchCommand='codex --remote unix:///other';
    if(kind==='prompt')f.params.execLaunchCommand='codex resume --last hello';
    if(kind==='wsl')f.params.wslTarget={distribution:'Ubuntu',user:'fixture'};
    await recoverCodexPane(f.manager,f.relays,f.params,kind==='windows'?'win32':'darwin');
    expect(f.relays.prepare).not.toHaveBeenCalled();
    expect(f.manager.createSessionAsync).toHaveBeenCalledWith(f.params);
  });
  it.each(['missing','unready'])('retains ordinary recovery when the account server is %s',async kind=>{
    const f=fixture();
    f.relays.prepare.mockRejectedValue(kind==='missing'?Object.assign(new Error('missing'),{code:'ENOENT'}):new CodexRelayUnavailableError());
    await recoverCodexPane(f.manager,f.relays,f.params,'darwin');
    expect(f.manager.createSessionAsync).toHaveBeenCalledWith(f.params);
  });
  it('surfaces reservation errors without spawning a duplicate pane',async()=>{
    const f=fixture();f.relays.prepare.mockRejectedValue(new Error('duplicate'));
    await expect(recoverCodexPane(f.manager,f.relays,f.params,'darwin')).rejects.toThrow('duplicate');
    expect(f.manager.createSessionAsync).not.toHaveBeenCalled();
  });
  it('closes the reservation when PTY creation fails',async()=>{
    const f=fixture();f.manager.createSessionAsync.mockRejectedValue(new Error('spawn'));
    await expect(recoverCodexPane(f.manager,f.relays,f.params,'darwin')).rejects.toThrow('spawn');
    expect(f.lease.close).toHaveBeenCalledOnce();
  });
  it('destroys only the failed new spawn if ownership cannot be committed',async()=>{
    const f=fixture();f.lease.commit.mockReturnValue(false);
    await expect(recoverCodexPane(f.manager,f.relays,f.params,'darwin')).rejects.toThrow('closed');
    expect(f.manager.destroySession).toHaveBeenCalledWith(id);
    expect(f.lease.close).toHaveBeenCalledOnce();
  });
  it('does not commit or destroy a replacement with the same pane ID',async()=>{
    const f=fixture();f.manager.getSession.mockReturnValue({meta:{...f.owner.meta,pid:456}} as ManagedSession);
    await expect(recoverCodexPane(f.manager,f.relays,f.params,'darwin')).rejects.toThrow('closed');
    expect(f.manager.destroySession).not.toHaveBeenCalled();
    expect(f.lease.commit).not.toHaveBeenCalled();
    expect(f.lease.close).toHaveBeenCalledOnce();
  });
});
