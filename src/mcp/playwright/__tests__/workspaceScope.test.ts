import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { requireBrowserTargetScope } from '../browserScope';

describe('browser tool workspace scope', () => {
  it('refuses an empty strict-resolver result', async () => {
    await expect(
      requireBrowserTargetScope({ resolveWorkspaceId: async () => '' }, 'surface-1'),
    ).rejects.toThrow('WORKSPACE_SCOPE_UNRESOLVED');
  });

  it('keeps direct browser fallback RPCs behind the scope-required helper', () => {
    const root = path.join(__dirname, '..');
    const files = [
      'page-eval.ts',
      'tools/interaction.ts',
      'tools/inspection.ts',
      'tools/state.ts',
    ];
    for (const relative of files) {
      const source = fs.readFileSync(path.join(root, relative), 'utf8');
      expect(source, `${relative} must not bypass sendScopedBrowserRpc`).not.toMatch(
        /sendRpc\(\s*['"]browser\./,
      );
      expect(source, `${relative} must use the scope-required helper`).toContain(
        'sendScopedBrowserRpc',
      );
    }

    // Navigation has one intentionally separate browser.tabs call with an
    // explicit workspaceId contract; navigate/back/evaluate use the helper.
    const navigation = fs.readFileSync(path.join(root, 'tools/navigation.ts'), 'utf8');
    const directBrowserCalls = navigation.match(/sendRpc\(\s*['"]browser\.[^'"]+/g) ?? [];
    expect(directBrowserCalls).toEqual(["sendRpc('browser.tabs"]);
    expect(navigation).toContain('sendScopedBrowserRpc');
  });
});
