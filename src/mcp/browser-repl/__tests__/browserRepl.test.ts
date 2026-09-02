import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CollectedTool } from '../../playwright/toolCollector';
import {
  createConnectionScope,
  getConnectionScope,
  runInConnectionScope,
  type ConnectionScope,
} from '../../connectionScope';
import {
  BROWSER_REPL_TOOLS,
  createBrowserBridge,
  parseSnapshotRefs,
  shapeResult,
  summarizeArgs,
} from '../bridge';
import { BrowserReplSession } from '../BrowserReplSession';
import { formatBrowserReplOutcome } from '../tool';

function ok(text: string, extraBlocks: string[] = []): CallToolResult {
  return {
    content: [
      ...extraBlocks.map((t) => ({ type: 'text' as const, text: t })),
      { type: 'text' as const, text },
    ],
  };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

const SNAPSHOT_TEXT = [
  '[snapshot: full]',
  '- document "Home"',
  '  - link "Log in" ref="3"',
  '  - button "Search" focused ref="7"',
  '  - textbox "Email" ref="9" value="a@b"',
  '  - StaticText "no ref here"',
].join('\n');

const SMART_TEXT = [
  'Interactive elements (2):',
  '  [1] link "Log in"',
  '  [2] button "Search" - primary action',
  '',
  'Page text:',
  'Welcome',
].join('\n');

const SMART_DOM_TEXT = ['  [ref=4] a "Log in"', '  [ref=5] input[type=submit] "Go"'].join('\n');

interface Harness {
  tools: Map<string, CollectedTool>;
  calls: Array<{ name: string; args: Record<string, unknown>; scope: ConnectionScope | undefined }>;
}

function harness(overrides: Partial<Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>>> = {}): Harness {
  const calls: Harness['calls'] = [];
  const tools = new Map<string, CollectedTool>();
  const add = (
    short: string,
    shape: z.ZodRawShape,
    impl: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ) => {
    tools.set(`browser_${short}`, {
      name: `browser_${short}`,
      shape,
      handler: async (args) => {
        calls.push({ name: short, args, scope: getConnectionScope() });
        return (overrides[short] ?? impl)(args);
      },
    });
  };
  add('navigate', { url: z.string().url(), surfaceId: z.string().optional() }, async (a) => ok(`Navigated to ${String(a.url)}`));
  add('click', { ref: z.string().optional(), smartRef: z.number().optional(), surfaceId: z.string().optional() }, async (a) =>
    ok(`Clicked ${String(a.ref ?? a.smartRef)}`),
  );
  add('type', { ref: z.string(), text: z.string() }, async () => ok('Typed'));
  add('snapshot', { full: z.boolean().optional(), surfaceId: z.string().optional() }, async () => ok(SNAPSHOT_TEXT));
  add('smart_snapshot', { full: z.boolean().optional() }, async () => ok(SMART_TEXT));
  add('extract_text', { surfaceId: z.string().optional() }, async () => ok('Hello world'));
  add('wait', { ms: z.number().optional() }, async (a) => {
    await new Promise((r) => setTimeout(r, Number(a.ms ?? 0)));
    return ok('waited');
  });
  add('cookies', { action: z.string() }, async () => ok('cookies'));
  return { tools, calls };
}

const sessions: BrowserReplSession[] = [];
function newSession(): BrowserReplSession {
  const s = new BrowserReplSession(BROWSER_REPL_TOOLS);
  sessions.push(s);
  return s;
}
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});

