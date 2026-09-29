// Source-lockstep guard for the statusline-push lane (#1111).
//
// `integrations/claude/bin/wmux-statusline.mjs` is a standalone script outside
// the main build, so nothing but this test keeps it in step with the enforcer.
// Same two failure modes as hookBridge.lockstep.test.ts, both of which would
// silently stop live usage numbers under enforce mode:
//
//   1. The script stops sending the recognised clientName (or a typo drifts
//      it) -> its `usage.rateLimits` is refused as identity-status:legacy.
//   2. The script starts calling a main-pipe method outside
//      STATUSLINE_PUSH_METHODS -> that call is refused, because the lane is
//      deliberately one method.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { STATUSLINE_PUSH_METHODS, WMUX_STATUSLINE_CLIENT_NAME } from '../statuslinePush';

// src/main/mcp/__tests__ -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'integrations', 'claude', 'bin', 'wmux-statusline.mjs');

describe('statusline push — enforcer lockstep (#1111)', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  it('sends the recognised clientName', () => {
    expect(
      src.includes(`'${WMUX_STATUSLINE_CLIENT_NAME}'`),
      `wmux-statusline.mjs must declare clientName '${WMUX_STATUSLINE_CLIENT_NAME}' — without ` +
        `it the enforcer refuses its main-pipe usage.rateLimits as identity-status:legacy (#1111)`,
    ).toBe(true);
    expect(
      /clientName:/.test(src),
      'wmux-statusline.mjs must actually put clientName on the request envelope',
    ).toBe(true);
  });

  it('calls no main-pipe method outside the lane', () => {
    const found = [...src.matchAll(/method:\s*'([a-zA-Z][A-Za-z0-9]*\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]);
    expect(found.length, 'expected to find the usage.rateLimits request builder').toBeGreaterThan(0);
    const outside = found.filter((m) => !STATUSLINE_PUSH_METHODS.has(m as never));
    expect(
      outside,
      'wmux-statusline.mjs calls main-pipe method(s) outside STATUSLINE_PUSH_METHODS. Add them ' +
        'to src/main/mcp/statuslinePush.ts deliberately.',
    ).toEqual([]);
  });
});
