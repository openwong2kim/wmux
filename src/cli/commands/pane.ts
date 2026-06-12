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
  // pane.list RPC는 { asOfSeq, bootId, panes: [...] } 형태를 반환한다. 과거엔
  // result 자체를 PaneInfo[]로 캐스트해 Array.isArray가 항상 false → 팬이
  // 있어도 "No panes found"로 표시되던 버그가 있었다(--json은 정상). panes를
  // 추출해서 렌더한다.
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
