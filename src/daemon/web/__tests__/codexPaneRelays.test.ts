import {describe,it,expect,vi} from 'vitest';
import type {ManagedSession} from '../../DaemonSessionManager';
import {CodexPaneRelays} from '../codexPaneRelays';
const owner=(id='pane')=>({meta:{id,state:'attached'}} as ManagedSession);
function relay() {
  const state = {retired:false,selected:true};
  return {url:'unix:///private/socket',state,
    current:()=>state.selected ? {threadId:'thread',cwd:'/repo',generation:1} : undefined,
    retired:()=>state.retired,close:vi.fn(async()=> { /* noop */ })};
}
describe('Codex pane relay lifetime',()=>{
  it('publishes selection only for its committed managed instance',async()=>{
    const connection=relay();const registry=new CodexPaneRelays(async()=>connection);
    const lease=await registry.prepare('pane');const pane=owner();
    expect(registry.selection('pane',pane)).toBeUndefined();
    expect(lease.commit(owner('wrong'))).toBe(false);
    expect(lease.commit(pane)).toBe(true);
    expect(lease.commit(pane)).toBe(false);
    expect(registry.selection('pane',pane)).toMatchObject({threadId:'thread',generation:1});
    expect(registry.selection('pane',owner())).toBeUndefined();
    await registry.shutdown();expect(connection.close).toHaveBeenCalledOnce();
  });
  it('separates a live relay with no selection from a relay that is gone',async()=>{
    const connection=relay();const registry=new CodexPaneRelays(async()=>connection);
    const lease=await registry.prepare('pane');const pane=owner();
    // No committed owner yet, and an id nobody reserved: neither is a live answer.
    expect(registry.liveSelection('pane',pane)).toEqual({live:false});
    expect(registry.liveSelection('other',pane)).toEqual({live:false});
    lease.commit(pane);
    expect(registry.liveSelection('pane',pane)).toEqual({live:true,selection:{threadId:'thread',cwd:'/repo',generation:1}});
    // Live relay, nothing in the foreground — the only observation that may
    // erase a durable hint.
    connection.state.selected=false;
    expect(registry.liveSelection('pane',pane)).toEqual({live:true});
    expect(registry.selection('pane',pane)).toBeUndefined();
    // Transport lost while the entry is still installed: the hint must survive.
    connection.state.selected=true;connection.state.retired=true;
    expect(registry.liveSelection('pane',pane)).toEqual({live:false});
    expect(registry.selection('pane',pane)).toBeUndefined();
    connection.state.retired=false;
    // A foreign owner retires the entry, and a retired entry stays non-live.
    expect(registry.liveSelection('pane',owner())).toEqual({live:false});
    expect(registry.liveSelection('pane',pane)).toEqual({live:false});
    await registry.shutdown();
  });
  it('closes a relay that finishes preparing after pane retirement',async()=>{
    let release!:(value:ReturnType<typeof relay>)=>void;
    const registry=new CodexPaneRelays(()=>new Promise(resolve=>{release=resolve;}));
    const pending=registry.prepare('pane');
    await registry.retire('pane');
    const connection=relay();release(connection);
    await expect(pending).rejects.toThrow('retired');
    expect(connection.close).toHaveBeenCalledOnce();
  });
  it('shutdown waits for pending creation and its cleanup',async()=>{
    let release!:(value:ReturnType<typeof relay>)=>void;
    const registry=new CodexPaneRelays(()=>new Promise(resolve=>{release=resolve;}));
    const pending=registry.prepare('pane');
    const rejected=expect(pending).rejects.toThrow('retired');
    let stopped=false;
    const shutdown=registry.shutdown().then(()=>{stopped=true;});
    await Promise.resolve();expect(stopped).toBe(false);
    const connection=relay();release(connection);
    await rejected;await shutdown;
    expect(connection.close).toHaveBeenCalledOnce();
  });
  it('old leases cannot close replacement panes with the same ID',async()=>{
    const first=relay();const second=relay();let count=0;
    const registry=new CodexPaneRelays(async()=>count++ ? second : first);
    const old=await registry.prepare('pane');old.commit(owner());
    await registry.retire('pane');
    const next=await registry.prepare('pane');const current=owner();next.commit(current);
    await old.close();expect(registry.selection('pane',current)).toBeDefined();
    expect(second.close).not.toHaveBeenCalled();await registry.shutdown();
  });
  it('rejects duplicate reservations and all reservations after shutdown',async()=>{
    const registry=new CodexPaneRelays(async()=>relay());
    await registry.prepare('pane');
    await expect(registry.prepare('pane')).rejects.toThrow('unavailable');
    await registry.shutdown();await expect(registry.prepare('other')).rejects.toThrow('unavailable');
  });
  it('announces state only for the exact committed owner of the current reservation',async()=>{
    const changed=vi.fn();const announcers:(()=>void)[]=[];
    const registry=new CodexPaneRelays(async options=>{announcers.push(options.onStateChange!);return relay();},undefined,changed);
    const lease=await registry.prepare('pane');const pane=owner();
    // A reservation that has not committed a PTY owner yet has nobody to persist for.
    announcers[0]();expect(changed).not.toHaveBeenCalled();
    expect(lease.commit(pane)).toBe(true);
    expect(changed).toHaveBeenCalledExactlyOnceWith('pane',pane);
    changed.mockClear();announcers[0]();
    expect(changed).toHaveBeenCalledExactlyOnceWith('pane',pane);
    changed.mockClear();
    await registry.retire('pane');
    announcers[0]();expect(changed).not.toHaveBeenCalled();
    // A recycled pane ID must not be written through the retired reservation.
    const next=await registry.prepare('pane');const replacement=owner();
    expect(next.commit(replacement)).toBe(true);changed.mockClear();
    announcers[0]();expect(changed).not.toHaveBeenCalled();
    announcers[1]();expect(changed).toHaveBeenCalledExactlyOnceWith('pane',replacement);
    await registry.shutdown();
  });
  it('refuses a commit whose state announcement fails and retires the reservation',async()=>{
    const connection=relay();
    const registry=new CodexPaneRelays(async()=>connection,undefined,()=>{throw new Error('state refused');});
    const lease=await registry.prepare('pane');const pane=owner();
    expect(lease.commit(pane)).toBe(false);
    expect(registry.selection('pane',pane)).toBeUndefined();
    await registry.shutdown();expect(connection.close).toHaveBeenCalledOnce();
  });
  it('retires dead owners and reports cleanup failure without restoring authority',async()=>{
    const connection=relay();connection.close.mockRejectedValue(new Error('fixture cleanup'));
    const cleanup=vi.fn();const registry=new CodexPaneRelays(async()=>connection,cleanup);
    const lease=await registry.prepare('pane');const pane=owner();lease.commit(pane);pane.meta.state='dead';
    expect(registry.selection('pane',pane)).toBeUndefined();await registry.shutdown();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
