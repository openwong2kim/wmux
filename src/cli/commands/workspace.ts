import { sendRequest } from '../client';
import { printResult, ensureOk, parseFlag } from '../utils';
import type { RpcResponse } from '../../shared/rpc';
import { ENV_KEYS } from '../../shared/constants';

interface WorkspaceInfo {
  id: string;
  name: string;
  isActive?: boolean;
}

function formatWorkspaceList(result: unknown): void {
  const list = result as WorkspaceInfo[];
  if (!Array.isArray(list) || list.length === 0) {
    console.log('No workspaces found.');
    return;
  }
  const maxId = Math.max(...list.map((w) => w.id.length));
  console.log(
    'ID'.padEnd(maxId + 2) + 'NAME' + '    ' + 'STATUS'
  );
  console.log('-'.repeat(maxId + 30));
  for (const ws of list) {
    const active = ws.isActive ? ' (active)' : '';
    console.log(ws.id.padEnd(maxId + 2) + ws.name + active);
  }
}

function formatWorkspaceCurrent(result: unknown): void {
  const ws = result as WorkspaceInfo | null;
  if (!ws) {
    console.log('No active workspace.');
    return;
  }
  console.log(`Current workspace: ${ws.name} (${ws.id})`);
}

export async function handleWorkspace(
  cmd: string,
  args: string[],
  jsonMode: boolean
): Promise<void> {
  let response: RpcResponse;

  switch (cmd) {
    case 'list-workspaces': {
      response = await sendRequest('workspace.list', {});
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        formatWorkspaceList(response.result);
      }
      break;
    }

    case 'new-workspace': {
      const name = parseFlag(args, '--name') ?? `workspace-${Date.now()}`;
      // The pane hint lets main stamp the new workspace as a fan-out task when
      // this shell is one (depth-1 lineage inheritance). Only a hint — main
      // uses it for nothing that could widen what the caller may do.
      const senderPtyId = process.env[ENV_KEYS.PTY_ID]?.trim();
      response = await sendRequest('workspace.new', { name, ...(senderPtyId ? { senderPtyId } : {}) });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        const ws = response.result as WorkspaceInfo;
        console.log(`Created workspace: ${ws?.name ?? name} (${ws?.id ?? ''})`);
      }
      break;
    }

    case 'focus-workspace': {
      const id = args[0];
      if (!id) {
        console.error('Error: focus-workspace requires <id>');
        process.exit(1);
      }
      response = await sendRequest('workspace.focus', { id });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(`Focused workspace: ${id}`);
      }
      break;
    }

    case 'close-workspace': {
      const id = args[0];
      if (!id) {
        console.error('Error: close-workspace requires <id>');
        process.exit(1);
      }
      response = await sendRequest('workspace.close', { id });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(`Closed workspace: ${id}`);
      }
      break;
    }

    case 'current-workspace': {
      response = await sendRequest('workspace.current', {});
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        formatWorkspaceCurrent(response.result);
      }
      break;
    }

    default:
      console.error(`Unknown workspace command: ${cmd}`);
      process.exit(1);
  }
}
