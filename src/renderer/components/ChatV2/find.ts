// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/model/transcriptFind.ts), MIT License, Copyright (c) 2026 Nick
import type { Block } from '../../../shared/chatv2/session';

export function transcriptBlockText(block: Block): string {
  const parts: string[] = [];
  if (block.text.trim()) parts.push(block.text);
  if (block.tool?.title) parts.push(block.tool.title);
  if (block.image?.name) parts.push(block.image.name);
  if (block.image?.alt) parts.push(block.image.alt);
  if (block.tool?.detail) parts.push(block.tool.detail);
  if (block.tool?.preview?.query) parts.push(block.tool.preview.query);
  if (block.tool?.preview?.path) parts.push(block.tool.preview.path);
  if (block.tool?.preview?.output) parts.push(block.tool.preview.output);
  if (block.tool?.preview?.title) parts.push(block.tool.preview.title);
  if (block.agentRun) parts.push(block.agentRun.name, ...block.agentRun.steps.map((step) => step.text));
  if (block.taskList) parts.push(...block.taskList.items.map((item) => item.text));
  return parts.join('\n');
}

/** Ids of the blocks whose text contains `query` (case-insensitive), in transcript order. */
export function findTranscriptBlocks(blocks: readonly Block[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return blocks
    .filter(
      (block) =>
        (block.role === 'user' ||
          block.role === 'assistant' ||
          block.role === 'tool' ||
          block.role === 'approval' ||
          block.role === 'tasks' ||
          block.role === 'plan' ||
          block.role === 'image') &&
        transcriptBlockText(block).toLowerCase().includes(needle),
    )
    .map((block) => block.id);
}
