import { sendRequest } from '../client';
import { printResult, printError } from '../utils';
import type { RpcResponse } from '../../shared/rpc';

interface SurfaceInfo {
  id: string;
  title: string;
  shell: string;
  cwd: string;
}

function formatSurfaceList(result: unknown): void {
  const list = result as SurfaceInfo[];
  if (!Array.isArray(list) || list.length === 0) {
    console.log('No surfaces found.');
    return;
  }
  const maxId = Math.max(...list.map((s) => s.id.length));
  const maxTitle = Math.max(...list.map((s) => (s.title ?? '').length), 5);
  console.log(
    'ID'.padEnd(maxId + 2) +
    'TITLE'.padEnd(maxTitle + 2) +
    'SHELL'
  );
  console.log('-'.repeat(maxId + maxTitle + 20));
  for (const s of list) {
    console.log(
      s.id.padEnd(maxId + 2) +
      (s.title ?? '').padEnd(maxTitle + 2) +
      (s.shell ?? '')
    );
  }
}

export async function handleSurface(
  cmd: string,
  args: string[],
  jsonMode: boolean
): Promise<void> {
  let response: RpcResponse;

  switch (cmd) {
    case 'list-surfaces': {
      response = await sendRequest('surface.list', {});
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        formatSurfaceList(response.result);
      }
      break;
    }

    case 'new-surface': {
      response = await sendRequest('surface.new', {});
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        const s = response.result as SurfaceInfo;
        console.log(`Created surface: ${s?.id ?? '(unknown)'}`);
      }
      break;
    }

    case 'focus-surface': {
      const id = args[0];
      if (!id) {
        console.error('Error: focus-surface requires <id>');
        process.exit(1);
      }
      response = await sendRequest('surface.focus', { id });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        console.log(`Focused surface: ${id}`);
      }
      break;
    }

    case 'close-surface': {
      const id = args[0];
      if (!id) {
        console.error('Error: close-surface requires <id>');
        process.exit(1);
      }
      response = await sendRequest('surface.close', { id });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        console.log(`Closed surface: ${id}`);
      }
      break;
    }

    default:
      console.error(`Unknown surface command: ${cmd}`);
      process.exit(1);
  }
}
