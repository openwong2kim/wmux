/**
 * Real-child tests for repl_run's `browser` object.
 *
 * The run binding lives on both sides of a process boundary — the child tags
 * each call with the eval it came from, the parent decides — so only a real
 * child proves it. The browser handlers are fakes in the collector's shape.
 */
import * as os from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ActionRing, recordAction, type ActionRingDeps } from '../../browser-replay/actionRing';
import { hintBlockMeta } from '../../playwright/hintBlock';
import type { CollectedTool } from '../../playwright/toolCollector';
import { ReplSession } from '../ReplSession';
import { REPL_BROWSER_PROFILE_REFUSAL, formatOutcome, resolveReplBrowser } from '../tools';

const live: ReplSession[] = [];

afterEach(() => {
  while (live.length > 0) live.pop()?.destroy('test cleanup');
});

function makeSession(): ReplSession {
  const session = new ReplSession({ name: 'browser-test', cwd: os.tmpdir() });
  live.push(session);
  return session;
}

interface Fake {
  tools: Map<string, CollectedTool>;
  called: Array<{ name: string; args: Record<string, unknown> }>;
  ring: ActionRing;
}

function fakeBrowser(): Fake {
  const called: Fake['called'] = [];
  const ring = new ActionRing();
  const tools = new Map<string, CollectedTool>();
  const add = (short: string, shape: z.ZodRawShape, impl: (args: Record<string, unknown>) => CallToolResult) => {
    tools.set(`browser_${short}`, {
      name: `browser_${short}`,
      shape,
      handler: async (args) => {
        called.push({ name: short, args });
        return impl(args);
      },
    });
  };
  add('click', { ref: z.string() }, (args) => {
    // Records the way the real handler does, so the test sees what reaches the ring.
    const deps: ActionRingDeps = { resolveWorkspaceId: async () => 'w1', actionRing: ring };
    recordAction(deps, {
      tool: 'browser_click',
      scope: { workspaceId: 'w1' },
      page: null,
      ref: String(args.ref),
    });
    return {
      content: [
        { type: 'text', text: '[replay] 1 recorded flow(s) for this page: login', _meta: hintBlockMeta() },
        { type: 'text', text: `Clicked ${String(args.ref)}` },
      ],
    };
  });
  add('screenshot', { maxBytes: z.number().optional() }, () => ({
    content: [
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'text', text: 'This is a viewport capture at devicePixelRatio 1.' },
    ],
  }));
  add('storage', { action: z.string().optional() }, () => ({ content: [{ type: 'text', text: 'storage entries' }] }));
  return { tools, called, ring };
}

describe('repl_run browser bridge (real child)', () => {
  it('round-trips a call through the collected handler, without touching the action ring', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const outcome = await session.run(
      'const r = await browser.click({ ref: "3" }); [r.text, r.events.length]',
      10_000,
      resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toContain("'Clicked 3'");
    expect(fake.called).toEqual([{ name: 'click', args: { ref: '3' } }]);
    expect(fake.ring.all()).toEqual([]);
    expect(outcome.browser?.calls).toBe(1);
    expect(outcome.browser?.hints).toEqual(['1. [replay] 1 recorded flow(s) for this page: login']);
  });

  it('attaches a screenshot to the run and names it in the value', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const outcome = await session.run(
      'const shot = await browser.screenshot();\nshot.image',
      10_000,
      resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined),
    );
    expect(outcome.result?.text).toBe("'img-1'");
    expect(outcome.browser?.images).toEqual([
      { id: 'img-1', callIndex: 1, data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ]);
    expect(formatOutcome('browser-test', outcome, [])).toContain('img-1: call 1 (image/png');
  });

  it('refuses a non-whitelisted name even when the message is forged past the browser object', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const outcome = await session.run(
      [
        'const seen = typeof browser.storage;',
        'const reply = new Promise((resolve) => process.on("message", (m) => { if (m && m.callId === 9001) resolve(m); }));',
        // The first eval of a fresh session has id 1: the forgery carries the
        // CORRECT run id, so only the name check can stop it.
        'process.send({ type: "browserCall", callId: 9001, runId: 1, name: "storage", args: {} });',
        'const m = await reply;',
        '[seen, m.ok, m.error]',
      ].join('\n'),
      10_000,
      resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toContain("'undefined'");
    expect(outcome.result?.text).toContain('false');
    expect(outcome.result?.text).toContain('browser.storage is not available inside repl_run');
    expect(fake.called).toEqual([]);
  });

  it('refuses a call carrying a forged run id', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const outcome = await session.run(
      [
        'const reply = new Promise((resolve) => process.on("message", (m) => { if (m && m.callId === 9002) resolve(m); }));',
        'process.send({ type: "browserCall", callId: 9002, runId: 999, name: "click", args: { ref: "1" } });',
        'const m = await reply;',
        '[m.ok, m.error]',
      ].join('\n'),
      10_000,
      resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined),
    );
    expect(outcome.result?.text).toContain('does not belong to the repl_run call in flight');
    expect(fake.called).toEqual([]);
  });

  it('refuses a call a timer makes after its run reported back', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const binding = resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined);
    const first = await session.run(
      'globalThis.late = new Promise((r) => setTimeout(() => browser.click({ ref: "x" }).then(() => r("ran"), (e) => r(e.name + ": " + e.message)), 50)); 0',
      10_000,
      binding,
    );
    expect(first.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await session.run('await globalThis.late', 10_000, binding);
    expect(second.result?.text).toContain('BrowserToolError: browser.click: refused');
    expect(fake.called).toEqual([]);
  });

  it('refuses every call off the full profile with a reason naming the profile', async () => {
    for (const profile of ['core', 'commander'] as const) {
      const fake = fakeBrowser();
      const session = makeSession();
      const outcome = await session.run(
        'let msg = "ran";\ntry { await browser.click({ ref: "1" }); } catch (e) { msg = e.message; }\nmsg',
        10_000,
        resolveReplBrowser({ tools: fake.tools, profile }, undefined),
      );
      expect(outcome.result?.text).toBe(`'browser.click: ${REPL_BROWSER_PROFILE_REFUSAL}'`);
      expect(fake.called).toEqual([]);
      session.destroy('next profile');
    }
  });

  it('leaves the name "browser" free for the script\'s own client object', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const binding = resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined);
    await session.run('1', 10_000, binding);
    const outcome = await session.run('let browser = "mine"; browser', 10_000, binding);
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toBe("'mine'");
  });
});
