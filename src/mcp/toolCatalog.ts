import type {
  McpServer,
  RegisteredTool,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

/**
 * Launch-time tool surfaces. A server instance selects exactly one profile and
 * never widens it after initialization.
 */
export type WmuxToolProfile = 'full' | 'core' | 'commander';

/**
 * Catalog invocation identity. `unattributed` is deliberately powerless: the
 * catalog must never turn profile, MCP clientInfo, or annotations into auth.
 * Only a future authenticated transport adapter may construct `transport`.
 */
export type WmuxOperationPrincipal =
  | { readonly kind: 'unattributed' }
  | { readonly kind: 'transport'; readonly id: string };

export interface WmuxOperationContext {
  readonly profile: WmuxToolProfile;
  readonly principal: WmuxOperationPrincipal;
}

type WmuxToolResult = CallToolResult | Promise<CallToolResult>;

/**
 * Runtime-erased catalog descriptor. Use defineWmuxTool() to retain literal
 * names and exact Zod inference while authoring a tool. The erasure happens
 * once at the registry boundary so heterogeneous specs can share one array.
 *
 * Effects, retries, locks, and downstream RPC declarations are intentionally
 * absent in the first migration slice. Those fields only become truthful after
 * argument-sensitive classifiers and daemon-observed closure tests exist.
 */
export interface WmuxToolSpec<Name extends string = string> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly profiles: readonly WmuxToolProfile[];
  readonly invoke: (
    input: Record<string, unknown>,
    context: WmuxOperationContext,
  ) => WmuxToolResult;
}

type WmuxToolDraft<Name extends string, Shape extends z.ZodRawShape> =
  Omit<WmuxToolSpec<Name>, 'inputSchema' | 'profiles' | 'invoke'> & {
    readonly inputSchema: Shape;
    readonly profiles: readonly WmuxToolProfile[];
    readonly invoke: (
      input: z.infer<z.ZodObject<Shape>>,
      context: WmuxOperationContext,
    ) => WmuxToolResult;
  };

export interface RegisterWmuxToolsOptions {
  readonly context: WmuxOperationContext;
}

const TOOL_PROFILES: ReadonlySet<WmuxToolProfile> = new Set([
  'full',
  'core',
  'commander',
]);

function assertValidToolSpec(spec: WmuxToolSpec): void {
  if (!spec.name.trim()) {
    throw new Error('wmux tool names must not be empty');
  }
  if (!spec.description.trim()) {
    throw new Error(`${spec.name}: description must not be empty`);
  }
  if (spec.profiles.length === 0) {
    throw new Error(`${spec.name}: at least one profile is required`);
  }
  if (!spec.profiles.includes('full')) {
    throw new Error(`${spec.name}: the full profile must remain a superset`);
  }
  if (new Set(spec.profiles).size !== spec.profiles.length) {
    throw new Error(`${spec.name}: duplicate profile`);
  }
  for (const profile of spec.profiles) {
    if (!TOOL_PROFILES.has(profile)) {
      throw new Error(`${spec.name}: unknown profile ${String(profile)}`);
    }
  }
}

/**
 * Define and freeze one descriptor while preserving its literal name and exact
 * input type. Zod nodes are treated as immutable values; the raw shape
 * container itself is frozen so properties cannot be swapped after launch.
 */
export function defineWmuxTool<
  const Name extends string,
  const Shape extends z.ZodRawShape,
>(
  draft: WmuxToolDraft<Name, Shape>,
): WmuxToolSpec<Name> {
  const spec: WmuxToolSpec<Name> = {
    ...draft,
    inputSchema: Object.freeze(draft.inputSchema),
    profiles: Object.freeze([...draft.profiles]),
    // The SDK validates the Zod shape before invocation. This is the sole
    // heterogeneous-catalog erasure; each draft handler remains inferred.
    invoke: draft.invoke as unknown as WmuxToolSpec<Name>['invoke'],
  };
  assertValidToolSpec(spec);
  return Object.freeze(spec);
}

/**
 * Select a deterministic profile without mutating the catalog or its order.
 * Duplicate names fail before filtering so a hidden collision cannot surface
 * later when a different immutable profile is selected.
 */
export function selectWmuxTools(
  specs: readonly WmuxToolSpec[],
  profile: WmuxToolProfile,
): readonly WmuxToolSpec[] {
  const names = new Set<string>();
  for (const spec of specs) {
    assertValidToolSpec(spec);
    if (names.has(spec.name)) {
      throw new Error(`duplicate wmux tool name: ${spec.name}`);
    }
    names.add(spec.name);
  }
  return Object.freeze(specs.filter((spec) => spec.profiles.includes(profile)));
}

/**
 * Current-SDK adapter. It preserves the exact legacy wire descriptor while
 * removing one deprecated server.tool() dependency. Authorization remains in
 * RpcRouter/PermissionEnforcer; this adapter only registers and invokes tools.
 */
export function registerWmuxTools(
  server: McpServer,
  specs: readonly WmuxToolSpec[],
  options: RegisterWmuxToolsOptions,
): readonly RegisteredTool[] {
  if (!TOOL_PROFILES.has(options.context.profile)) {
    throw new Error(`unknown wmux tool profile: ${String(options.context.profile)}`);
  }
  if (
    options.context.principal.kind === 'transport' &&
    !options.context.principal.id.trim()
  ) {
    throw new Error('transport principals must have a non-empty id');
  }
  const context: WmuxOperationContext = Object.freeze({
    profile: options.context.profile,
    principal: Object.freeze({ ...options.context.principal }),
  });
  const selected = selectWmuxTools(specs, context.profile);
  return Object.freeze(
    selected.map((spec) =>
      server.registerTool(
        spec.name,
        {
          description: spec.description,
          inputSchema: spec.inputSchema,
        },
        (input) => spec.invoke(input, context),
      ),
    ),
  );
}
