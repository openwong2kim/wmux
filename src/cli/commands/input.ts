import { sendRequest } from '../client';
import { printResult, printError } from '../utils';
import type { RpcResponse } from '../../shared/rpc';

export async function handleInput(
  cmd: string,
  args: string[],
  jsonMode: boolean
): Promise<void> {
  let response: RpcResponse;

  switch (cmd) {
    case 'send': {
      const text = args.join(' ');
      if (!text) {
        console.error('Error: send requires <text>');
        process.exit(1);
      }
      response = await sendRequest('input.send', { text });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        console.log('Text sent.');
      }
      break;
    }

    case 'send-key': {
      const key = args[0];
      if (!key) {
        console.error('Error: send-key requires <keystroke>');
        process.exit(1);
      }
      response = await sendRequest('input.sendKey', { key });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        console.log(`Key sent: ${key}`);
      }
      break;
    }

    case 'read-screen': {
      response = await sendRequest('input.readScreen', {});
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        // server returns { text: string } object or plain string
        const result = response.result as { text?: string } | string;
        let screen: string;
        if (typeof result === 'object' && result !== null && 'text' in result) {
          screen = result.text ?? '';
        } else if (typeof result === 'string') {
          screen = result;
        } else {
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        process.stdout.write(screen);
        if (!screen.endsWith('\n')) process.stdout.write('\n');
      }
      break;
    }

    default:
      console.error(`Unknown input command: ${cmd}`);
      process.exit(1);
  }
}
