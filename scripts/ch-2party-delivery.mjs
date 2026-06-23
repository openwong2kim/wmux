// 2-party live delivery test. A creates a PUBLIC channel; B joins; A posts;
// we poll events.poll SCOPED TO B (a member that is NOT the sender). If A's
// message reaches B's scoped poll, live delivery to a non-sender member works
// (the actual "human receives an agent's channel message" path). Uses the
// renderer mutateLocal bridge (stamps supplied verifiedWorkspaceId = models two
// same-machine callers) + events.poll via rpc.invoke (reads the main eventBus).
import { chromium } from 'playwright-core';
import http from 'node:http';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url){return new Promise((res)=>{const q=http.get(url,(r)=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res(b));});q.on('error',()=>res(null));q.setTimeout(800,()=>{q.destroy();res(null);});});}
async function findPort(){for(let p=18800;p<18900;p++){const b=await httpGet(`http://127.0.0.1:${p}/json/version`);if(b&&b.includes('webSocketDebuggerUrl'))return p;}return null;}
const port = process.env.CDP_PORT ? Number(process.env.CDP_PORT) : await findPort();
if (!port) { console.log('NO CDP'); process.exit(2); }
console.log('CDP port:', port);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
let page = null;
for (const p of ctx.pages()) { try { if (await p.evaluate(() => !!document.querySelector('.xterm'))) { page = p; break; } } catch {} }
if (!page) { console.log('NO RENDERER'); await browser.close(); process.exit(2); }

const result = await page.evaluate(async () => {
  const m = window.__wmuxChannelsRpc?.mutateLocal;
  const inv = (method, params) => window.electronAPI.rpc.invoke(method, params);
  if (!m) return { err: 'no mutateLocal' };
  const A = 'live-A', B = 'live-B';
  const name = 'live2p-' + Math.floor(performance.now());
  const marker = 'msg-' + Math.floor(performance.now());

  // A creates a PUBLIC channel.
  const create = await m('a2a.channel.create', {
    name, visibility: 'public',
    createdBy: { workspaceId: A, memberId: 'a', memberName: 'A' },
    verifiedWorkspaceId: A,
  });
  const channelId = create?.channel?.id;
  if (!channelId) return { step: 'create', create };

  // B joins (now a member → in recipientWorkspaceIds for future posts).
  const join = await m('a2a.channel.join', {
    channelId, member: { workspaceId: B, memberId: 'b', memberName: 'B' }, verifiedWorkspaceId: B,
  });

  // Baseline head BEFORE A posts.
  const head0 = (await inv('events.poll', { cursor: 0, max: 1024 }))?.result?.nextCursor ?? 0;

  // A posts.
  const post = await m('a2a.channel.post', {
    channelId, text: marker,
    sender: { workspaceId: A, memberId: 'a', memberName: 'A' },
    verifiedWorkspaceId: A,
  });

  // Poll SCOPED TO B (non-sender member) for the marker, with retries.
  let bScoped = null, unscoped = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const rb = await inv('events.poll', { cursor: head0, types: ['channel.message'], workspaceId: B });
    const evb = rb?.result?.events ?? [];
    bScoped = evb.find((e) => e.message?.text === marker) ? 'FOUND' : (evb.length ? `other(${evb.length})` : 'empty');
    const ru = await inv('events.poll', { cursor: head0, max: 1024 });
    const evu = (ru?.result?.events ?? []).filter((e) => e.type === 'channel.message');
    unscoped = evu.find((e) => e.message?.text === marker) ? 'FOUND' : (evu.length ? `other(${evu.length})` : 'empty');
    if (bScoped === 'FOUND') break;
  }

  // Cleanup.
  await m('a2a.channel.archive', { channelId, verifiedWorkspaceId: A }).catch(() => {});

  return {
    channelId, join: join?.ok, post: post?.ok,
    bScopedDelivery: bScoped,      // FOUND = live delivery to non-sender member B
    unscopedRing: unscoped,        // FOUND = channel.message reached the main eventBus at all
  };
});

console.log(JSON.stringify(result, null, 2));
const ok = result.bScopedDelivery === 'FOUND';
console.log(ok
  ? '\n>>> LIVE DELIVERY CONFIRMED: A’s post reached non-sender member B’s scoped events.poll.'
  : `\n>>> NOT delivered to B (bScoped=${result.bScopedDelivery}, unscopedRing=${result.unscopedRing}). ${result.unscopedRing === 'empty' ? 'channel.message never reached the main eventBus (tee gap or instance tangle).' : 'reached ring but not B’s scope (scope bug).'}`);
await browser.close();
process.exit(ok ? 0 : 1);
