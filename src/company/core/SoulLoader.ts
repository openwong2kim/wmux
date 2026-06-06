// ─── Soul Loader ──────────────────────────────────────────────────────────────
// Maintains the agent SOUL API while preventing runtime third-party prompt downloads.
// Designed to work in the Electron renderer process (no Node.js fs required).

import { SOUL_MAPPING } from './soulMapping';

// Remote SOUL prompt downloads are disabled by default. The previous
// implementation fetched mutable third-party markdown from GitHub and
// installed it as Claude instructions, which made company spawning depend on
// unaudited command-capable prompts. Keep the loader shape for callers, but do
// not make network requests or cache remote prompt text.
/** In-memory cache: presetId -> raw markdown content */
const soulCache = new Map<string, string>();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a preset has a SOUL mapping in the agency-agents repo.
 */
export function hasSoul(presetId: string): boolean {
  return presetId in SOUL_MAPPING;
}

/**
 * Get a cached SOUL synchronously. Returns null if not yet fetched.
 */
export function loadSoulSync(presetId: string): string | null {
  return soulCache.get(presetId) ?? null;
}

/**
 * Runtime network fetching is intentionally disabled for SOUL files.
 * Returns null so callers fall back to built-in wmux role prompts.
 */
export async function fetchSoul(_presetId: string): Promise<string | null> {
  void _presetId;
  // Intentionally do not fetch third-party prompt/instruction files at runtime.
  // Callers fall back to the built-in wmux role prompts when no cached SOUL is
  // available, avoiding a supply-chain prompt-injection path into Claude PTYs.
  return null;
}

/**
 * Load SOUL with fallback: memory cache first, then fetch from GitHub.
 */
export async function loadSoul(presetId: string): Promise<string | null> {
  const cached = loadSoulSync(presetId);
  if (cached) return cached;
  return fetchSoul(presetId);
}

/**
 * Runtime network fetching is disabled, so no SOULs are prefetched.
 * Returns the count of successfully loaded souls (always zero).
 */
export async function prefetchSouls(_presetIds: string[]): Promise<number> {
  void _presetIds;
  // Runtime remote SOUL loading is disabled; there is nothing to prefetch.
  return 0;
}

// ─── Soul Condensing ─────────────────────────────────────────────────────────

/**
 * Extract the core persona sections from a raw SOUL markdown file.
 * Strips frontmatter, code blocks, and verbose examples to keep prompt size
 * reasonable (~3000 chars). Focuses on identity, mission, rules, and workflow.
 */
export function condenseSoul(raw: string): string {
  // Remove YAML frontmatter
  let content = raw.replace(/^---[\s\S]*?---\n*/m, '');

  // Remove code blocks (examples are too verbose for prompts)
  content = content.replace(/```[\s\S]*?```/g, '');

  // Remove HTML comments
  content = content.replace(/<!--[\s\S]*?-->/g, '');

  // Extract key sections by heading
  const sections: string[] = [];
  const sectionPattern = /^## .+$/gm;
  const matches = [...content.matchAll(sectionPattern)];

  const keepSections = [
    'identity',
    'memory',
    'core mission',
    'critical rules',
    'workflow',
    'development philosophy',
    'your role',
    'responsibilities',
    'deliverable',
    'key principles',
    'operating principles',
    'approach',
    'persona',
    'mindset',
  ];

  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][0].toLowerCase();
    if (keepSections.some((s) => heading.includes(s))) {
      const start = matches[i].index!;
      const end =
        i + 1 < matches.length ? matches[i + 1].index! : content.length;
      sections.push(content.slice(start, end).trim());
    }
  }

  if (sections.length === 0) {
    // Fallback: use the first 2000 chars of the cleaned content
    return content.slice(0, 2000).trim();
  }

  // Join extracted sections and cap at ~3000 chars
  let result = sections.join('\n\n');
  if (result.length > 3000) {
    result = result.slice(0, 3000).trim() + '\n\n[... condensed for prompt size]';
  }

  return result;
}

/**
 * Do not write third-party SOUL content into .claude/CLAUDE.md.
 * Returns false so company spawning continues with the built-in role prompt.
 */
export async function writeSoulToFile(_presetId: string, _workDir: string): Promise<boolean> {
  void _presetId;
  void _workDir;
  // Do not install remotely sourced SOUL files as Claude instruction files.
  return false;
}

/**
 * Clear the in-memory soul cache. Useful for testing or forced refresh.
 */
export function clearSoulCache(): void {
  soulCache.clear();
}