describe('browser_repl bridge', () => {
  it('refuses tools outside the whitelist, naming the direct tool when it exists', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const cookies = await bridge('cookies', { action: 'get' });
    expect(cookies.ok).toBe(false);
    if (!cookies.ok) expect(cookies.error).toContain('call the browser_cookies tool directly');
    const bogus = await bridge('teleport', {});
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.error).toContain('not a browser tool');
    expect(h.calls).toHaveLength(0);
  });

  it('re-validates arguments with the tool schema before calling the handler', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const out = await bridge('navigate', { url: 'not a url' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/browser\.navigate: invalid arguments — url:/);
    expect(out.ledger).toContain('INVALID');
    expect(h.calls).toHaveLength(0);
  });

  it('injects the surfaceId default only where the schema accepts it and the call omits it', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, { surfaceId: 'surf-1' });
    await bridge('navigate', { url: 'https://example.com' });
    await bridge('navigate', { url: 'https://example.com', surfaceId: 'surf-2' });
    await bridge('type', { ref: '3', text: 'hi' });
    expect(h.calls.map((c) => c.args.surfaceId)).toEqual(['surf-1', 'surf-2', undefined]);
  });

  it('defaults snapshot tools to full:true and parses refs for both listing formats', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const snap = await bridge('snapshot', {});
    expect(h.calls[0].args.full).toBe(true);
    expect(snap.ok && snap.value.refs).toEqual([
      { ref: 3, param: 'ref', role: 'link', name: 'Log in' },
      { ref: 7, param: 'ref', role: 'button', name: 'Search' },
      { ref: 9, param: 'ref', role: 'textbox', name: 'Email' },
    ]);
    const smart = await bridge('smart_snapshot', { full: false });
    expect(h.calls[1].args.full).toBe(false);
    expect(smart.ok && smart.value.refs).toEqual([
      { ref: 1, param: 'smartRef', role: 'link', name: 'Log in' },
      { ref: 2, param: 'smartRef', role: 'button', name: 'Search' },
    ]);
    expect(parseSnapshotRefs(SMART_DOM_TEXT, 'smart_snapshot')).toEqual([
      { ref: 4, param: 'smartRef', role: 'a', name: 'Log in' },
      { ref: 5, param: 'smartRef', role: 'input', name: 'Go' },
    ]);
    expect(parseSnapshotRefs('garbage', 'snapshot')).toEqual([]);
  });

  it('splits lease event blocks into events, drops replay hints, keeps the body', () => {
    const shaped = shapeResult(
      ok('Navigated to https://x', [
        '[browser events]\n- navigated: https://x (2s ago)\n- dialog: closed (1s ago)\n',
        '[skill] login — 3 steps — browser_replay {action:"run", name:"login"}\n[replay] 1 recorded flow(s) for this page: login — x',
      ]),
      'navigate',
    );
    expect(shaped).toEqual({
      text: 'Navigated to https://x',
      events: ['navigated: https://x (2s ago)', 'dialog: closed (1s ago)'],
    });
    // An image block is noted, never handed to the script.
    const img = shapeResult({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }, 'click');
    expect(img.text).toBe('[image content omitted]');
  });

  it('turns an isError result into a failed outcome carrying the tool text, not the event block', async () => {
    const h = harness({
      click: async () => ({
        content: [
          { type: 'text', text: '[browser events]\n- navigated: x (1s ago)\n' },
          { type: 'text', text: 'ref=3 is stale' },
        ],
        isError: true,
      }),
    });
    const bridge = createBrowserBridge(h.tools, {});
    const out = await bridge('click', { ref: '3' });
    expect(out).toMatchObject({ ok: false, error: 'browser.click: ref=3 is stale' });
    expect(out.ledger).toMatch(/^click\(ref:"3"\) FAILED \d+ms$/);
  });

  it('re-enters the captured connection scope for every handler call', async () => {
    const h = harness();
    const scope = createConnectionScope();
    const bridge = createBrowserBridge(h.tools, { scope });
    await bridge('extract_text', {});
    expect(h.calls[0].scope).toBe(scope);
    // Without a captured scope, the handler runs in whatever is ambient.
    const ambient = createBrowserBridge(h.tools, {});
    await runInConnectionScope(scope, () => ambient('extract_text', {}));
    expect(h.calls[1].scope).toBe(scope);
  });

  it('never shows typed text in the ledger and masks password query params', () => {
    expect(summarizeArgs({ ref: '3', text: 'hunter2', value: 'x' })).toBe('ref:"3", text:"…(7)", value:"…(1)"');
    expect(summarizeArgs({ url: 'https://h/?password=abc' })).not.toContain('abc');
    // browser_fill nests the typed values one level down.
    const fill = summarizeArgs({ fields: [{ ref: '1', value: 'hunter2' }, { ref: '2', value: 'me@x' }] });
    expect(fill).toBe('fields:[{"ref":"1","value":"…(7)"},{"ref":"2","value":"…(4)"}]');
  });

  it('does not mistake page text for a lease block', () => {
    const decoy = '[browser events]\n- this is prose, not an event line';
    expect(shapeResult(ok(decoy), 'extract_text')).toEqual({ text: decoy, events: [] });
    // Hints only ever precede the body; the same prefix inside the body stays body.
    const shaped = shapeResult(
      { content: [{ type: 'text', text: 'Body' }, { type: 'text', text: '[replay] literal in page' }] },
      'extract_text',
    );
    expect(shaped.text).toBe('Body\n[replay] literal in page');
  });
});

