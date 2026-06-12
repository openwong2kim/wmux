import { readFileSync } from 'fs';
import { join } from 'path';
import { sendRequest } from '../client';
import { printResult, ensureOk } from '../utils';
import type { RpcResponse } from '../../shared/rpc';

function getFallbackVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface IdentifyResult {
  app: string;
  version: string;
  platform: string;
}

export async function handleSystem(
  cmd: string,
  args: string[],
  jsonMode: boolean
): Promise<void> {
  let response: RpcResponse;

  switch (cmd) {
    case 'identify': {
      response = await sendRequest('system.identify', {});
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        const info = response.result as IdentifyResult;
        console.log(`app:      ${info?.app ?? 'wmux'}`);
        console.log(`version:  ${info?.version ?? getFallbackVersion()}`);
        console.log(`platform: ${info?.platform ?? process.platform}`);
      }
      break;
    }

    case 'capabilities': {
      response = await sendRequest('system.capabilities', {});
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        // server may return { methods: string[] } or string[] directly
        const result = response.result as { methods?: string[] } | string[];
        const methods = Array.isArray(result) ? result : (result?.methods || []);
        if (methods.length > 0) {
          console.log('Supported RPC methods:');
          for (const m of methods) {
            console.log(`  ${m}`);
          }
        } else {
          console.log(JSON.stringify(response.result, null, 2));
        }
      }
      break;
    }

    case 'set-status': {
      const text = args[0];
      if (text === undefined) {
        console.error('Error: set-status requires <text>');
        process.exit(1);
      }
      response = await sendRequest('meta.setStatus', { text });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(`Status set: "${text}"`);
      }
      break;
    }

    case 'set-progress': {
      const raw = args[0];
      if (raw === undefined) {
        console.error('Error: set-progress requires <0-100>');
        process.exit(1);
      }
      const value = Number(raw);
      if (isNaN(value) || value < 0 || value > 100) {
        console.error('Error: progress value must be a number between 0 and 100');
        process.exit(1);
      }
      response = await sendRequest('meta.setProgress', { value });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(`Progress set: ${value}%`);
      }
      break;
    }

    default:
      console.error(`Unknown system command: ${cmd}`);
      process.exit(1);
  }
}
