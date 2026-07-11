// Unit tests for ClaudeSdkAdapter (Command Deck P2b). The SDK `query` is
// injected as a fake async-iterable, so no subprocess spawns and no live model
// is hit; electron + the SDK module are mocked at import time.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/repo',
    getPath: () => '/home',
  },
}));

// The real SDK export is never called (queryFn is injected), but the top-level
// import must resolve — stub it.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import {
  ClaudeSdkAdapter,
  DEFAULT_ALLOWED_TOOLS,
  type SdkQueryHandle,
} from '../ClaudeSdkAdapter';
import type { RawSdkMessage } from '../BrainAdapter';
import type { BrainEvent } from '../BrainAdapter';

/** Build a fake query handle that yields the given frames and records interrupt. */
function fakeHandle(frames: RawSdkMessage[], onInterrupt?: () => void): SdkQueryHandle {
  return {
    async *[Symbol.asyncIterator]() {
      for (const f of frames) yield f;
    },
    interrupt: onInterrupt ? () => onInterrupt() : undefined,
  };
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('ClaudeSdkAdapter', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('streams normalized events for a turn and captures the session id', async () => {
    const frames: RawSdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-A' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-A' },
    ];
    const adapter = new ClaudeSdkAdapter({
      queryFn: () => fakeHandle(frames),
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ systemPrompt: 'SYS' });
    const events = await collect(adapter.send('do it'));
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'turn-end']);
    expect(adapter.sessionId).toBe('sess-A');
  });

  it('scrubs ANTHROPIC_API_KEY and passes resume on the second turn', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-be-dropped';
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { prompt: string; options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-B' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ systemPrompt: 'SYS', fleetContext: 'FLEET' });

    await collect(adapter.send('first'));
    const opts1 = calls[0].options;
    const env1 = opts1.env as Record<string, string | undefined>;
    expect('ANTHROPIC_API_KEY' in env1 && env1.ANTHROPIC_API_KEY !== undefined).toBe(false);
    // First turn has no resume; fleet context is prepended once.
    expect(opts1.resume).toBeUndefined();
    expect(calls[0].prompt).toContain('FLEET');
    expect(calls[0].prompt).toContain('first');
    // wmux MCP mounted + allow-list applied. The bundle is spawned with wmux's
    // OWN binary in Node mode (never a PATH `node` — end users may not have one),
    // and carries the per-spawn commander token (fleet-wide routing — codex P1).
    const mcpServers = opts1.mcpServers as {
      wmux: { type: string; command: string; args: string[]; env: Record<string, string> };
    };
    expect(mcpServers.wmux.type).toBe('stdio');
    expect(mcpServers.wmux.command).toBe(process.execPath);
    expect(mcpServers.wmux.args).toEqual(['/fake/mcp.js']);
    expect(mcpServers.wmux.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(mcpServers.wmux.env.WMUX_COMMANDER_TOKEN?.length).toBeGreaterThanOrEqual(64);
    expect(opts1.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);

    await collect(adapter.send('second'));
    expect(calls[1].options.resume).toBe('sess-B');
    // Fleet context injected once only.
    expect(calls[1].prompt).not.toContain('FLEET');
  });

  it('default allow-list omits the destructive close tools (P3 gate)', () => {
    expect(DEFAULT_ALLOWED_TOOLS).toContain('mcp__wmux__pane_split');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('mcp__wmux__pane_close');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('mcp__wmux__surface_close');
  });

  it('GLM profile injects the compatible base-url / auth-token', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 's' }]);
      },
      mcpBundlePath: null,
      profile: { baseUrl: 'https://glm.example', authToken: 'glm-tok' },
    });
    adapter.start({});
    await collect(adapter.send('x'));
    const env = calls[0].options.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://glm.example');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-tok');
    // No bundle → no MCP server mounted, no fleet tools.
    expect(calls[0].options.mcpServers).toBeUndefined();
    expect(adapter.hasFleetTools).toBe(false);
  });

  it('yields an error event when the query throws', async () => {
    const adapter = new ClaudeSdkAdapter({
      queryFn: () => {
        throw new Error('spawn failed');
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({});
    const events = await collect(adapter.send('x'));
    expect(events).toEqual([{ type: 'error', message: 'spawn failed' }]);
  });

  it('resumes on the FIRST turn from a persisted session id (P3a) and pins a stable cwd', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-live' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ systemPrompt: 'SYS', resumeSessionId: 'sess-disk' });
    const events = await collect(adapter.send('hello again'));
    expect(events.map((e) => e.type)).toEqual(['turn-end']);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.resume).toBe('sess-disk');
    // Session storage must not key on the (per-version) process cwd.
    expect(calls[0].options.cwd).toContain('.wmux');
    expect(adapter.sessionId).toBe('sess-live');
  });

  it('falls back to a fresh session when the seeded resume id is dead (error frame)', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return calls.length === 1
          ? fakeHandle([{ type: 'result', subtype: 'error_during_execution' }])
          : fakeHandle([
              { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh' }] } },
              { type: 'result', subtype: 'success', session_id: 'sess-new' },
            ]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-dead' });
    const events = await collect(adapter.send('go'));
    // The dead attempt's error is swallowed; only the fresh turn surfaces.
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'turn-end']);
    expect(calls).toHaveLength(2);
    expect(calls[0].options.resume).toBe('sess-dead');
    expect(calls[1].options.resume).toBeUndefined();
    expect(adapter.sessionId).toBe('sess-new');
  });

  it('falls back to a fresh session when the resumed spawn throws', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        if (calls.length === 1) throw new Error('no conversation with that id');
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-new' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-dead' });
    const events = await collect(adapter.send('go'));
    expect(events.map((e) => e.type)).toEqual(['turn-end']);
    expect(calls).toHaveLength(2);
    expect(adapter.sessionId).toBe('sess-new');
  });

  it('does NOT retry when the error arrives after content already streamed', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([
          { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
          { type: 'result', subtype: 'error_during_execution' },
        ]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-disk' });
    const events = await collect(adapter.send('go'));
    // A mid-turn failure is a REAL turn failure, not a dead resume id.
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'error']);
    expect(calls).toHaveLength(1);
  });

  it('validates the resumed id on FIRST streamed content — a later pre-content error keeps the session (codex P2)', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        if (calls.length === 1) {
          // Turn 1: streams REAL content, then dies before any turn-end —
          // the id is proven valid by the content alone.
          return fakeHandle([
            { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
            { type: 'result', subtype: 'error_during_execution' },
          ]);
        }
        // Turn 2: pre-content error. With the flag still set this would be
        // misread as a dead persisted id and the conversation dropped.
        return fakeHandle([{ type: 'result', subtype: 'error_during_execution' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-disk' });
    await collect(adapter.send('first'));
    expect(adapter.sessionId).toBe('sess-disk'); // kept after the mid-turn failure

    const events = await collect(adapter.send('second'));
    // Surfaces the error as-is: ONE attempt, no dead-id fallback, id retained.
    expect(events).toEqual([{ type: 'error', message: 'error_during_execution' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe('sess-disk');
    expect(adapter.sessionId).toBe('sess-disk');
  });

  it('does NOT retry once the resumed id was validated by a completed turn', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return calls.length === 1
          ? fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-disk' }])
          : fakeHandle([{ type: 'result', subtype: 'error_during_execution' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-disk' });
    await collect(adapter.send('first'));
    const events = await collect(adapter.send('second'));
    // The second turn's error surfaces as-is: one call per turn, no fallback.
    expect(events).toEqual([{ type: 'error', message: 'error_during_execution' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe('sess-disk');
  });

  it('interrupt() forwards to the active query handle', async () => {
    const onInterrupt = vi.fn();
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    const adapter = new ClaudeSdkAdapter({
      queryFn: () =>
        ({
          async *[Symbol.asyncIterator]() {
            await gate; // hold the turn open
            yield { type: 'result', subtype: 'success', session_id: 's' } as RawSdkMessage;
          },
          interrupt: onInterrupt,
        }) as SdkQueryHandle,
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({});
    const turn = collect(adapter.send('x'));
    // Let the iterator start and register the active handle.
    await Promise.resolve();
    adapter.interrupt();
    expect(onInterrupt).toHaveBeenCalled();
    released();
    await turn;
  });
});
