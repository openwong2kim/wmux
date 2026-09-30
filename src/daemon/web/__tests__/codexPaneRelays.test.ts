import {describe,it,expect,vi} from 'vitest';
import type {ManagedSession} from '../../DaemonSessionManager';
import {CodexPaneRelays} from '../codexPaneRelays';
import type {createCodexTuiRelay} from '../codexTuiRelay';
const owner=(id='pane')=>({meta:{id,state:'attached'}} as ManagedSession);
function relay() {
  const state = {retired:false,selected:true};
  return {url:'unix:///private/socket',state,
    current:()=>state.selected ? {threadId:'thread',cwd:'/repo',generation:1} : undefined,
    retired:()=>state.retired,close:vi.fn(async()=> { /* noop */ }),
    answer:vi.fn(async(_threadId:string,_requestId:string,_decision:'accept'|'cancel'):Promise<'ok'|'not-found'|'unavailable'>=>'ok')};
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
  it('names the account home only for a live, committed relay (account status)',async()=>{
    const connection=relay();const registry=new CodexPaneRelays(async()=>connection);
    const lease=await registry.prepare('pane','/h/account-a');const pane=owner();
    expect(registry.accountHome('pane',pane)).toBeUndefined();
    expect(registry.liveIds()).toEqual([]);
    lease.commit(pane);
    expect(registry.accountHome('pane',pane)).toBe('/h/account-a');
    expect(registry.liveIds()).toEqual(['pane']);
    connection.state.retired=true;
    expect(registry.accountHome('pane',pane)).toBeUndefined();
    expect(registry.liveIds()).toEqual([]);
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
describe('Codex pane relay runtime start',()=>{
  it('ensures the shared runtime before creating every relay, and survives its failure',async()=>{
    const order:string[]=[];
    const connection=relay();
    const registry=new CodexPaneRelays(async()=>{order.push('create');return connection;},undefined,undefined,
      {ensureRuntime:async(id,codeHome)=>{order.push(`runtime:${id}:${codeHome}`);throw new Error('codex missing');}});
    await registry.prepare('pane','/h/.codex');
    expect(order).toEqual(['runtime:pane:/h/.codex','create']);
    await registry.shutdown();
  });
});
type RelayOptions = Parameters<typeof createCodexTuiRelay>[0];
describe('Codex pane relay policy',()=>{
  const paneOf=(id:string)=>({meta:{id,state:'attached',env:{WMUX_WORKSPACE_ID:`ws-${id}`,WMUX_PTY_ID:'forged'}}} as unknown as ManagedSession);
  function setup(hooks:ConstructorParameters<typeof CodexPaneRelays>[3]={}) {
    const options=new Map<string,RelayOptions>();
    const registry=new CodexPaneRelays((async(o:RelayOptions & {policy?:{paneId:string}})=>{options.set(o.policy!.paneId,o);return relay();}) as unknown as typeof createCodexTuiRelay,undefined,undefined,hooks);
    return {registry,policy:(id:string)=>options.get(id)!.policy!};
  }
  it('serves identity only from the committed owner\'s session record, and none after retirement',async()=>{
    const refused=vi.fn();
    const {registry,policy}=setup({refused});
    const lease=await registry.prepare('pane');
    expect(policy('pane').identity()).toBeUndefined();
    lease.commit(paneOf('pane'));
    expect(policy('pane').identity()).toMatchObject({WMUX_PTY_ID:'pane',WMUX_WORKSPACE_ID:'ws-pane',WMUX_MEMBER_ID:'pane'});
    policy('pane').refused?.('malformed');
    expect(refused).toHaveBeenCalledWith('pane','malformed');
    await registry.retire('pane');
    expect(policy('pane').identity()).toBeUndefined();
  });
  it('tracks which pane owns a thread, and whether that pane is still live',async()=>{
    const {registry,policy}=setup();
    const a=await registry.prepare('a');a.commit(paneOf('a'));
    const b=await registry.prepare('b');b.commit(paneOf('b'));
    policy('a').recordOwner('thread-1');
    expect(policy('b').owner('thread-1')).toEqual({paneId:'a',live:true});
    await registry.retire('a');
    expect(policy('b').owner('thread-1')).toEqual({paneId:'a',live:false});
    // A retired relay cannot claim threads any more.
    policy('a').recordOwner('thread-2');
    expect(policy('b').owner('thread-2')).toBeUndefined();
    await registry.shutdown();
  });
  it('reports the server proven only when the runtime says so, per account',async()=>{
    const {registry,policy}=setup({serverProven:(home)=>home==='/clean'});
    await registry.prepare('a','/clean');await registry.prepare('b','/other');
    expect(policy('a').serverProven()).toBe(true);
    expect(policy('b').serverProven()).toBe(false);
    await registry.shutdown();
  });
});
describe('Codex pane relay phone answers',()=>{
  const paneOf=(id:string)=>({meta:{id,state:'attached',env:{}}} as unknown as ManagedSession);
  const request={method:'item/commandExecution/requestApproval' as const,threadId:'thread-1',question:'Run?',toolName:'command'};
  function setup(hooks:ConstructorParameters<typeof CodexPaneRelays>[3]={}) {
    const options=new Map<string,RelayOptions>();const relays=new Map<string,ReturnType<typeof relay>>();
    const registry=new CodexPaneRelays((async(o:RelayOptions & {policy?:{paneId:string}})=>{
      const r=relay();options.set(o.policy!.paneId,o);relays.set(o.policy!.paneId,r);return r;
    }) as unknown as typeof createCodexTuiRelay,undefined,undefined,hooks);
    return {registry,policy:(id:string)=>options.get(id)!.policy!,relay:(id:string)=>relays.get(id)!};
  }
  it('reports a pending request with its relay incarnation, and answers Yes as accept and No as cancel',async()=>{
    const pending=vi.fn();const settled=vi.fn();
    const {registry,policy,relay:relayOf}=setup({decisionPending:pending,decisionSettled:settled});
    const lease=await registry.prepare('a');
    // No committed owner yet: nothing to record against.
    policy('a').decisionPending?.('0',request);
    expect(pending).not.toHaveBeenCalled();
    const pane=paneOf('a');lease.commit(pane);policy('a').recordOwner('thread-1');
    policy('a').decisionPending?.('0',request);
    const ref=pending.mock.calls[0]![2];
    expect(pending).toHaveBeenCalledWith('a',pane,{relayId:expect.any(String),threadId:'thread-1',requestId:'0',method:request.method},request);
    await expect(registry.answer(ref,'approve')).resolves.toBe('ok');
    await expect(registry.answer(ref,'deny')).resolves.toBe('ok');
    expect(relayOf('a').answer.mock.calls).toEqual([['thread-1','0','accept'],['thread-1','0','cancel']]);
    policy('a').decisionSettled?.('0','thread-1','answered-locally');
    expect(settled).toHaveBeenCalledWith('a',{relayId:ref.relayId,threadId:'thread-1',requestId:'0'},'answered-locally');
    await registry.shutdown();
  });
  it('answers only through the reporting relay while its pane still owns the thread',async()=>{
    const pending=vi.fn();
    const {registry,policy,relay:relayOf}=setup({decisionPending:pending});
    const a=await registry.prepare('a');a.commit(paneOf('a'));policy('a').recordOwner('thread-1');
    policy('a').decisionPending?.('0',request);
    const ref=pending.mock.calls[0]![2];
    // Another relay's id space, no relay at all, or no thread: never this request.
    await expect(registry.answer({...ref,relayId:'other'},'approve')).resolves.toBe('not-found');
    await expect(registry.answer({requestId:'0',threadId:'thread-1'},'approve')).resolves.toBe('not-found');
    await expect(registry.answer({relayId:ref.relayId,requestId:'0'},'approve')).resolves.toBe('not-found');
    // Another pane resumed the thread: it is no longer this pane's to answer.
    const b=await registry.prepare('b');b.commit(paneOf('b'));policy('b').recordOwner('thread-1');
    await expect(registry.answer(ref,'approve')).resolves.toBe('not-found');
    policy('a').recordOwner('thread-1');
    // The pane's relay retired (the account server restarted): a new relay starts ids at 0 again.
    await registry.retire('a');
    await expect(registry.answer(ref,'approve')).resolves.toBe('not-found');
    const next=await registry.prepare('a');next.commit(paneOf('a'));policy('a').recordOwner('thread-1');
    await expect(registry.answer(ref,'approve')).resolves.toBe('not-found');
    expect(relayOf('a').answer).not.toHaveBeenCalled();
    await registry.shutdown();
  });
});
