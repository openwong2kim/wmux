import { sendRequest } from '../client';
import { printResult, ensureOk, parseFlag } from '../utils';
import type { RpcResponse } from '../../shared/rpc';

interface PaneInfo {
  id: string;
  surfaceCount?: number;
  active?: boolean;
  cwd?: string;
}

function formatPaneList(result: unknown): void {
  // pane.list RPC returns { asOfSeq, bootId, panes: [...] }. Previously result
  // was cast directly to PaneInfo[], so Array.isArray was always false → showed
  // "No panes found" even when panes existed (--json was fine). Extract panes
  // and render.
  const panes = (result as { panes?: unknown } | null)?.panes;
  const list = Array.isArray(panes) ? (panes as PaneInfo[]) : [];
  if (list.length === 0) {
    console.log('No panes found.');
    return;
  }
  const maxId = Math.max(...list.map((p) => p.id.length));
  console.log('ID'.padEnd(maxId + 2) + 'SURFACES'.padEnd(10) + 'ACTIVE'.padEnd(8) + 'CWD');
  console.log('-'.repeat(maxId + 40));
  for (const p of list) {
    console.log(
      p.id.padEnd(maxId + 2) +
        String(p.surfaceCount ?? '').padEnd(10) +
        (p.active ? 'yes' : 'no').padEnd(8) +
        (p.cwd ?? ''),
    );
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
        ensureOk(response);
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
        ensureOk(response);
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
        ensureOk(response);
        console.log(`Split pane ${direction}.`);
      }
      break;
    }

    default:
      console.error(`Unknown pane command: ${cmd}`);
      process.exit(1);
  }
}
