// The RPC lane's frame access (frameAccess.ts) against real Chrome: the same
// CDP a guest's debugger speaks, through a page session.
//
// The fixture puts the hard cases in one page: a same-origin frame behind a
// border, padding and a CSS transform, scrolled below the fold, with a frame
// nested inside it; a cross-site frame that site isolation runs in another
// process; and a top-document button with the same label and ref tag as the
// frame's, so a lookup in the wrong document would be visible.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../test-utils/realBrowserHarness';
import { FrameTarget, FrameWorlds, evaluateInFrame, listChildFrames, type CdpSend } from '../frameAccess';

const CLICK_RECORDER = `<script>
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (t) t.dataset.clicked = String(Number(t.dataset.clicked || 0) + 1);
  });
</script>`;

function serve(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const port = (req.headers.host ?? '').split(':').pop() ?? '';
  const html = (body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8">${body}`);
  };
  switch (url.pathname) {
    case '/':
      return html(`
        <button id="top" data-wmux-ref="7">Pay</button>
        <div style="height:1400px"></div>
        <iframe id="inner" name="checkout" src="/inner.html"
          style="border:7px solid #000;padding:11px;transform:translate(13px,5px) scale(0.9);width:420px;height:320px"></iframe>
        <iframe id="xsite" src="http://localhost:${port}/leaf.html" style="width:200px;height:100px"></iframe>
        ${CLICK_RECORDER}`);
    case '/inner.html':
      return html(`
        <div style="height:500px"></div>
        <button id="pay" data-wmux-ref="7">Pay</button>
        <iframe id="nested" src="/leaf.html" style="border:3px solid #333;width:200px;height:80px"></iframe>
        ${CLICK_RECORDER}`);
    case '/leaf.html':
      return html(`<button id="leaf">Leaf</button>${CLICK_RECORDER}`);
    default:
      res.writeHead(404);
      res.end();
  }
}

async function sessionOf(page: Page): Promise<CdpSend> {
  const session = await page.context().newCDPSession(page);
  return (method, params) => session.send(method as never, params as never) as Promise<unknown>;
}

