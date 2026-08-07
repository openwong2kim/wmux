import { describe, it, expect, vi } from 'vitest';

import {
  WebhookSink,
  coerceNotifySinks,
  isSendableUrl,
  NOTIFY_QUEUE_CAP,
  type NotifySinkConfig,
} from '../WebhookSink';
import {
  NOTIFY_PAYLOAD_FIELDS,
  buildApprovalNotifyPayload,
  buildAttentionNotifyPayload,
  type NotifyPayload,
} from '../notifyPayload';
import { buildApprovalPushPayload } from '../approvalPushPayload';
import { PUSH_RISK_CRITICAL } from '../../../shared/push/pushEnvelope';
import type { ApprovalRequest } from '../../approvals/types';

const IDENTITY = { id: 'evt-1', now: Date.UTC(2026, 0, 2, 3, 4, 5) };

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionId: '11111111-2222-3333-4444-555555555555',
    workspaceId: '99999999-8888-7777-6666-555555555555',
    agent: 'claude',
    kind: 'awaiting_input',
    question: 'Delete /Users/someone/secret-project/.env and drop table users?',
    options: ['Yes, rm -rf it', 'No'],
    choices: [
      { key: '1', label: 'Yes, rm -rf it' },
      { key: '2', label: 'No' },
    ],
    createdAt: IDENTITY.now,
    state: 'pending',
    ...over,
  };
}

interface Harness {
  sink: WebhookSink;
  calls: Array<{ url: string; init: RequestInit }>;
  logs: string[];
}

function harness(sinks: NotifySinkConfig[], status = 200): Harness {
  const calls: Harness['calls'] = [];
  const logs: string[] = [];
  const sink = new WebhookSink({
    sinks: () => sinks,
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status });
    }) as unknown as typeof fetch,
  });
  return { sink, calls, logs };
}

/**
 * A sink whose first send hangs until `release()`, so everything after it is
 * observably sitting in the queue. `calls` is the payload ids, in send order.
 */
