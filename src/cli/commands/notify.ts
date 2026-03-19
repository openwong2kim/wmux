import { sendRequest } from '../client';
import { printResult, printError, parseFlag } from '../utils';
import type { RpcResponse } from '../../shared/rpc';

export async function handleNotify(
  args: string[],
  jsonMode: boolean
): Promise<void> {
  const title = parseFlag(args, '--title');
  const body = parseFlag(args, '--body');

  if (!title) {
    console.error('Error: notify requires --title <text>');
    process.exit(1);
  }
  if (!body) {
    console.error('Error: notify requires --body <text>');
    process.exit(1);
  }

  const response: RpcResponse = await sendRequest('notify', { title, body });

  if (jsonMode) {
    printResult(response);
  } else {
    if (!response.ok) { printError(response); return; }
    console.log(`Notification sent: "${title}"`);
  }
}
