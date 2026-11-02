import { describe, expect, it, vi, beforeEach } from 'vitest';
// The SDK's subpath exports resolve under vitest but not under the import plugin.
// eslint-disable-next-line import/no-unresolved
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// eslint-disable-next-line import/no-unresolved
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});

import { registerHandOutTools } from '../handOut';
import { createWmuxServer } from '../index';
import { buildHandOutMessage, type HandOutEntry } from '../../shared/handOut';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ITEM: HandOutEntry = {
  id: 'ho-00000000-0000-4000-8000-000000000001',
  title: 'Fix the flaky login test',
  folder: '/repo/web',
  agent: 'claude',
  note: 'It fails on CI only.',
  addedBy: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-1', name: 'w1-2' },
  createdAt: 1,
  state: 'open',
};

let pty = '';
const warmed = vi.fn(async () => {
  // The walk that finds the caller fills the ptyId as a side effect.
  pty = 'pty-mine';
  return 'ws-a';
});
const sendMessage = vi.fn();
let tool: ToolHandler;
registerHandOutTools(
  { tool: (_n: string, _d: string, _s: unknown, h: ToolHandler) => { tool = h; } } as never,
  { getSenderPtyId: () => pty, resolveWorkspaceId: warmed, sendMessage },
);

beforeEach(() => {
  mockSendRpc.mockReset();
  sendMessage.mockReset();
  pty = '';
});

describe('hand_out list and add', () => {
  it('list forwards the folder and the caller, and answers each item compactly', async () => {
    mockSendRpc.mockResolvedValue({ items: [ITEM, { ...ITEM, id: 'ho-2', agent: undefined, note: undefined, addedBy: { kind: 'owner' } }], total: 5 });
    const res = await tool({ action: 'list', folder: '/repo' });
    expect(mockSendRpc).toHaveBeenCalledWith('handOut.list', { senderPtyId: 'pty-mine', folder: '/repo' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({
      items: [
        { id: ITEM.id, title: ITEM.title, folder: '/repo/web', agent: 'claude', note: 'It fails on CI only.', addedBy: '#w1-2' },
        { id: 'ho-2', title: ITEM.title, folder: '/repo/web', addedBy: 'the owner' },
      ],
      more: 3,
    });
    await tool({ action: 'list' });
    expect(mockSendRpc).toHaveBeenLastCalledWith('handOut.list', { senderPtyId: 'pty-mine' });
  });

  it('add defaults the folder to the working directory and sends the caller', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, item: ITEM });
    const res = await tool({ action: 'add', title: 'Write the docs' });
    expect(mockSendRpc).toHaveBeenCalledWith('handOut.add', { senderPtyId: 'pty-mine', title: 'Write the docs', folder: process.cwd() });
    expect(res.isError).toBeUndefined();
    // The added item reads as list shows it.
    expect(JSON.parse(res.content[0].text)).toEqual({
      ok: true,
      item: { id: ITEM.id, title: ITEM.title, folder: '/repo/web', agent: 'claude', note: 'It fails on CI only.', addedBy: '#w1-2' },
    });
    await tool({ action: 'add', title: 'Write the docs', folder: '/repo/api', agent: 'codex', note: 'the new routes' });
    expect(mockSendRpc).toHaveBeenLastCalledWith('handOut.add', {
      senderPtyId: 'pty-mine', title: 'Write the docs', folder: '/repo/api', agent: 'codex', note: 'the new routes',
    });
  });

  it('a refused add is an error result; an add with no title never calls main', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, code: 'full', message: 'the list is full' });
    const refused = await tool({ action: 'add', title: 'One more' });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text)).toEqual({ ok: false, code: 'full', message: 'the list is full' });
    mockSendRpc.mockReset();
    expect((await tool({ action: 'add' })).isError).toBe(true);
    expect(mockSendRpc).not.toHaveBeenCalled();
  });
});

