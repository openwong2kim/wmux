import { z } from 'zod';

// Disk records can be interrupted, edited, or produced by an older version.
// Validate display payloads before sending them to the renderer.
const body = z.object({ n: z.number(), bytes: z.number(), inline: z.string().optional(), truncated: z.boolean().optional(), srcOffset: z.number().optional() });
const base = { id: z.string().min(1), turnId: z.string().optional(), ts: z.number().optional(), truncated: z.boolean().optional() };
const event = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('user_text'), text: z.string(), hasImage: z.boolean().optional() }),
  z.object({ ...base, kind: z.literal('assistant_text'), text: z.string(), thinking: z.boolean().optional(), turnComplete: z.boolean().optional(),
    codeBlocks: z.array(z.object({ n: z.number(), lines: z.number(), lang: z.string().optional(), path: z.string().optional(), srcOffset: z.number().optional(), truncated: z.boolean().optional() })).optional() }),
  z.object({ ...base, kind: z.literal('tool_use'), toolUseId: z.string(), name: z.string(), argSummary: z.string(), input: body.optional() }),
  z.object({ ...base, kind: z.literal('tool_result'), toolUseId: z.string(), ok: z.boolean(), bytes: z.number(), output: body.optional(), diffLike: z.boolean().optional(),
    files: z.array(z.object({ path: z.string(), patch: z.string(), additions: z.number().optional(), deletions: z.number().optional(), truncated: z.boolean().optional() })).optional() }),
  z.object({ ...base, kind: z.literal('meta'), subtype: z.string(), label: z.string() }),
]);
export const validStoredEvent = (value: unknown): boolean => event.safeParse(value).success;
