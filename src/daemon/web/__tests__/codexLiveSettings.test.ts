import { describe, expect, it } from 'vitest';
import { readCodexLiveSettings, updateCodexLiveSettings, type CodexSettingsRPC } from '../codexLiveSettings';
const binding = {threadId:'01234567-89ab-4cde-8123-456789abcdef',cwd:'/workspace'};
function fixture() {
  const state = {id:binding.threadId,cwd:binding.cwd,status:{type:'idle'},model:'model-a',reasoningEffort:'medium',preview:'private prompt'};
  const calls: Array<{method:string;params:Record<string,unknown>}> = [];
  let apply = true;
  let failAfterWrite = false;
  const rpc: CodexSettingsRPC = async (method,params) => {
    calls.push({method,params});
    if (method === 'thread/read') return {thread:{...state}};
    if (method === 'model/list') return {data:['model-a','model-b'].map(model => ({model,hidden:false,defaultReasoningEffort:'medium',
      supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}]})),nextCursor:null};
    if (apply) { state.model = String(params.model); state.reasoningEffort = String(params.effort); }
    if (failAfterWrite) throw new Error('connection dropped');
    return {};
  };
  return {state,calls,rpc,noApply:()=>{apply=false;},loseResponse:()=>{failAfterWrite=true;}};
}
describe('bound live Codex settings', () => {
  it('projects only settings and advertised choices, excluding private transcript data', async () => {
    const f = fixture();
    const result = await readCodexLiveSettings(f.rpc,binding);
    expect(result).toMatchObject({agent:'codex',model:'model-a',effort:'medium',busy:false});
    expect(result.models[1]).toEqual({model:'model-b',efforts:['low','medium'],defaultEffort:'medium'});
    expect(JSON.stringify(result)).not.toContain('private prompt');
    expect(f.calls[0]).toEqual({method:'thread/read',params:{threadId:binding.threadId,includeTurns:false}});
  });
  it('confirms a named change with a fresh runtime read and no resume/start call', async () => {
    const f = fixture();
    const initial = await readCodexLiveSettings(f.rpc,binding);
    const result = await updateCodexLiveSettings(f.rpc,binding,{model:'model-b',effort:'low',expectedRevision:initial.revision},()=>true);
    expect(result).toMatchObject({model:'model-b',effort:'low'});
    expect(result.revision).not.toBe(initial.revision);
    const writes = f.calls.filter(call => call.method === 'thread/settings/update');
    expect(writes).toEqual([{method:'thread/settings/update',params:{threadId:binding.threadId,model:'model-b',effort:'low'}}]);
    expect(f.calls.at(-1)?.method).toBe('thread/read');
  });
  it.each(['identity','cwd','notLoaded'])('refuses mismatched or unloaded bindings: %s', async kind => {
    const f = fixture();
    if (kind === 'identity') f.state.id = 'another-thread';
    if (kind === 'cwd') f.state.cwd = '/different-workspace';
    if (kind === 'notLoaded') f.state.status.type = 'notLoaded';
    await expect(readCodexLiveSettings(f.rpc,binding)).rejects.toMatchObject({reason:'unavailable'});
    expect(f.calls).toHaveLength(1);
  });
  it.each(['stale','busy','revoked','unsupported'])('refuses before writing: %s', async condition => {
    const f = fixture();
    const initial = await readCodexLiveSettings(f.rpc,binding);
    if (condition === 'stale') f.state.model = 'model-b';
    if (condition === 'busy') f.state.status.type = 'active';
    await expect(updateCodexLiveSettings(f.rpc,binding,{model:'model-b',effort:condition === 'unsupported' ? 'ultra' : 'low',expectedRevision:initial.revision},()=>condition !== 'revoked')).rejects.toBeDefined();
    expect(f.calls.some(call => call.method === 'thread/settings/update')).toBe(false);
  });
  it.each(['no-change','lost-response'])('does not infer success or retry after %s', async failure => {
    const f = fixture();
    const initial = await readCodexLiveSettings(f.rpc,binding);
    if (failure === 'no-change') f.noApply(); else f.loseResponse();
    await expect(updateCodexLiveSettings(f.rpc,binding,{model:'model-b',effort:'low',expectedRevision:initial.revision},()=>true)).rejects.toMatchObject({reason:'unconfirmed'});
    expect(f.calls.filter(call => call.method === 'thread/settings/update')).toHaveLength(1);
  });
});


describe('model catalog pagination', () => {
  const model = (name: string) => ({model:name,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]});
  it('loads later pages and permits their advertised model choices', async () => {
    const f = fixture();
    const cursors: unknown[] = [];
    const rpc: CodexSettingsRPC = async (method,params) => {
      if (method !== 'model/list') return f.rpc(method,params);
      cursors.push(params.cursor);
      return params.cursor === undefined ? {data:[model('model-a')],nextCursor:'second'} : {data:[model('model-b')],nextCursor:null};
    };
    const initial = await readCodexLiveSettings(rpc,binding);
    expect(initial.models.map(row => row.model)).toEqual(['model-a','model-b']);
    expect(cursors).toEqual([undefined,'second']);
    await expect(updateCodexLiveSettings(rpc,binding,{model:'model-b',effort:'low',expectedRevision:initial.revision},()=>true)).resolves.toMatchObject({model:'model-b'});
  });
  it.each(['cycle','duplicate','too-many-pages','invalid-cursor'])('refuses an incomplete or ambiguous catalog before writing: %s', async kind => {
    const f = fixture();
    let pages = 0;
    const rpc: CodexSettingsRPC = async (method,params) => {
      if (method !== 'model/list') return f.rpc(method,params);
      pages++;
      return {data:[model(kind === 'duplicate' ? 'model-b' : `model-${pages}`)],
        nextCursor:kind === 'invalid-cursor' ? 123 : kind === 'cycle' ? 'same' : `page-${pages}`};
    };
    await expect(updateCodexLiveSettings(rpc,binding,{model:'model-b',effort:'low',expectedRevision:'unused'},()=>true)).rejects.toMatchObject({reason:'unavailable'});
    expect(pages).toBeLessThanOrEqual(4);
    expect(f.calls).toHaveLength(0);
  });
});


it('allows confirmed settings repair after a failed non-running turn',async()=>{
  const f=fixture();f.state.status.type='systemError';
  const initial=await readCodexLiveSettings(f.rpc,binding);
  expect(initial.busy).toBe(false);
  await expect(updateCodexLiveSettings(f.rpc,binding,{model:'model-b',effort:'low',expectedRevision:initial.revision},()=>true)).resolves.toMatchObject({model:'model-b',effort:'low',busy:false});
  expect(f.calls.filter(call=>call.method==='thread/settings/update')).toHaveLength(1);
});
