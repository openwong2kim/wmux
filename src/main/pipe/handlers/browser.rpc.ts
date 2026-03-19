import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

/**
 * Registers browser.* RPC handlers.
 *
 * All commands are delegated to the renderer process via IPC where the active
 * browser Surface's <webview> element executes the requested operation.
 */
export function registerBrowserRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * browser.snapshot
   * Returns the full outer HTML of the current page as a string.
   * params: {}
   */
  router.register('browser.snapshot', (params) => {
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    return sendToRenderer(getWindow, 'browser.snapshot', {
      ...(surfaceId && { surfaceId }),
    });
  });

  /**
   * browser.click
   * Clicks the first element matching the given CSS selector.
   * params: { selector: string }
   */
  router.register('browser.click', (params) => {
    if (typeof params['selector'] !== 'string' || params['selector'].length === 0) {
      throw new Error('browser.click: missing required param "selector"');
    }
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    return sendToRenderer(getWindow, 'browser.click', {
      selector: params['selector'],
      ...(surfaceId && { surfaceId }),
    });
  });

  /**
   * browser.fill
   * Sets the value of an input element matching the given CSS selector.
   * params: { selector: string; text: string }
   */
  router.register('browser.fill', (params) => {
    if (typeof params['selector'] !== 'string' || params['selector'].length === 0) {
      throw new Error('browser.fill: missing required param "selector"');
    }
    if (typeof params['text'] !== 'string') {
      throw new Error('browser.fill: missing required param "text"');
    }
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    return sendToRenderer(getWindow, 'browser.fill', {
      selector: params['selector'],
      text: params['text'],
      ...(surfaceId && { surfaceId }),
    });
  });

  /**
   * browser.eval
   * Evaluates arbitrary JavaScript in the context of the current page.
   * params: { code: string }
   */
  router.register('browser.eval', (params) => {
    if (typeof params['code'] !== 'string' || params['code'].length === 0) {
      throw new Error('browser.eval: missing required param "code"');
    }
    // Security: block patterns that could escape webview sandbox
    const code = params['code'];
    const dangerousPatterns = [
      /\brequire\s*\(/i,
      /\bprocess\s*\./i,
      /\b__dirname\b/i,
      /\b__filename\b/i,
      /\bchild_process\b/i,
      /\bglobal\s*\.\s*process\b/i,
      /\belectron\b/i,
    ];
    for (const pat of dangerousPatterns) {
      if (pat.test(code)) {
        throw new Error('browser.eval: code contains blocked pattern');
      }
    }
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    return sendToRenderer(getWindow, 'browser.eval', {
      code,
      ...(surfaceId && { surfaceId }),
    });
  });

  /**
   * browser.navigate
   * Navigates the active browser Surface to the given URL.
   * params: { url: string }
   */
  router.register('browser.navigate', (params) => {
    if (typeof params['url'] !== 'string' || params['url'].length === 0) {
      throw new Error('browser.navigate: missing required param "url"');
    }
    // Security: block dangerous URL schemes
    const url = params['url'];
    const normalizedUrl = url.trim().toLowerCase();
    if (
      normalizedUrl.startsWith('javascript:') ||
      normalizedUrl.startsWith('data:') ||
      normalizedUrl.startsWith('vbscript:') ||
      normalizedUrl.startsWith('file:')
    ) {
      throw new Error(`browser.navigate: blocked URL scheme`);
    }
    const surfaceId = typeof params['surfaceId'] === 'string' ? params['surfaceId'] : undefined;
    return sendToRenderer(getWindow, 'browser.navigate', {
      url,
      ...(surfaceId && { surfaceId }),
    });
  });
}
