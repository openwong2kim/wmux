import { sendRequest } from '../client';
import { printResult, printError, parseFlag } from '../utils';
import type { RpcResponse } from '../../shared/rpc';

interface PaneInfo {
  id: string;
  type: 'leaf' | 'branch';
  direction?: string;
  activeSurfaceId?: string;
}

function formatPaneList(result: unknown): void {
  const list = result as PaneInfo[];
  if (!Array.isArray(list) || list.length === 0) {
    console.log('No panes found.');
    return;
  }
  const maxId = Math.max(...list.map((p) => p.id.length));
  console.log('ID'.padEnd(maxId + 2) + 'TYPE'.padEnd(8) + 'DETAILS');
  console.log('-'.repeat(maxId + 30));
  for (const p of list) {
    let details = '';
    if (p.type === 'leaf' && p.activeSurfaceId) {
      details = `active surface: ${p.activeSurfaceId}`;
    } else if (p.type === 'branch' && p.direction) {
      details = `direction: ${p.direction}`;
    }
    console.log(p.id.padEnd(maxId + 2) + p.type.padEnd(8) + details);
  }
}

export async function handlePane(
  cmd: string,
  args: string[],
  jsonMode: boolean
): Promise<void> {
  let response: RpcResponse;

  switch (cmd) {
    case 'list-panes': {
      response = await sendRequest('pane.list', {});
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        formatPaneList(response.result);
      }
      break;
    }

    case 'focus-pane': {
      const id = args[0];
      if (!id) {
        console.error('Error: focus-pane requires <id>');
        process.exit(1);
      }
      response = await sendRequest('pane.focus', { id });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        console.log(`Focused pane: ${id}`);
      }
      break;
    }

    case 'split': {
      const direction = parseFlag(args, '--direction') ?? 'right';
      if (direction !== 'right' && direction !== 'down') {
        console.error('Error: --direction must be "right" or "down"');
        process.exit(1);
      }
      // right → horizontal, down → vertical (server expects horizontal/vertical)
      const dirMap: Record<string, string> = { right: 'horizontal', down: 'vertical' };
      const mapped = dirMap[direction] || direction;
      response = await sendRequest('pane.split', { direction: mapped });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        console.log(`Split pane ${direction}.`);
      }
      break;
    }

    default:
      console.error(`Unknown pane command: ${cmd}`);
      process.exit(1);
  }
}