describe('browser_repl session', () => {
  it('folds several browser steps into one run and keeps a ledger', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    const out = await session.run(
      [
        'const snap = await browser.snapshot();',
        'const login = snap.refs.find((r) => r.name === "Log in");',
        'await browser.click({ [login.param]: String(login.ref) });',
        'console.log("clicked", login.ref);',
        'const t = await browser.extract_text();',
        't.text',
      ].join('\n'),
      10_000,
      bridge,
    );
    expect(out.ok).toBe(true);
    expect(out.result?.text).toBe('Hello world');
    expect(out.console.text).toBe('clicked 3\n');
    expect(out.ledger).toHaveLength(3);
    expect(out.ledger[0]).toMatch(/^snapshot\(full:true\) ok \d+ms$/);
    expect(out.ledger[1]).toMatch(/^click\(ref:"3"\) ok/);
    expect(h.calls.map((c) => c.name)).toEqual(['snapshot', 'click', 'extract_text']);
    expect(out.freshRuntime).toBe(true);
  });

  it('throws into the script on a failed step, so later steps do not run — unless caught', async () => {
    const h = harness({ click: async () => fail('nothing at ref=3') });
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    const out = await session.run('await browser.click({ ref: "3" }); await browser.extract_text(); 1', 10_000, bridge);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('BrowserToolError: browser.click: nothing at ref=3');
    expect(h.calls.map((c) => c.name)).toEqual(['click']);
    expect(out.ledger[0]).toContain('FAILED');

    const caught = await session.run(
      'let msg;\ntry { await browser.click({ ref: "3" }) } catch (e) { msg = e.name + ":" + e.tool }\nmsg',
      10_000,
      bridge,
    );
    expect(caught.ok).toBe(true);
    expect(caught.result?.text).toBe('BrowserToolError:click');
  });

  it('exposes only whitelisted tools on the browser object', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    const out = await session.run('typeof browser.cookies + " " + typeof browser.evaluate + " " + typeof browser.click', 10_000, bridge);
    expect(out.result?.text).toBe('undefined undefined function');
  });

  it('keeps top-level state between runs', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    await session.run('let counter = 41;', 10_000, bridge);
    const out = await session.run('counter += 1; counter', 10_000, bridge);
    expect(out.ok).toBe(true);
    expect(out.result?.text).toBe('42');
    expect(out.freshRuntime).toBe(false);
  });

  it('terminates a synchronous infinite loop on timeout and starts fresh next run', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    await session.run('let survivor = 1;', 10_000, bridge);
    const out = await session.run('while (true) {}', 300, bridge);
    expect(out.ok).toBe(false);
    expect(out.timedOut).toBe(true);
    expect(out.error).toContain('300ms timeout');

    const next = await session.run('typeof survivor', 10_000, bridge);
    expect(next.freshRuntime).toBe(true);
    expect(next.previousDeath).toContain('300ms timeout');
    expect(next.result?.text).toBe('undefined');
    const rendered = formatBrowserReplOutcome(next);
    expect(rendered).toContain('the previous runtime is gone');
  }, 15_000);

  it('serializes concurrent runs on one connection', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    const a = session.run('await browser.wait({ ms: 150 }); await browser.click({ ref: "a" }); "a"', 10_000, bridge);
    const b = session.run('await browser.click({ ref: "b" }); "b"', 10_000, bridge);
    const [outA, outB] = await Promise.all([a, b]);
    expect(outA.result?.text).toBe('a');
    expect(outB.result?.text).toBe('b');
    expect(h.calls.map((c) => `${c.name}:${String(c.args.ref ?? '')}`)).toEqual(['wait:', 'click:a', 'click:b']);
    expect(outA.ledger).toHaveLength(2);
    expect(outB.ledger).toHaveLength(1);
  });

  it('rejects malformed calls inside the worker without reaching the bridge', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    const out = await session.run('await browser.click([1])', 10_000, bridge);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('args must be a plain object');
    expect(h.calls).toHaveLength(0);
  });

  it('captures background console output and rejects runs after dispose', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    const out = await session.run('console.warn("w", { a: 1 }); await sleep(5); 7', 10_000, bridge);
    expect(out.console.text).toBe('w { a: 1 }\n');
    expect(out.result?.text).toBe('7');
    session.dispose();
    await expect(session.run('1', 1000, bridge)).rejects.toThrow('disposed');
  });

  it('refuses browser calls that arrive after their run finished', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    // The un-awaited call fires after this run has reported back.
    await session.run(
      'globalThis.late = new Promise((r) => setTimeout(() => browser.click({ ref: "x" }).then(() => r("ran"), (e) => r(e.message)), 20)); 0',
      10_000,
      bridge,
    );
    await new Promise((r) => setTimeout(r, 80));
    const out = await session.run('await globalThis.late', 10_000, bridge);
    expect(out.result?.text).toContain('called after its browser_repl run finished');
    expect(h.calls).toHaveLength(0);
  });

  it('lets a killed run\'s in-flight handler land before the next run touches the page', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    const out = await session.run('await browser.wait({ ms: 400 }); await browser.click({ ref: "dead" });', 100, bridge);
    expect(out.timedOut).toBe(true);
    const next = await session.run('await browser.click({ ref: "next" }); 1', 10_000, bridge);
    expect(next.ok).toBe(true);
    // wait finished (and its late click never happened: the worker is gone), then the new run's click.
    expect(h.calls.map((c) => `${c.name}:${String(c.args.ref ?? '')}`)).toEqual(['wait:', 'click:next']);
  });

  it('answers a bridge rejection as a tool error instead of hanging the script', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const broken = async (name: string, args: Record<string, unknown>) => {
      if (name === 'click') throw new Error('bridge exploded');
      return bridge(name, args);
    };
    const session = newSession();
    const out = await session.run('let why;\ntry { await browser.click({ ref: "1" }) } catch (e) { why = e.message }\nwhy', 10_000, broken);
    expect(out.ok).toBe(true);
    expect(out.result?.text).toContain('bridge failure: bridge exploded');
    expect(out.ledger[0]).toBe('click(…) THREW bridge exploded');
  });

  it('caps the ledger and says how many calls were elided', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    const out = await session.run('for (let i = 0; i < 205; i++) await browser.extract_text(); 1', 10_000, bridge);
    expect(out.ok).toBe(true);
    expect(out.ledger).toHaveLength(200);
    expect(out.callCount).toBe(205);
    const rendered = formatBrowserReplOutcome(out);
    expect(rendered).toContain('205 browser call(s)');
    expect(rendered).toContain('(5 more call(s) not shown)');
  });

  it('does not wait past its own deadline for a killed run\'s handler that never settles', async () => {
    const h = harness({ wait: () => new Promise(() => { /* never settles */ }) });
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    const dead = await session.run('await browser.wait({ ms: 1 });', 100, bridge);
    expect(dead.timedOut).toBe(true);
    const started = Date.now();
    const next = await session.run('1', 200, bridge);
    expect(next.ok).toBe(false);
    expect(next.error).toContain('still running after 200ms');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('explains a redeclared top-level binding instead of a bare SyntaxError', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    await session.run('let twice = 1;', 10_000, bridge);
    const out = await session.run('let twice = 2;', 10_000, bridge);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('has already been declared');
    expect(out.error).toContain('assign to globalThis');
  });

  it('recovers from a worker that died between runs', async () => {
    const h = harness();
    const bridge = createBrowserBridge(h.tools, {});
    const session = newSession();
    await session.run('setTimeout(() => process.exit(3), 10); 1', 10_000, bridge);
    await new Promise((r) => setTimeout(r, 150));
    const out = await session.run('1', 10_000, bridge);
    expect(out.ok).toBe(true);
    expect(out.freshRuntime).toBe(true);
    expect(out.previousDeath).toContain('between runs');
  });
});

describe('formatBrowserReplOutcome', () => {
  it('renders the header, calls, console, and result blocks', () => {
    const text = formatBrowserReplOutcome({
      ok: true,
      elapsedMs: 12,
      ledger: ['snapshot(full:true) ok 5ms', 'click(ref:"3") ok 4ms · 1 event(s)'],
      callCount: 2,
      console: { text: 'hi\n', truncated: false, totalBytes: 3, elidedBytes: 0 },
      result: { text: "'done'", truncated: false, totalBytes: 6, elidedBytes: 0 },
      timedOut: false,
      freshRuntime: true,
    });
    expect(text).toBe(
      [
        'browser_repl · ok · 12ms · 2 browser call(s)',
        'note: started a new runtime',
        '',
        '--- calls ---',
        '1. snapshot(full:true) ok 5ms',
        '2. click(ref:"3") ok 4ms · 1 event(s)',
        '',
        '--- console ---',
        'hi',
        '',
        '--- result ---',
        "'done'",
      ].join('\n'),
    );
  });
});
