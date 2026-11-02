// `rpc:invoke` dispatches only the methods the window itself calls. These
// tests pin RENDERER_RPC_METHODS to the renderer's and preload's call sites:
// a new call whose method is not listed, or a listed method no call uses,
// fails here.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { RENDERER_RPC_METHODS } from '../rpcInvoke';

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const rendererFiles = sourceFiles(resolve(ROOT, 'src/renderer'));
const preloadSrc = readFileSync(resolve(ROOT, 'src/preload/preload.ts'), 'utf8');

/** Every method the renderer and preload send through rpc:invoke. */
function calledMethods(): Set<string> {
  const found = new Set<string>();
  // Renderer: `rpc.invoke('m'`, a held `invoke('m'`, and the channels
  // bridge's `rpc('m'` (useChannelsHydration).
  for (const file of rendererFiles) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(?:invoke|rpc)\(\s*'([^']+)'/g)) found.add(m[1]);
  }
  // Preload: direct sends on the channel, and factoryBotCall.
  for (const m of preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*IPC\.RPC_INVOKE\s*,\s*'([^']+)'/g)) found.add(m[1]);
  for (const m of preloadSrc.matchAll(/factoryBotCall\(\s*'([^']+)'/g)) found.add(m[1]);
  // factoryBotCall(`bot.${action}`): the action union on botAction.
  const actions = /botAction:\s*\(action:\s*((?:'[a-z]+'\s*\|?\s*)+),/.exec(preloadSrc);
  expect(actions, 'botAction action union').not.toBeNull();
  for (const a of actions![1].matchAll(/'([a-z]+)'/g)) found.add(`bot.${a[1]}`);
  return found;
}

describe('rpc:invoke allowlist', () => {
  it('is exactly this list (changing it means changing this test)', () => {
    expect([...RENDERER_RPC_METHODS].sort()).toEqual([
      'a2a.channel.get',
      'a2a.channel.getMembers',
      'a2a.channel.getMessages',
      'a2a.channel.list',
      'a2a.task.query',
      'a2a.task.send',
      'bot.interrupt',
      'bot.park',
      'bot.remove',
      'bot.resume',
      'bot.update',
      'bot.wake',
      'events.poll',
      'routine.list',
      'task.mission.list',
    ]);
    expect(Object.isFrozen(RENDERER_RPC_METHODS)).toBe(true);
  });

  it('matches the methods the renderer and preload actually call', () => {
    expect([...calledMethods()].sort()).toEqual([...RENDERER_RPC_METHODS].sort());
  });

  it('has no renderer call that names its method at run time, except the channels read bridge', () => {
    const dynamic: string[] = [];
    for (const file of rendererFiles) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/rpc\??\.invoke\(\s*([^'\s][^,)]*)/g)) {
        dynamic.push(`${relative(ROOT, file).split(sep).join('/')}: ${m[1].trim()}`);
      }
    }
    // __wmuxChannelsRpc.rpc(method) forwards the four channel reads, whose
    // callers (useChannelsHydration) the scan above already covers.
    expect(dynamic).toEqual(['src/renderer/hooks/useRpcBridge.ts: method']);
  });

  it('has no preload send on the channel with a run-time method other than the two pass-throughs', () => {
    const dynamic = [...preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*IPC\.RPC_INVOKE\s*,\s*([^'\s][^,)]*)/g)].map((m) => m[1].trim());
    // factoryBotCall(method, …) and electronAPI.rpc.invoke(method, …).
    expect(dynamic).toEqual(['method', 'method']);
  });
});