async function loaded(page: Page): Promise<void> {
  await page.frameLocator('#inner').frameLocator('#nested').locator('#leaf').waitFor({ state: 'attached', timeout: 10_000 });
}

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'frameAccess', serve });

  describe(`frameAccess (${mode.name})`, { timeout: 60_000 }, () => {
    it('lists in-process frames with their origin and reads each in its own document only', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = (await h.browser().newPage()) as Page;
      try {
        await page.goto(h.origin(), { waitUntil: 'load' });
        await loaded(page);
        const send = await sessionOf(page);
        const worlds = new FrameWorlds(send);
        const frames = await listChildFrames(send);
        const inner = frames.find((f) => f.name === 'checkout');
        expect(inner).toMatchObject({ depth: 1, origin: h.origin().replace(/\/$/, '') + '/…' });
        const nested = frames.find((f) => f.parentId === inner?.frameId);
        expect(nested?.depth).toBe(2);

        // The frame's own ref tag, not the top document's same-numbered one.
        const read = await evaluateInFrame(send, worlds, inner!.frameId, `document.querySelector('[data-wmux-ref="7"]').id`);
        expect(read).toEqual({ value: 'pay' });

        // The cross-site frame runs in another process: unreachable, not an error.
        const xsite = frames.find((f) => f.origin.startsWith(h.crossSiteOrigin().replace(/\/$/, '')));
        if (xsite) {
          expect(await evaluateInFrame(send, worlds, xsite.frameId, '1')).toMatchObject({ unreachable: expect.any(String) });
        }
      } finally {
        await page.close();
      }
    });

    it('refuses a frame that navigated or went away since its loaderId was read', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = (await h.browser().newPage()) as Page;
      try {
        await page.goto(h.origin(), { waitUntil: 'load' });
        await loaded(page);
        const send = await sessionOf(page);
        const worlds = new FrameWorlds(send);
        const inner = (await listChildFrames(send)).find((f) => f.name === 'checkout')!;
        // Read once first, so the navigated frame's world is a cached one.
        expect(await evaluateInFrame(send, worlds, inner.frameId, '1', inner.loaderId)).toEqual({ value: 1 });
        await page.evaluate(() => { (document.getElementById('inner') as HTMLIFrameElement).src = '/leaf.html'; });
        await page.frameLocator('#inner').locator('#leaf').waitFor({ state: 'attached' });
        await expect(evaluateInFrame(send, worlds, inner.frameId, '1', inner.loaderId)).rejects.toThrow(/^FRAME_NAVIGATED/);
        await page.evaluate(() => document.getElementById('inner')?.remove());
        await expect(evaluateInFrame(send, worlds, inner.frameId, '1')).rejects.toThrow(/^FRAME_GONE/);
      } finally {
        await page.close();
      }
    });

    it('stops a frame read at its timeout, and still answers one that finishes in time', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = (await h.browser().newPage()) as Page;
      try {
        await page.goto(h.origin(), { waitUntil: 'load' });
        await loaded(page);
        const send = await sessionOf(page);
        const worlds = new FrameWorlds(send);
        const inner = (await listChildFrames(send)).find((f) => f.name === 'checkout')!;
        expect(await evaluateInFrame(send, worlds, inner.frameId, '1 + 1', inner.loaderId, 2000)).toEqual({ value: 2 });
        const started = Date.now();
        await expect(evaluateInFrame(send, worlds, inner.frameId, 'for (;;) {}', inner.loaderId, 300)).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(3000);
        // Chrome stopped the loop: the frame answers the next read.
        expect(await evaluateInFrame(send, worlds, inner.frameId, '3', inner.loaderId, 2000)).toEqual({ value: 3 });
      } finally {
        await page.close();
      }
    });

    it('presses where the element is through borders, padding, scroll, a transform and nesting, and checks the hit', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = (await h.browser().newPage()) as Page;
      try {
        await page.goto(h.origin(), { waitUntil: 'load' });
        await loaded(page);
        const send = await sessionOf(page);
        const worlds = new FrameWorlds(send);
        const frames = await listChildFrames(send);
        const inner = frames.find((f) => f.name === 'checkout')!;
        const nested = frames.find((f) => f.parentId === inner.frameId)!;

        for (const [frame, selector, owner] of [[inner, '#pay', ['#inner']], [nested, '#leaf', ['#inner', '#nested']]] as const) {
          const target = await FrameTarget.resolve(send, worlds, frame.frameId, frame.loaderId, selector);
          expect(target).toBeInstanceOf(FrameTarget);
          const t = target as FrameTarget;
          const point = await t.point();
          expect(point).not.toBeNull();
          expect(await t.hits(point!)).toBe(true);
          // Off by the owner chain is a miss, never a hit on the wrong thing.
          expect(await t.hits({ x: point!.x - 300, y: point!.y - 300 })).toBe(false);
          await page.mouse.click(point!.x, point!.y);
          await t.release();
          let loc = page.frameLocator(owner[0]);
          for (const o of owner.slice(1)) loc = loc.frameLocator(o);
          expect(await loc.locator(selector).getAttribute('data-clicked')).toBe('1');
        }
        expect(await page.locator('#top').getAttribute('data-clicked')).toBeNull();
      } finally {
        await page.close();
      }
    });

    it('does not pile up worlds over 200 reads of the same frames', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = (await h.browser().newPage()) as Page;
      try {
        await page.goto(h.origin(), { waitUntil: 'load' });
        await loaded(page);
        const session = await page.context().newCDPSession(page);
        const send: CdpSend = (m, p) => session.send(m as never, p as never) as Promise<unknown>;
        let created = 0;
        session.on('Runtime.executionContextCreated', (e: { context: { name: string } }) => {
          if (e.context.name === 'wmux-rpc-frames') created++;
        });
        await send('Runtime.enable');
        const frames = (await listChildFrames(send)).filter((f) => !f.origin.startsWith(h.crossSiteOrigin().replace(/\/$/, '')));
        const ids = new Set<number>();
        for (let i = 0; i < 200; i++) {
          // A fresh cache each round: Chrome's own reuse is what is measured.
          const worlds = new FrameWorlds(send);
          for (const f of frames) {
            const ctx = await worlds.contextFor(f.frameId);
            if ('contextId' in ctx) ids.add(ctx.contextId);
          }
        }
        expect(ids.size).toBe(frames.length);
        expect(created).toBeLessThanOrEqual(frames.length);
      } finally {
        await page.close();
      }
    });
  });
}
