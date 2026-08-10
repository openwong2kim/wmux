import { describe, expect, it } from 'vitest';
import { PLUGIN_PROTOCOL_SCHEME } from '../../../shared/pluginHost';
import { MAIN_WINDOW_PRODUCTION_CSP } from '../createWindow';

function parseDirectives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe('main-window production CSP', () => {
  it('allows the registered plugin scheme only as a frame source', () => {
    const directives = parseDirectives(MAIN_WINDOW_PRODUCTION_CSP);
    const pluginSource = `${PLUGIN_PROTOCOL_SCHEME}:`;

    expect(directives.get('frame-src')).toContain(pluginSource);

    for (const directive of ['default-src', 'script-src', 'connect-src']) {
      expect(directives.get(directive), `${directive} must remain self-only`).toEqual(["'self'"]);
    }

    for (const [directive, sources] of directives) {
      if (directive !== 'frame-src') {
        expect(sources, `${directive} must not allow plugin resources`).not.toContain(pluginSource);
      }
    }
  });
});
