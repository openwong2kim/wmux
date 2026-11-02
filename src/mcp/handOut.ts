// ─── hand_out — the To hand out list (src/shared/handOut.ts) ────────────────
//
// One tool for an agent's side of the list: `list` reads the open items, `add`
// puts one on it as the calling pane, and `pick` hands one to an agent. A pick
// sends through send_message's own path with the item's id on the
// a2a.task.send params, so main links the task to the item and refuses an item
// another pick already has. Main resolves the caller from the verified ptyId
// (same provenance as remote_spawn).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import { isErrorShapedResult } from '../shared/rpc';
import { buildHandOutMessage, handOutAddedByLine, type HandOutEntry, type HandOutItem } from '../shared/handOut';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** What a pick hands to send_message's path. */
export interface HandOutSendArgs {
  to: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface HandOutToolDeps {
  /** The verified (PID-walk) ptyId; never the env hint. */
  getSenderPtyId: () => string;
  /** Warms the walk that fills the ptyId (see fanout.ts). */
  resolveWorkspaceId?: () => Promise<string>;
  /** send_message's handler, with `handOutId` forwarded on a2a.task.send. */
  sendMessage: (args: HandOutSendArgs, opts: { handOutId: string }) => Promise<ToolResult>;
}

const SHAPE = {
  action: z.enum(['list', 'add', 'pick']),
  item_id: z.string().optional().describe('pick: an id from list'),
  to: z.string().optional().describe('pick: #pane name or workspace'),
  data: z.record(z.string(), z.unknown()).optional().describe('pick: as in send_message'),
  title: z.string().optional().describe('add: one line'),
  agent: z.string().optional().describe('add: e.g. claude'),
  note: z.string().optional().describe('add'),
  folder: z.string().optional().describe('add: default your cwd. list: only items in it'),
};

const json = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value ?? {}) }],
  ...(isError ? { isError: true as const } : {}),
});

const refusal = (text: string): ToolResult => ({ content: [{ type: 'text', text: `hand_out: ${text}` }], isError: true });

/** An item as an agent reads it, from list and add alike. */
function brief(item: HandOutItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    folder: item.folder,
    ...(item.agent ? { agent: item.agent } : {}),
    ...(item.note ? { note: item.note } : {}),
    addedBy: handOutAddedByLine(item.addedBy),
  };
}

function itemsOf(result: unknown): HandOutEntry[] {
  const items = (result as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as HandOutEntry[]) : [];
}

export function registerHandOutTools(server: McpServer, deps: HandOutToolDeps): void {
  server.tool(
    'hand_out',
    'The To hand out list, work nobody has yet: list, add, or pick one to send like send_message (its task is linked to the item).',
    SHAPE,
    async ({ action, item_id, to, data, title, agent, note, folder }) => {
      try {
        if (deps.resolveWorkspaceId) {
          try {
            await deps.resolveWorkspaceId();
          } catch {
            // An unresolvable caller is the handler's refusal to make.
          }
        }
        const pty = deps.getSenderPtyId();
        const caller: Record<string, unknown> = pty ? { senderPtyId: pty } : {};
        if (action === 'add') {
          if (!title) return refusal('add needs a title');
          const params: Record<string, unknown> = { ...caller, title, folder: folder ?? process.cwd() };
          if (agent) params['agent'] = agent;
          if (note) params['note'] = note;
          const result = await sendRpc('handOut.add', params);
          if (isErrorShapedResult(result)) return json(result, true);
          const item = (result as { item?: HandOutItem } | null)?.item;
          return json(item ? { ok: true, item: brief(item) } : result);
        }
        if (action === 'list') {
          const result = await sendRpc('handOut.list', folder ? { ...caller, folder } : caller);
          if (isErrorShapedResult(result)) return json(result, true);
          const items = itemsOf(result).map(brief);
          const total = (result as { total?: unknown } | null)?.total;
          const more = typeof total === 'number' ? total - items.length : 0;
          return json({ items, ...(more > 0 ? { more } : {}) });
        }
        if (!item_id || !to) return refusal('pick needs item_id and to');
        const read = await sendRpc('handOut.list', { ...caller, id: item_id });
        if (isErrorShapedResult(read)) return json(read, true);
        const item = itemsOf(read).find((i) => i.id === item_id);
        if (!item) return refusal(`no item ${item_id}; list shows the open ones`);
        if (item.state !== 'open') return refusal(`${item_id} is ${item.state}, not open`);
        return await deps.sendMessage(
          { to, title: item.title, message: buildHandOutMessage(item), ...(data ? { data } : {}) },
          { handOutId: item.id },
        );
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
