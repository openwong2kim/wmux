import { describe, expect, it, vi } from 'vitest';
import type { ApprovalPromptInfo, ApprovalResult } from '../../mcp/ApprovalQueue';
import {
  borrowPromptTitle,
  createBorrowApprovalRequester,
} from '../liveBorrowApproval';
import {
  BORROW_APPROVAL_DEADLINE_MS,
  BORROW_RPC_TIMEOUT_MS,
} from '../../../shared/liveWriteScope';

// Asking the human to lend a live Chrome tab. Every path that is not an explicit
// approve must come back a refusal, and the three refusals have to stay tellable
// apart: the agent's next move differs for "they said no" and "nobody looked".

interface FakeQueue {
  requestConsent: ReturnType<typeof vi.fn> & ((input: {
    clientName: string;
    title: string;
    deadlineAt?: number;
  }) => { promptId: string; resolution: Promise<ApprovalResult> });
  cancelPrompt: ReturnType<typeof vi.fn> & ((promptId: string, reason: string) => void);
  opened: ApprovalPromptInfo[];
  /** Answer the prompt that is open, as the user clicking Approve/Deny. */
  resolveWith: (approved: boolean) => void;
}

function fakeQueue(options: { throwOnOpen?: boolean } = {}): FakeQueue {
  const opened: ApprovalPromptInfo[] = [];
  let resolver: ((r: ApprovalResult) => void) | null = null;
  let rejecter: ((e: Error) => void) | null = null;
  const queue: FakeQueue = {
    opened,
    requestConsent: vi.fn((input: { clientName: string; title: string; deadlineAt?: number }) => {
      if (options.throwOnOpen) throw new Error('renderer gone');
      opened.push({
        promptId: 'p1',
        clientName: input.clientName,
        declaredCapabilities: [],
        kind: 'browser-borrow',
        title: input.title,
        ...(input.deadlineAt !== undefined && { deadlineAt: input.deadlineAt }),
      });
      return {
        promptId: 'p1',
        resolution: new Promise<ApprovalResult>((resolve, reject) => {
          resolver = resolve;
          rejecter = reject;
        }),
      };
    }),
    cancelPrompt: vi.fn((_promptId: string, reason: string) => {
      rejecter?.(new Error(`Approval prompt cancelled: ${reason}`));
    }),
    resolveWith: (approved) => resolver?.({ approved, promptId: 'p1', identity: undefined }),
  };
  return queue;
}

const REQUEST = {
  workspaceId: 'ws-1',
  surfaceId: 'tab-9',
  title: 'Inbox (12)',
  origin: 'https://mail.example.com',
};

describe('borrowPromptTitle', () => {
  it('names the workspace, the tab and its origin', () => {
    expect(borrowPromptTitle('Docs', REQUEST)).toBe(
      'Agent in workspace Docs wants to control tab "Inbox (12)" (https://mail.example.com)',
    );
  });

  it('survives a tab with no title and no origin', () => {
    // about:blank has neither; the prompt still has to be answerable.
    expect(borrowPromptTitle('Docs', { title: '   ', origin: '' })).toBe(
      'Agent in workspace Docs wants to control tab "untitled"',
    );
  });
});

describe('the two deadlines', () => {
  it('the RPC deadline outlives the prompt one, so the transport never gives up first', () => {
    // They used to be independent: sendRpc's 10 s default against a 60 s prompt,
    // which capped the human's answer at ten seconds and reported a question
    // still on screen as "temporarily unavailable".
    expect(BORROW_RPC_TIMEOUT_MS).toBeGreaterThan(BORROW_APPROVAL_DEADLINE_MS);
  });
});

describe('createBorrowApprovalRequester', () => {
  it('approve → approved, and the prompt says which workspace and tab', async () => {
    const queue = fakeQueue();
    const ask = createBorrowApprovalRequester({
      queue: queue as never,
      workspaceName: () => 'Docs',
      deadlineMs: 1000,
    });

    const pending = ask(REQUEST);
    queue.resolveWith(true);

    expect(await pending).toBe('approved');
    expect(queue.opened[0]).toMatchObject({
      kind: 'browser-borrow',
      clientName: 'Docs',
      title: 'Agent in workspace Docs wants to control tab "Inbox (12)" (https://mail.example.com)',
    });
    // The deadline rides with the info so the Fleet inbox row shows a countdown
    // without any new UI.
    expect(typeof queue.opened[0].deadlineAt).toBe('number');
    expect(queue.requestConsent).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'ws-1::tab-9' }),
    );
  });

  it('deny → denied', async () => {
    const queue = fakeQueue();
    const ask = createBorrowApprovalRequester({
      queue: queue as never,
      workspaceName: () => 'Docs',
      deadlineMs: 1000,
    });

    const pending = ask(REQUEST);
    queue.resolveWith(false);

    expect(await pending).toBe('denied');
  });

  it('nobody answers → timeout, and the row is taken off screen', async () => {
    vi.useFakeTimers();
    try {
      const queue = fakeQueue();
      const ask = createBorrowApprovalRequester({
        queue: queue as never,
        workspaceName: () => 'Docs',
        deadlineMs: 60_000,
      });

      const pending = ask(REQUEST);
      await vi.advanceTimersByTimeAsync(60_000);

      // A timeout is a DENY that says so: the agent can tell "they refused" from
      // "they were not at the keyboard", and neither is a grant.
      expect(await pending).toBe('timeout');
      expect(queue.cancelPrompt).toHaveBeenCalledWith('p1', 'borrow request expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancelled prompt (renderer torn down) → denied, never approved', async () => {
    const queue = fakeQueue();
    const ask = createBorrowApprovalRequester({
      queue: queue as never,
      workspaceName: () => 'Docs',
      deadlineMs: 1000,
    });

    const pending = ask(REQUEST);
    queue.cancelPrompt('p1', 'client disconnected');

    expect(await pending).toBe('denied');
  });

  it('a queue that cannot open the prompt → denied (nobody was asked)', async () => {
    const queue = fakeQueue({ throwOnOpen: true });
    const ask = createBorrowApprovalRequester({
      queue: queue as never,
      workspaceName: () => 'Docs',
      deadlineMs: 1000,
    });

    expect(await ask(REQUEST)).toBe('denied');
  });

  it('falls back to the workspace id when the mirror has no name yet', async () => {
    const queue = fakeQueue();
    const ask = createBorrowApprovalRequester({
      queue: queue as never,
      workspaceName: () => '',
      deadlineMs: 1000,
    });

    const pending = ask(REQUEST);
    queue.resolveWith(true);
    await pending;

    expect(queue.opened[0].clientName).toBe('ws-1');
  });
});