describe('hand_out pick', () => {
  it('reads the item and sends its title, message and data with its id', async () => {
    mockSendRpc.mockResolvedValue({ items: [ITEM] });
    const sent = { content: [{ type: 'text' as const, text: '{"taskId":"t-1"}' }] };
    sendMessage.mockResolvedValue(sent);
    const res = await tool({ action: 'pick', item_id: ITEM.id, to: '#w1-3', data: { brief: 'b' } });
    expect(mockSendRpc).toHaveBeenCalledWith('handOut.list', { senderPtyId: 'pty-mine', id: ITEM.id });
    expect(sendMessage).toHaveBeenCalledWith(
      { to: '#w1-3', title: ITEM.title, message: buildHandOutMessage(ITEM), data: { brief: 'b' } },
      { handOutId: ITEM.id },
    );
    expect(res).toEqual(sent);
  });

  it('refuses an item that is not open, or not there, without sending', async () => {
    mockSendRpc.mockResolvedValue({ items: [{ ...ITEM, state: 'out', linkId: 'wl-1' }] });
    const out = await tool({ action: 'pick', item_id: ITEM.id, to: '#w1-3' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('is out');
    mockSendRpc.mockResolvedValue({ items: [] });
    expect((await tool({ action: 'pick', item_id: ITEM.id, to: '#w1-3' })).isError).toBe(true);
    mockSendRpc.mockResolvedValue({ error: 'handOut.list: refused' });
    expect((await tool({ action: 'pick', item_id: ITEM.id, to: '#w1-3' })).isError).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('needs item_id and to before it reads anything', async () => {
    expect((await tool({ action: 'pick', item_id: ITEM.id })).isError).toBe(true);
    expect((await tool({ action: 'pick', to: '#w1-3' })).isError).toBe(true);
    expect(mockSendRpc).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// Through the real server: the pick goes out on send_message's own path.
describe('hand_out pick on the send_message path', () => {
  async function connectClient() {
    const server = createWmuxServer({
      envWorkspaceHint: '',
      envPtyHint: '',
      commanderToken: undefined,
      commanderMode: false,
      coreMode: false,
      callerPid: process.pid,
      callerPpid: null,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  /** A verified identity walk, the item, and `send` as a2a.task.send's answer. */
  function answer(send: unknown): void {
    mockSendRpc.mockImplementation(async (m: string) => {
      if (m === 'a2a.resolve.identity') return { resolved: { workspaceId: 'ws-test', ptyId: 'pty-1' } };
      if (m === 'handOut.list') return { items: [ITEM] };
      if (m === 'a2a.task.send') return send;
      throw new Error(`rpc-down: ${m}`);
    });
  }

  const sendParams = () => mockSendRpc.mock.calls.find(([m]) => m === 'a2a.task.send')?.[1] as Record<string, unknown> | undefined;

  it('carries the item id, title, message and data on a2a.task.send', async () => {
    answer({ taskId: 't-1' });
    const client = await connectClient();
    try {
      const res = await client.callTool({ name: 'hand_out', arguments: { action: 'pick', item_id: ITEM.id, to: 'ws-other', data: { brief: 'b' } } }) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(mockSendRpc).toHaveBeenCalledWith('handOut.list', { senderPtyId: 'pty-1', id: ITEM.id });
      expect(sendParams()).toMatchObject({
        workspaceId: 'ws-test',
        to: 'ws-other',
        title: ITEM.title,
        message: buildHandOutMessage(ITEM),
        handOutId: ITEM.id,
        data: { brief: 'b' },
        senderPtyId: 'pty-1',
      });
    } finally {
      await client.close();
    }
  });

  it('answers a refused send (the item taken meanwhile) as the tool error', async () => {
    const refusal = { error: 'a2a.task.send: hand_out_taken: another pick has this item' };
    answer(refusal);
    const client = await connectClient();
    try {
      const res = await client.callTool({ name: 'hand_out', arguments: { action: 'pick', item_id: ITEM.id, to: 'ws-other' } }) as ToolResult;
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text)).toEqual(refusal);
    } finally {
      await client.close();
    }
  });

  it('send_message takes no item id from its caller', async () => {
    answer({ taskId: 't-1' });
    const client = await connectClient();
    try {
      await client.callTool({ name: 'send_message', arguments: { to: 'ws-other', message: 'hi', handOutId: ITEM.id } });
      expect(sendParams()).toBeDefined();
      expect(sendParams()).not.toHaveProperty('handOutId');
    } finally {
      await client.close();
    }
  });
});
