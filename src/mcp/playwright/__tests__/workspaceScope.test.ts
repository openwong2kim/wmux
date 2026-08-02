import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  allowScopedRpcFallback,
  requireBrowserTargetScope,
} from '../browserScope';

describe('browser tool workspace scope', () => {
  it('refuses an empty strict-resolver result', async () => {
    await expect(
      requireBrowserTargetScope({ resolveWorkspaceId: async () => '' }, 'surface-1'),
    ).rejects.toThrow('WORKSPACE_SCOPE_UNRESOLVED');
  });

  it('never converts a workspace-scope refusal into an RPC fallback', () => {
    expect(() => allowScopedRpcFallback(
      new Error('WORKSPACE_SCOPE_UNRESOLVED: legacy main cannot prove ownership'),
    )).toThrow('WORKSPACE_SCOPE_UNRESOLVED');
    expect(allowScopedRpcFallback(new Error('Playwright page unavailable'))).toBeNull();
  });

  it('keeps direct browser fallback RPCs behind the scope-required helper', () => {
    const root = path.join(__dirname, '..');
    const files = [
      'page-eval.ts',
      'markdown-extractor.ts',
      ...fs.readdirSync(path.join(root, 'tools'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => `tools/${name}`),
    ];
    for (const relative of files) {
      const source = fs.readFileSync(path.join(root, relative), 'utf8');
      const directBrowserCalls = source.match(/sendRpc\(\s*['"]browser\.[^'"]+/g) ?? [];
      if (relative === 'tools/navigation.ts') {
        // browser.tabs has its own typed workspace contract; every other
        // navigation RPC goes through sendScopedBrowserRpc.
        expect(directBrowserCalls).toEqual(["sendRpc('browser.tabs"]);
      } else {
        expect(directBrowserCalls, `${relative} must not bypass sendScopedBrowserRpc`).toEqual([]);
      }

      // Tool code may only use the required scope-taking engine entry point.
      expect(source, `${relative} must not call optional-scope getPage`).not.toMatch(
        /await\s+engine\.getPage\(/,
      );
    }
  });
});