function holdingSink(): { sink: WebhookSink; calls: string[]; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: string[] = [];
  let first = true;
  const sink = new WebhookSink({
    sinks: () => [{ type: 'webhook', url: 'https://hooks.example/wmux' }],
    fetchImpl: (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)).id);
      if (first) {
        first = false;
        await gate;
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { sink, calls, release };
}

describe('notifyPayload — the outbound allowlist', () => {
  it('never emits a field outside NOTIFY_PAYLOAD_FIELDS', () => {
    const payloads: NotifyPayload[] = [
      buildApprovalNotifyPayload(approval(), IDENTITY),
      buildApprovalNotifyPayload(
        approval({
          kind: 'awaiting_permission',
          question: undefined,
          options: undefined,
          choices: undefined,
          toolName: 'Bash',
          toolInputSummary: 'rm -rf /Users/someone/project',
        }),
        IDENTITY,
      ),
      buildAttentionNotifyPayload({ sessionId: 'abcdefgh-ijkl', agent: 'Claude Code' }, IDENTITY),
    ];
    for (const payload of payloads) {
      for (const key of Object.keys(payload)) {
        expect(NOTIFY_PAYLOAD_FIELDS).toContain(key);
      }
    }
  });

  it('carries no agent-authored text, no paths and no full ids', () => {
    const request = approval();
    const serialized = JSON.stringify(buildApprovalNotifyPayload(request, IDENTITY));
    // The question, the choice labels and the file path in them.
    expect(serialized).not.toContain('Delete');
    expect(serialized).not.toContain('rm -rf');
    expect(serialized).not.toContain('.env');
    expect(serialized).not.toContain('drop table');
    // The approval id resolves a pane over RPC — it must not travel at all.
    expect(serialized).not.toContain(request.id);
    // Pane / workspace ids travel only as a short prefix.
    expect(serialized).not.toContain(request.sessionId);
    expect(serialized).not.toContain(request.workspaceId);
    expect(JSON.parse(serialized).pane).toBe('11111111');
  });

  it('re-derives the risk tier from the agent text without shipping the text', () => {
    // `risk` is unset on the record: a copy would score this as ordinary.
    expect(buildApprovalNotifyPayload(approval(), IDENTITY).risk).toBe('critical');
    expect(
      buildApprovalNotifyPayload(
        approval({ question: 'Which colour should the button be?', options: ['Blue', 'Green'], choices: undefined }),
        IDENTITY,
      ).risk,
    ).toBeUndefined();
  });

  it('agrees with the sealed push payload on danger, input for input', () => {
    // The two paths must never disagree about what counts as destructive: one
    // decides a lock-screen approve button, the other how loudly a phone rings.
    // They call the same helper, and this is the test that keeps it that way.
    const cases: ApprovalRequest[] = [
      approval(),
      approval({ question: 'Which colour should the button be?', options: ['Blue'], choices: undefined }),
      approval({ risk: 'critical', question: 'Proceed?', options: undefined, choices: undefined }),
      approval({ question: 'Pick one', options: ['Keep it', 'DROP TABLE users'], choices: undefined }),
      approval({
        kind: 'awaiting_permission',
        question: undefined,
        options: undefined,
        choices: undefined,
        toolName: 'Bash',
        toolInputSummary: 'rm -rf /tmp/build',
      }),
      approval({
        kind: 'awaiting_permission',
        question: undefined,
        options: undefined,
        choices: undefined,
        toolName: 'Read',
        toolInputSummary: 'package.json',
      }),
    ];
    for (const request of cases) {
      const pushSaysCritical = buildApprovalPushPayload(request).risk === PUSH_RISK_CRITICAL;
      const webhookSaysCritical = buildApprovalNotifyPayload(request, IDENTITY).risk === 'critical';
      expect(webhookSaysCritical).toBe(pushSaysCritical);
    }
  });
});

describe('WebhookSink', () => {
  it('is inert with no sinks configured', () => {
    const h = harness([]);
    expect(h.sink.enabled).toBe(false);
    h.sink.notify(buildApprovalNotifyPayload(approval(), IDENTITY));
    expect(h.calls).toHaveLength(0);
  });

  it('posts JSON to a webhook and text+headers to ntfy', async () => {
    const h = harness([
      { type: 'webhook', url: 'https://hooks.example/wmux' },
      { type: 'ntfy', url: 'https://ntfy.sh/my-topic' },
    ]);
    h.sink.notify(buildApprovalNotifyPayload(approval(), IDENTITY));
    await h.sink.flush();

    expect(h.calls).toHaveLength(2);
    const [hook, ntfy] = h.calls;
    expect(JSON.parse(String(hook.init.body)).event).toBe('approval');
    expect(String(ntfy.init.body)).toBe('Approval needed · claude · pane 11111111 · ws 99999999');
    const headers = ntfy.init.headers as Record<string, string>;
    expect(headers['Title']).toBe('Approval needed');
  });

  it('maps risk onto the ntfy Priority header', async () => {
    const priorities: string[] = [];
    const h = harness([{ type: 'ntfy', url: 'https://ntfy.sh/t' }]);
    const calm = approval({
      question: 'Which colour should the button be?',
      options: ['Blue', 'Green'],
      choices: undefined,
    });
    // critical approval → max, ordinary approval → high, attention → default.
    h.sink.notify(buildApprovalNotifyPayload(approval(), IDENTITY));
    h.sink.notify(buildApprovalNotifyPayload(calm, IDENTITY));
    h.sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, IDENTITY));
    await h.sink.flush();
    for (const call of h.calls) {
      priorities.push((call.init.headers as Record<string, string>)['Priority']);
    }
    expect(priorities).toEqual(['5', '4', '3']);
  });

  it('releases the response body instead of leaking the socket', async () => {
    const cancel = vi.fn(async () => undefined);
    const sink = new WebhookSink({
      sinks: () => [{ type: 'webhook', url: 'https://hooks.example/wmux' }],
      fetchImpl: (async () =>
        ({ status: 200, bodyUsed: false, body: { cancel } }) as unknown as Response) as unknown as typeof fetch,
    });
    sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, IDENTITY));
    await sink.flush();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('warns once per http:// sink that the notification travels cleartext', async () => {
    const h = harness([{ type: 'ntfy', url: 'http://192.168.1.10/wmux' }]);
    for (let i = 0; i < 3; i += 1) {
      h.sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, { id: `n${i}`, now: 0 }));
    }
    await h.sink.flush();
    const cleartext = h.logs.filter((l) => l.includes('cleartext'));
    expect(cleartext).toHaveLength(1);
    // The warning must not itself leak the url it is warning about.
    expect(cleartext[0]).not.toContain('192.168.1.10');
    // Still delivered — http stays allowed.
    expect(h.calls).toHaveLength(3);
  });

  it('honours the per-sink event filter', async () => {
    const h = harness([{ type: 'ntfy', url: 'https://ntfy.sh/t', events: ['approval'] }]);
    h.sink.notify(buildAttentionNotifyPayload({ sessionId: 'sess-1' }, IDENTITY));
    await h.sink.flush();
    expect(h.calls).toHaveLength(0);
  });

  it('drops the OLDEST notification of its own kind when the queue is full', async () => {
    const held = holdingSink();

    // The first send is held in-flight, so everything after it queues.
    const total = NOTIFY_QUEUE_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      held.sink.notify(buildAttentionNotifyPayload({ sessionId: 'sess-1' }, { id: `n${i}`, now: 0 }));
    }
    held.release();
    await held.sink.flush();

    // n0 went in flight immediately; the cap then evicted the oldest waiters.
    expect(held.calls[0]).toBe('n0');
    expect(held.calls).toHaveLength(NOTIFY_QUEUE_CAP + 1);
    expect(held.calls).not.toContain('n1');
    expect(held.calls[held.calls.length - 1]).toBe(`n${total - 1}`);
  });

  it('never lets an attention flood evict a queued approval', async () => {
    const held = holdingSink();

    // One approval, then far more attention events than the whole queue holds.
    // A single shared FIFO with drop-oldest would evict the approval first —
    // it is the oldest entry, and it is the only one anybody is blocked on.
    held.sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, { id: 'head', now: 0 }));
    held.sink.notify(buildApprovalNotifyPayload(approval(), { id: 'the-approval', now: 0 }));
    for (let i = 0; i < NOTIFY_QUEUE_CAP * 3; i += 1) {
      held.sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, { id: `flood${i}`, now: 0 }));
    }
    held.release();
    await held.sink.flush();

    expect(held.calls).toContain('the-approval');
    // And it goes out FIRST — ahead of the attention backlog it was queued behind.
    expect(held.calls[1]).toBe('the-approval');
    // The flood only ever evicted its own kind.
    expect(held.calls.filter((id) => id.startsWith('flood'))).toHaveLength(NOTIFY_QUEUE_CAP);
  });

  it('fans out to sinks in parallel, so one dead sink cannot stall the others', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started: string[] = [];
    const sink = new WebhookSink({
      sinks: () => [
        { type: 'webhook', url: 'https://slow.example/a' },
        { type: 'webhook', url: 'https://fast.example/b' },
        { type: 'webhook', url: 'https://fast.example/c' },
      ],
      fetchImpl: (async (url: string) => {
        started.push(String(url));
        // The first sink black-holes the request until we let it go. Serially,
        // b and c would not even be attempted until it did.
        if (String(url).includes('slow')) await gate;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });

    sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, IDENTITY));
    // Let the microtasks settle while the slow sink is still hanging.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toHaveLength(3);

    release();
    await sink.flush();
  });

  it('delivers a notification raised at ANY point while a drain is finishing', async () => {
    // The bug this guards is a one-microtask window: `runDrain` returns when it
    // finds the queues empty, but `drainPromise` is only cleared a microtask
    // later. A notify() landing in between sees a non-null drainPromise, joins
    // the drain that is already on its way out, and is stranded until some
    // unrelated event starts another one.
    //
    // The window is a single hop, and which hop it is depends on how many awaits
    // sit between the fetch resolving and the drain returning. So rather than
    // guess, sweep the delay across the whole range — one of these lands in the
    // window, and without the restart in `drain`'s finally that one strands.
    for (let hops = 0; hops < 12; hops += 1) {
      const calls: string[] = [];
      const sink: WebhookSink = new WebhookSink({
        sinks: () => [{ type: 'webhook', url: 'https://hooks.example/wmux' }],
        fetchImpl: (async (_url: string, init: RequestInit) => {
          const id = JSON.parse(String(init.body)).id as string;
          calls.push(id);
          if (id === 'first') {
            let chain = Promise.resolve();
            for (let i = 0; i < hops; i += 1) chain = chain.then(() => undefined);
            void chain.then(() => {
              sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, { id: 'second', now: 0 }));
            });
          }
          return new Response(null, { status: 200 });
        }) as unknown as typeof fetch,
      });

      sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, { id: 'first', now: 0 }));
      // Deliberately NOT `flush()`. Flush loops until quiescent, so it would
      // itself restart a stranded drain and hide exactly the bug under test.
      // Production has no such prompt: the sink must recover on its own.
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
      expect(calls, `stranded when the notify landed ${hops} microtask(s) in`).toEqual([
        'first',
        'second',
      ]);
    }
  });

  it('logs a failing sink once, not once per notification', async () => {
    const h = harness([{ type: 'ntfy', url: 'https://ntfy.sh/t' }], 500);
    for (let i = 0; i < 3; i += 1) {
      h.sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, { id: `n${i}`, now: 0 }));
    }
    await h.sink.flush();
    expect(h.calls).toHaveLength(3);
    expect(h.logs.filter((l) => l.includes('answered 500'))).toHaveLength(1);
  });

  it('never logs the sink url — an ntfy topic is a secret', async () => {
    const h = harness([{ type: 'ntfy', url: 'https://ntfy.sh/secret-topic-name' }], 500);
    h.sink.notify(buildAttentionNotifyPayload({ sessionId: 's' }, IDENTITY));
    await h.sink.flush();
    expect(h.logs.join('\n')).not.toContain('secret-topic-name');
  });
});

