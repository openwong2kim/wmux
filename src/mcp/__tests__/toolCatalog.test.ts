import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineWmuxTool,
  registerWmuxTools,
  selectWmuxTools,
  type WmuxOperationContext,
  type WmuxToolProfile,
  type WmuxToolSpec,
} from '../toolCatalog';

function makeTool(
  name: string,
  profiles: readonly WmuxToolProfile[] = ['full'],
): WmuxToolSpec {
  return defineWmuxTool({
    name,
    description: `${name} description`,
    inputSchema: {
      value: z.string().describe('Value'),
    },
    profiles,
    invoke: async ({ value }, context) => ({
      content: [
        {
          type: 'text',
          text: `${value}:${context.profile}:${context.principal.kind}`,
        },
      ],
    }),
  });
}

describe('typed wmux tool catalog', () => {
  it('preserves declaration order while selecting an immutable profile', () => {
    const fullOnly = makeTool('full_only');
    const shared = makeTool('shared', ['full', 'commander']);
    const commander = selectWmuxTools([fullOnly, shared], 'commander');

    expect(commander.map((spec) => spec.name)).toEqual(['shared']);
    expect(Object.isFrozen(commander)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.profiles)).toBe(true);
    expect(Object.isFrozen(shared.inputSchema)).toBe(true);
  });

  it('fails before filtering when any profile contains a duplicate name', () => {
    const duplicate = makeTool('duplicate', ['full', 'commander']);
    expect(() => selectWmuxTools([duplicate, duplicate], 'core')).toThrow(
      'duplicate wmux tool name: duplicate',
    );
  });

  it('requires full to remain the catalog superset', () => {
    expect(() => makeTool('commander_only', ['commander'])).toThrow(
      'the full profile must remain a superset',
    );
  });

  it('registers only the legacy wire fields and injects explicit operation context', async () => {
    const registrations: Array<{
      name: string;
      config: Record<string, unknown>;
      handler: (input: Record<string, unknown>) => unknown;
    }> = [];
    const server = {
      registerTool: (
        name: string,
        config: Record<string, unknown>,
        handler: (input: Record<string, unknown>) => unknown,
      ) => {
        registrations.push({ name, config, handler });
        return { name };
      },
    };
    const context: WmuxOperationContext = {
      profile: 'commander',
      principal: { kind: 'unattributed' },
    };
    const fullOnly = makeTool('full_only');
    const shared = makeTool('shared', ['full', 'commander']);

    const registered = registerWmuxTools(
      server as never,
      [fullOnly, shared],
      { context },
    );

    expect(registrations.map(({ name }) => name)).toEqual(['shared']);
    expect(registrations[0]?.config).toEqual({
      description: 'shared description',
      inputSchema: shared.inputSchema,
    });
    expect(registrations[0]?.config).not.toHaveProperty('title');
    expect(registrations[0]?.config).not.toHaveProperty('annotations');
    expect(registrations[0]?.config).not.toHaveProperty('outputSchema');
    (context as { profile: WmuxToolProfile }).profile = 'full';
    await expect(registrations[0]?.handler({ value: 'ok' })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok:commander:unattributed' }],
    });
    expect(Object.isFrozen(registered)).toBe(true);
  });

  it('fails closed on a malformed transport-issued principal', () => {
    const server = { registerTool: () => ({}) };
    expect(() =>
      registerWmuxTools(server as never, [makeTool('read_tool')], {
        context: {
          profile: 'full',
          principal: { kind: 'transport', id: '   ' },
        },
      }),
    ).toThrow('transport principals must have a non-empty id');
  });
});
