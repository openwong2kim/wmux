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
    // approval = high priority.
    expect(headers['Priority']).toBe('4');
  });

  it('honours the per-sink event filter', async () => {
    const h = harness([{ type: 'ntfy', url: 'https://ntfy.sh/t', events: ['approval'] }]);
    h.sink.notify(buildAttentionNotifyPayload({ sessionId: 'sess-1' }, IDENTITY));
    await h.sink.flush();
    expect(h.calls).toHaveLength(0);
  });

  it('drops the OLDEST notification when the queue is full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    const sink = new WebhookSink({
      sinks: () => [{ type: 'webhook', url: 'https://hooks.example/wmux' }],
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)).id);
        await gate;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });

    // The first send is held in-flight, so everything after it queues.
    const total = NOTIFY_QUEUE_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      sink.notify(buildAttentionNotifyPayload({ sessionId: 'sess-1' }, { id: `n${i}`, now: 0 }));
    }
    release();
    await sink.flush();

    // n0 went in flight immediately; the cap then evicted the oldest waiters.
    expect(calls[0]).toBe('n0');
    expect(calls).toHaveLength(NOTIFY_QUEUE_CAP + 1);
    expect(calls).not.toContain('n1');
    expect(calls[calls.length - 1]).toBe(`n${total - 1}`);
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
        { type: 'webhook', url: 'https://hooks.example/wmux', events: ['approval', 'bogus'] },
      ],
      warn,
    );
    expect(out).toEqual([
      { type: 'webhook', url: 'https://hooks.example/wmux', events: ['approval'] },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('accepts a private-range host — a self-hosted ntfy is the common case', () => {
    expect(isSendableUrl('http://192.168.1.10:8080/wmux')).toBe(true);
    expect(isSendableUrl('data:text/plain,hi')).toBe(false);
  });
});