describe('coerceNotifySinks', () => {
  it('degrades an absent or malformed slice to OFF', () => {
    expect(coerceNotifySinks(undefined)).toEqual([]);
    expect(coerceNotifySinks('nope')).toEqual([]);
    expect(coerceNotifySinks([null, 42, {}, { type: 'smoke-signal', url: 'https://x.example' }])).toEqual([]);
  });

  it('rejects non-http(s) schemes and keeps the valid siblings', () => {
    const warn = vi.fn();
    const out = coerceNotifySinks(
      [
        { type: 'webhook', url: 'file:///etc/passwd' },
        { type: 'ntfy', url: 'not a url' },
        { type: 'webhook', url: 'https://hooks.example/wmux', events: ['approval'] },
      ],
      warn,
    );
    expect(out).toEqual([
      { type: 'webhook', url: 'https://hooks.example/wmux', events: ['approval'] },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns about an unrecognised event name instead of silently dropping it', () => {
    const warn = vi.fn();
    // A typo here is the worst kind of bug: the sink loads fine and never fires.
    const out = coerceNotifySinks(
      [{ type: 'ntfy', url: 'https://ntfy.sh/t', events: ['aproval'] }],
      warn,
    );
    expect(out).toEqual([{ type: 'ntfy', url: 'https://ntfy.sh/t', events: [] }]);
    const said = warn.mock.calls.map((c) => String(c[1])).join('\n');
    expect(said).toContain('aproval');
    // Both the unknown name AND the resulting permanent silence are called out.
    expect(said).toContain('never fire');
  });

  it('accepts a private-range host — a self-hosted ntfy is the common case', () => {
    expect(isSendableUrl('http://192.168.1.10:8080/wmux')).toBe(true);
    expect(isSendableUrl('data:text/plain,hi')).toBe(false);
  });
});
