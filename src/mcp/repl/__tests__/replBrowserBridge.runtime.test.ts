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
import { ReplRegistry } from '../replRegistry';
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

/** The refs table browser_screenshot {refs:true} appends to its basis text. */
const REFS_TABLE = 'Refs in this capture (viewport CSS px: x,y,w,h):\nref=12 button "Log in" 40,20,80,30';

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
  add('navigate', { url: z.string() }, () => ({ content: [{ type: 'text', text: 'navigated' }] }));
  add('screenshot', { maxBytes: z.number().optional(), refs: z.boolean().optional() }, (args) => ({
    content: [
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      {
        type: 'text',
        text: `This is a viewport capture at devicePixelRatio 1.${args.refs === true ? `\n\n${REFS_TABLE}` : ''}`,
      },
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

  it('keeps the refs table in the value text when a screenshot with refs:true attaches its image', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    // Checked inside the snippet: repl_run renders strings through inspect,
    // so the table's quotes and newline would be escaped in the result text.
    const outcome = await session.run(
      `const shot = await browser.screenshot({ refs: true });\n[shot.image, shot.text.includes(${JSON.stringify(REFS_TABLE)})]`,
      10_000,
      resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined),
    );
    expect(outcome.ok).toBe(true);
    expect(fake.called[0].args.refs).toBe(true);
    expect(outcome.result?.text).toBe("[ 'img-1', true ]");
    expect(outcome.browser?.images.map((img) => img.id)).toEqual(['img-1']);
  });

  it('refuses a browserCall that user code posts itself, with the current run id, and sends nothing', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const outcome = await session.run(
      [
        'const seen = typeof browser.storage;',
        // The first eval of a fresh session has id 1: the forgery carries the
        // CORRECT run id, which is exactly what must not help.
        'const forged = { type: "browserCall", callId: 9001, runId: 1, name: "navigate", args: { url: "https://x.test" } };',
        'const errors = [];',
        'try { process.send(forged); } catch (e) { errors.push(e.name + ": " + e.message); }',
        'try { process._send(forged); } catch (e) { errors.push(e.name + ": " + e.message); }',
        'await new Promise((r) => setTimeout(r, 200));',
        'const real = await browser.click({ ref: "3" });',
        '[seen, errors, real.text]',
      ].join('\n'),
      10_000,
      resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toContain("'undefined'");
    expect(outcome.result?.text.match(/TypeError: process\.send: "browserCall" messages are reserved/g)).toHaveLength(2);
    expect(outcome.result?.text).toContain('use browser.X(args)');
    // Normal in-run calls still work, and the parent never saw the forgery.
    expect(outcome.result?.text).toContain("'Clicked 3'");
    expect(fake.called.map((c) => c.name)).toEqual(['click']);
    expect(outcome.browser?.calls).toBe(1);
  });

  it('refuses a call a timer from run N makes while run N+1 is in flight', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const binding = resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined);
    await session.run(
      'setTimeout(() => browser.navigate({ url: "https://x.test" }).then(() => { globalThis.lateResult = "ran"; }, (e) => { globalThis.lateResult = e.message; }), 150); 0',
      10_000,
      binding,
    );
    const second = await session.run(
      'await new Promise((r) => setTimeout(r, 400));\nconst own = await browser.click({ ref: "4" });\n[globalThis.lateResult, own.text]',
      10_000,
      binding,
    );
    expect(second.result?.text).toContain('browser.navigate: refused — made after its repl_run run finished');
    expect(second.result?.text).toContain("'Clicked 4'");
    expect(fake.called.map((c) => c.name)).toEqual(['click']);
  });

  it('closes the binding when the result arrives, before the output drain', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const binding = resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined);
    await session.run(
      'setTimeout(() => browser.navigate({ url: "https://x.test" }).then(() => { globalThis.zeroResult = "ran"; }, (e) => { globalThis.zeroResult = e.message; }), 0); 1',
      10_000,
      binding,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await session.run('globalThis.zeroResult', 10_000, binding);
    expect(second.result?.text).toContain('browser.navigate: refused');
    expect(fake.called).toEqual([]);
  });

  it('rejects args that cannot cross IPC without leaving the call pending', async () => {
    const fake = fakeBrowser();
    const session = makeSession();
    const outcome = await session.run(
      'let msg = "ran";\ntry { await browser.click({ ref: 1n }); } catch (e) { msg = e.message; }\nmsg',
      10_000,
      resolveReplBrowser({ tools: fake.tools, profile: 'full' }, undefined),
    );
    expect(outcome.result?.text).toBe("'browser.click(args): args must be JSON-serializable'");
    expect(fake.called).toEqual([]);
  });

  it('makes a replacement session wait for browser calls its killed predecessor left running', async () => {
    let landedAt = 0;
    const tools = new Map<string, CollectedTool>();
    tools.set('browser_navigate', {
      name: 'browser_navigate',
      shape: { url: z.string() },
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        landedAt = Date.now();
        return { content: [{ type: 'text', text: 'navigated' }] };
      },
    });
    const binding = resolveReplBrowser({ tools, profile: 'full' }, undefined);
    const registry = new ReplRegistry();
    try {
      const first = registry.acquire('slow', os.tmpdir());
      // A promise that never settles: only the hard deadline ends this run,
      // and it destroys the session while navigate is still running.
      const killed = await first.session.run(
        'browser.navigate({ url: "https://x.test" });\nawait new Promise(() => {})',
        100,
        binding,
      );
      expect(killed.fatal).toBeTruthy();
      expect(landedAt).toBe(0);

      const second = registry.acquire('slow', os.tmpdir());
      expect(second.created).toBe(true);
      const outcome = await second.session.run('Date.now()', 10_000, binding);
      expect(outcome.ok).toBe(true);
      expect(landedAt).toBeGreaterThan(0);
      expect(Number(outcome.result?.text)).toBeGreaterThanOrEqual(landedAt);
    } finally {
      registry.disposeAll();
    }
  }, 20_000);

  it('abandons a browser call that never settles after blocking exactly one run', async () => {
    const tools = new Map<string, CollectedTool>();
    tools.set('browser_click', {
      name: 'browser_click',
      shape: { ref: z.string() },
      handler: () => new Promise<CallToolResult>(() => { /* never settles */ }),
    });
    const binding = resolveReplBrowser({ tools, profile: 'full' }, undefined);
    const session = makeSession();
    const first = await session.run('browser.click({ ref: "1" }); 1', 10_000, binding);
    expect(first.ok).toBe(true);
    const blocked = await session.run('2', 300, binding);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('was abandoned');
    const next = await session.run('3', 300, binding);
    expect(next.ok).toBe(true);
    expect(next.result?.text).toBe('3');
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
