import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectCodexSettings, SettingsTransport } from '../codexSettingsTransport';
const connections: SettingsTransport[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); });
function fixture(timeout = 1000, limit = 4096) {
  const messages: Array<Record<string, any>> = [];
  const socket = Object.assign(new EventEmitter(), {
    send: (text:string, done:(error?:Error)=>void) => { messages.push(JSON.parse(text)); done(); },
    terminate: vi.fn(),
  });
  const transport = new SettingsTransport(socket as unknown as WebSocket, timeout, limit);
  connections.push(transport);
  const reply = (message:unknown) => socket.emit('message',Buffer.from(JSON.stringify(message)),false);
  const ready = async () => { const pending = transport.initialize(); reply({id:1,result:{}}); await pending; };
  return {socket,messages,transport,reply,ready};
}
describe('Codex Unix WebSocket settings transport', () => {
  it('rejects ambiguous or relative account scope before connecting', async () => {
    await expect(connectCodexSettings({cwd:'relative'})).rejects.toThrow('Invalid');
    await expect(connectCodexSettings({cwd:'/repo',codeHome:'/account:other'})).rejects.toThrow('Invalid');
  });
  it('requires initialization and projects Unicode text frames', async () => {
    const f=fixture();
    await expect(f.transport.rpc('model/list',{})).rejects.toThrow('Unsupported');
    await f.ready();
    expect(f.messages.map(row=>row.method)).toEqual(['initialize','initialized']);
    const result=f.transport.rpc('model/list',{});
    f.reply({id:2,result:{label:'모델'}});
    await expect(result).resolves.toEqual({label:'모델'});
  });
  it('lists skills through a fixed read-only operation without widening settings RPC', async () => {
    const f=fixture(); await f.ready();
    const result=f.transport.skills('/repo');
    expect(f.messages.at(-1)).toMatchObject({method:'skills/list',params:{cwds:['/repo'],forceReload:false}});
    f.reply({id:2,result:{data:[]}});
    await expect(result).resolves.toEqual({data:[]});
    await expect(f.transport.rpc('skills/list' as never,{})).rejects.toThrow('Unsupported');
    await expect(f.transport.skills('relative')).rejects.toThrow('Invalid');
  });
  it('refuses server approvals and excludes private provider errors', async () => {
    const f=fixture(); await f.ready();
    f.reply({id:'approval',method:'item/commandExecution/requestApproval'});
    expect(f.messages.at(-1)).toMatchObject({id:'approval',error:{code:-32601}});
    const result=f.transport.rpc('thread/read',{});
    f.reply({id:2,error:{message:'private credential'}});
    await expect(result).rejects.toThrow('Codex settings request refused');
    await expect(f.transport.rpc('turn/start' as never,{})).rejects.toThrow('Unsupported');
  });
  it.each(['malformed','oversized','binary','disconnect','budget'])('rejects all pending work on %s without replay', async failure => {
    const f=fixture(); await f.ready();
    const settled=Promise.allSettled([f.transport.rpc('thread/read',{}),f.transport.rpc('model/list',{})]);
    if(failure==='malformed') f.socket.emit('message',Buffer.from('{bad}'),false);
    if(failure==='oversized') f.socket.emit('message',Buffer.alloc(4097),false);
    if(failure==='binary') f.socket.emit('message',Buffer.from('{}'),true);
    if(failure==='disconnect') f.socket.emit('close');
    if(failure==='budget') for(let i=0;i<2200;i++) f.socket.emit('message',Buffer.from(JSON.stringify({method:'notice',text:'x'.repeat(4000)})),false);
    expect((await settled).map(row=>row.status)).toEqual(['rejected','rejected']);
    expect(f.messages).toHaveLength(4);
    await expect(f.transport.rpc('model/list',{})).rejects.toThrow();
  });
  it('times out once and closes only its own socket', async () => {
    const f=fixture(10); await f.ready();
    await expect(f.transport.rpc('thread/read',{})).rejects.toThrow('timed out');
    f.transport.close();
    expect(f.socket.terminate).toHaveBeenCalledTimes(1);
    expect(f.messages).toHaveLength(3);
  });
});
