import { describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '../../DaemonSessionManager';
import { paneCodexSettings } from '../paneCodexSettings';
import type { CodexSettingsRPC } from '../codexLiveSettings';

function fixture() {
  const meta = {state:'attached',incarnationId:'incarnation-a',pid:123,spawnCwd:'/repo',
    env:{CODEX_HOME:'/spawn-account'},resumeBinding:{agent:'codex',sessionId:'01234567-89ab-4cde-8123-456789abcdef',cwd:'/repo',ts:1}};
  const selection = {threadId:meta.resumeBinding.sessionId,cwd:'/repo',generation:1,relayId:'relay-a'};
  let owned = {meta} as unknown as ManagedSession;
  let authorized = true;
  let onRead = () => { /* noop */ };
  const methods: string[] = [];
  const rpc: CodexSettingsRPC = async method => {
    methods.push(method);
    if (method === 'thread/read') {
      onRead();
      return {thread:{id:selection.threadId,cwd:'/repo',model:'model-a',reasoningEffort:'low',status:{type:'idle'}}};
    }
    if (method === 'model/list') return {data:[{model:'model-a',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
    return {};
  };
  const close = vi.fn();
  const connect = vi.fn(async () => ({rpc,close}));
  const deps = {session:()=>owned,agentName:()=> 'Codex',selection:()=>selection as typeof selection | undefined,connect};
  return {meta,selection,deps,methods,close,connect,allowed:()=>authorized,
    revoke:()=>{authorized=false;},replace:()=>{owned={...owned};},duringRead:(action:()=>void)=>{onRead=action;}};
}
describe('pane-bound Codex settings', () => {
  it('uses the actual spawn account and closes the connection after projection', async () => {
    const f = fixture();
    expect(await paneCodexSettings(f.deps,'pane',f.allowed)).toMatchObject({agent:'codex',model:'model-a'});
    expect(f.connect).toHaveBeenCalledWith({cwd:'/repo',codeHome:'/spawn-account'});
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(['replaced','revoked','account','thread','pid','dead'])('refuses %s changes between reads before any write', async change => {
    const f = fixture();
    const before = await paneCodexSettings(f.deps,'pane',f.allowed);
    f.duringRead(() => {
      if (change === 'replaced') f.replace();
      if (change === 'revoked') f.revoke();
      if (change === 'account') f.meta.env.CODEX_HOME='/other-account';
      if (change === 'thread') f.selection.threadId='11234567-89ab-4cde-8123-456789abcdef';
      if (change === 'pid') f.meta.pid++;
      if (change === 'dead') f.meta.state='dead';
    });
    await expect(paneCodexSettings(f.deps,'pane',f.allowed,{model:'model-a',effort:'low',expectedRevision:before.revision})).rejects.toBeDefined();
    expect(f.methods).not.toContain('thread/settings/update');
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  it.each(['incarnation','process','account','relay','selection'])('rejects a revision from an earlier %s scope before connecting', async change => {
    const f = fixture();
    const before = await paneCodexSettings(f.deps,'pane',f.allowed);
    if (change === 'incarnation') f.meta.incarnationId='incarnation-b';
    if (change === 'process') f.meta.pid++;
    if (change === 'account') f.meta.env.CODEX_HOME='/cloned-account';
    if (change === 'relay') f.selection.relayId='relay-b';
    if (change === 'selection') f.selection.generation++;
    await expect(paneCodexSettings(f.deps,'pane',f.allowed,{model:'model-a',effort:'low',expectedRevision:before.revision})).rejects.toMatchObject({reason:'stale'});
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.methods).not.toContain('thread/settings/update');
  });
  it('accepts a revision from the same pane and returns a scoped confirmed revision', async () => {
    const f = fixture();
    const before = await paneCodexSettings(f.deps,'pane',f.allowed);
    const after = await paneCodexSettings(f.deps,'pane',f.allowed,{model:'model-a',effort:'low',expectedRevision:before.revision});
    expect(after.revision).toBe(before.revision);
    expect(after.revision).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect(f.methods.filter(method=>method==='thread/settings/update')).toHaveLength(1);
  });
  it('never falls back to a persisted resume marker when the live relay has no selection', async () => {
    const f = fixture();
    f.deps.selection=()=>undefined;
    await expect(paneCodexSettings(f.deps,'pane',f.allowed)).rejects.toMatchObject({reason:'unavailable'});
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('ignores unrelated persisted hook updates while the owned relay stays selected', async () => {
    const f = fixture();
    f.meta.resumeBinding.sessionId='stale-marker';
    expect(await paneCodexSettings(f.deps,'pane',f.allowed)).toMatchObject({model:'model-a'});
  });
  it('waits for asynchronous authorization and rechecks pane identity after it resolves', async () => {
    const f = fixture();
    let release!: (value:boolean)=>void;
    const authorized = new Promise<boolean>(resolve=>{release=resolve;});
    const work = paneCodexSettings(f.deps,'pane',()=>authorized);
    expect(f.connect).not.toHaveBeenCalled();
    f.replace();
    release(true);
    await expect(work).rejects.toMatchObject({reason:'unavailable'});
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('does not release a read result when authority is revoked during the RPC', async () => {
    const f = fixture();
    f.duringRead(f.revoke);
    await expect(paneCodexSettings(f.deps,'pane',async()=>f.allowed())).rejects.toMatchObject({reason:'unavailable'});
    expect(f.methods).toEqual(['thread/read']);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('fails closed when the asynchronous credential resolver errors', async () => {
    const f = fixture();
    await expect(paneCodexSettings(f.deps,'pane',async()=>{throw new Error('resolver failed');})).rejects.toMatchObject({reason:'unavailable'});
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['cwd','agent','account','authority'])('refuses invalid %s before connecting', async condition => {
    const f = fixture();
    if (condition === 'cwd') f.selection.cwd='relative';
    if (condition === 'agent') f.deps.agentName=()=> 'Claude';
    if (condition === 'account') f.meta.env.CODEX_HOME='relative';
    if (condition === 'authority') f.revoke();
    await expect(paneCodexSettings(f.deps,'pane',f.allowed)).rejects.toMatchObject({reason:'unavailable'});
    expect(f.connect).not.toHaveBeenCalled();
  });
});


it('accepts the canonical Codex CLI display name emitted by the real daemon',async()=>{
  const f=fixture();f.deps.agentName=()=> 'Codex CLI';
  await expect(paneCodexSettings(f.deps,'pane',f.allowed)).resolves.toMatchObject({agent:'codex',model:'model-a'});
});
