import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// W1 Tier A (docs/web-security-review-2026-07-24.md, issue #607): the --expose
// report must state that the token and scrollback travel in cleartext, and give
// a concrete HTTPS fronting instruction. Source-level invariant, same pattern
// as the other CLI-output assertions in this repo.
const src = readFileSync(path.join(__dirname, '..', 'web.ts'), 'utf8');

describe('wmux web --expose cleartext warning (W1 Tier A)', () => {
  it('the exposed branch prints an UNENCRYPTED warning with an HTTPS instruction', () => {
    const start = src.indexOf('} else if (exposed) {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('}', start + '} else if (exposed) {'.length));
    expect(body).toContain('UNENCRYPTED');
    expect(body).toMatch(/sniff/);
    expect(body).toMatch(/tailscale serve/);
  });
});
