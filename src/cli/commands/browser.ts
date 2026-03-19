import { sendRequest } from '../client';
import { printResult, printError } from '../utils';
import type { RpcResponse } from '../../shared/rpc';

const BROWSER_HELP = `
wmux browser — Scriptable Browser API

USAGE
  wmux browser <subcommand> [args]

SUBCOMMANDS
  snapshot                        Return the full page HTML (document.documentElement.outerHTML)
  click <selector>                Click the first element matching the CSS selector
  fill <selector> <text>          Set the value of an input matching the CSS selector
  eval <code>                     Execute arbitrary JavaScript in the page context
  navigate <url>                  Navigate the active browser surface to a URL

EXAMPLES
  wmux browser snapshot
  wmux browser click "#submit-btn"
  wmux browser fill "input[name=email]" "user@example.com"
  wmux browser eval "document.title"
  wmux browser navigate "https://example.com"
`.trimStart();

export async function handleBrowser(
  args: string[],
  jsonMode: boolean,
): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(BROWSER_HELP);
    process.exit(0);
  }

  let response: RpcResponse;

  switch (sub) {
    // ── browser snapshot ─────────────────────────────────────────────────────
    case 'snapshot': {
      response = await sendRequest('browser.snapshot', {});
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        const r = response.result as { html?: string } | null;
        process.stdout.write(r?.html ?? '');
      }
      break;
    }

    // ── browser click <selector> ─────────────────────────────────────────────
    case 'click': {
      const selector = rest[0];
      if (!selector) {
        console.error('Error: browser click requires <selector>');
        process.exit(1);
      }
      response = await sendRequest('browser.click', { selector });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        console.log(`Clicked: ${selector}`);
      }
      break;
    }

    // ── browser fill <selector> <text> ───────────────────────────────────────
    case 'fill': {
      const selector = rest[0];
      const text = rest.slice(1).join(' ');
      if (!selector) {
        console.error('Error: browser fill requires <selector> <text>');
        process.exit(1);
      }
      response = await sendRequest('browser.fill', { selector, text });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        console.log(`Filled "${selector}" with "${text}"`);
      }
      break;
    }

    // ── browser eval <code> ──────────────────────────────────────────────────
    case 'eval': {
      const code = rest.join(' ');
      if (!code) {
        console.error('Error: browser eval requires <code>');
        process.exit(1);
      }
      response = await sendRequest('browser.eval', { code });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        const r = response.result as { result?: unknown } | null;
        console.log(JSON.stringify(r?.result, null, 2));
      }
      break;
    }

    // ── browser navigate <url> ───────────────────────────────────────────────
    case 'navigate': {
      const url = rest[0];
      if (!url) {
        console.error('Error: browser navigate requires <url>');
        process.exit(1);
      }
      response = await sendRequest('browser.navigate', { url });
      if (jsonMode) {
        printResult(response);
      } else {
        if (!response.ok) { printError(response); return; }
        console.log(`Navigated to: ${url}`);
      }
      break;
    }

    default:
      console.error(`Unknown browser subcommand: "${sub}". Run 'wmux browser --help' for usage.`);
      process.exit(1);
  }
}
