import type { Page } from 'playwright-core';
import type { JsonEvaluator } from './page-eval';
import { evalFunctionOrRpc } from './page-eval';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionOptions {
  /** Maximum output length in characters (default 4000) */
  maxLength?: number;
  /** Include [text](url) links (default true) */
  includeLinks?: boolean;
  /** Include ![alt](src) images (default false) */
  includeImages?: boolean;
  /** Extract only from this CSS selector (e.g. 'main', 'article') */
  selector?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LENGTH = 4000;

/** Elements stripped before conversion — typically non-content chrome */
const NOISE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'nav',
  'footer',
  'header',
  'aside',
  'svg',
  'iframe',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
];

// ---------------------------------------------------------------------------
// Lightweight HTML → Markdown converter (runs in Node, not in-page)
// ---------------------------------------------------------------------------

/**
 * Minimal recursive converter that walks a serialised DOM structure
 * produced by page.evaluate and emits markdown text.
 *
 * The DOM is serialised to a plain-object tree in the browser context
 * to avoid transferring raw HTML strings and re-parsing in Node.
 */

interface SerializedNode {
  /** 1 = ELEMENT_NODE, 3 = TEXT_NODE */
  type: number;
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
  children?: SerializedNode[];
}

function convertNode(
  node: SerializedNode,
  includeLinks: boolean,
  includeImages: boolean,
): string {
  if (node.type === 3) {
    // Text node — collapse whitespace
    return (node.text ?? '').replace(/[ \t]+/g, ' ');
  }

  if (node.type !== 1 || !node.tag) return '';

  const tag = node.tag;
  const children = node.children ?? [];
  const inner = children
    .map((c) => convertNode(c, includeLinks, includeImages))
    .join('');

  switch (tag) {
    // Headings
    case 'H1':
      return `\n\n# ${inner.trim()}\n\n`;
    case 'H2':
      return `\n\n## ${inner.trim()}\n\n`;
    case 'H3':
      return `\n\n### ${inner.trim()}\n\n`;
    case 'H4':
      return `\n\n#### ${inner.trim()}\n\n`;
    case 'H5':
      return `\n\n##### ${inner.trim()}\n\n`;
    case 'H6':
      return `\n\n###### ${inner.trim()}\n\n`;

    // Paragraphs & divs
    case 'P':
      return `\n\n${inner.trim()}\n\n`;
    case 'DIV':
    case 'SECTION':
    case 'ARTICLE':
    case 'MAIN':
      return `\n${inner}\n`;

    // Inline formatting
    case 'STRONG':
    case 'B':
      return `**${inner.trim()}**`;
    case 'EM':
    case 'I':
      return `*${inner.trim()}*`;
    case 'CODE':
      return `\`${inner.trim()}\``;
    case 'DEL':
    case 'S':
      return `~~${inner.trim()}~~`;

    // Line break
    case 'BR':
      return '\n';
    case 'HR':
      return '\n\n---\n\n';

    // Links
    case 'A': {
      const href = node.attrs?.['href'] ?? '';
      const text = inner.trim();
      if (!text) return '';
      if (includeLinks && href && !href.startsWith('javascript:')) {
        return `[${text}](${href})`;
      }
      return text;
    }

    // Images
    case 'IMG': {
      if (!includeImages) return '';
      const alt = node.attrs?.['alt'] ?? '';
      const src = node.attrs?.['src'] ?? '';
      return `![${alt}](${src})`;
    }

    // Lists
    case 'UL':
    case 'OL':
      return `\n${inner}\n`;
    case 'LI':
      return `- ${inner.trim()}\n`;

    // Blockquote
    case 'BLOCKQUOTE': {
      const lines = inner.trim().split('\n');
      return '\n\n' + lines.map((l) => `> ${l}`).join('\n') + '\n\n';
    }

    // Pre-formatted / code blocks
    case 'PRE': {
      // If there is a single <code> child, extract its text directly
      const codeChild = children.find((c) => c.tag === 'CODE');
      const codeText = codeChild
        ? children.map((c) => convertNode(c, false, false)).join('')
        : inner;
      return `\n\n\`\`\`\n${codeText.trim()}\n\`\`\`\n\n`;
    }

    // Tables
    case 'TABLE':
      return `\n\n${convertTable(children, includeLinks, includeImages)}\n\n`;

    // Table sub-elements handled by convertTable; skip here
    case 'THEAD':
    case 'TBODY':
    case 'TFOOT':
    case 'TR':
    case 'TH':
    case 'TD':
      return inner;

    // Ignore certain tags entirely
    case 'SCRIPT':
    case 'STYLE':
    case 'NOSCRIPT':
      return '';

    // Default — pass through inner text
    default:
      return inner;
  }
}

// ---------------------------------------------------------------------------
// Table conversion
// ---------------------------------------------------------------------------

function collectRows(
  nodes: SerializedNode[],
): SerializedNode[][] {
  const rows: SerializedNode[][] = [];

  function walk(list: SerializedNode[]): void {
    for (const n of list) {
      if (n.tag === 'TR') {
        rows.push(n.children ?? []);
      } else if (n.children) {
        walk(n.children);
      }
    }
  }

  walk(nodes);
  return rows;
}

function cellText(
  cell: SerializedNode,
  includeLinks: boolean,
  includeImages: boolean,
): string {
  return convertNode(cell, includeLinks, includeImages)
    .replace(/\n/g, ' ')
    .trim();
}

function convertTable(
  children: SerializedNode[],
  includeLinks: boolean,
  includeImages: boolean,
): string {
  const rows = collectRows(children);
  if (rows.length === 0) return '';

  const matrix = rows.map((cells) =>
    cells.map((c) => cellText(c, includeLinks, includeImages)),
  );

  // Determine column widths
  const colCount = Math.max(...matrix.map((r) => r.length));
  const normalized = matrix.map((row) => {
    while (row.length < colCount) row.push('');
    return row;
  });

  // First row is header
  const headerRow = normalized[0];
  const separator = headerRow.map(() => '---');
  const lines = [
    '| ' + headerRow.join(' | ') + ' |',
    '| ' + separator.join(' | ') + ' |',
  ];

  for (let i = 1; i < normalized.length; i++) {
    lines.push('| ' + normalized[i].join(' | ') + ' |');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

function cleanMarkdown(md: string, maxLength: number): string {
  let result = md
    // Collapse 3+ newlines into 2
    .replace(/\n{3,}/g, '\n\n')
    // Remove leading/trailing whitespace on each line
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();

  if (result.length > maxLength) {
    result = result.slice(0, maxLength) + '\n... (truncated)';
  }

  return result;
}

// ---------------------------------------------------------------------------
// Browser-side serialisation function
// ---------------------------------------------------------------------------

/**
 * Returns a string that, when evaluated inside the browser, serialises the
 * DOM rooted at `rootSelector` into a JSON-safe tree structure.
 *
 * Noise elements are stripped before serialisation.
 */
function buildSerialiseScript(
  rootSelector: string | null,
  noiseSelectors: string[],
): string {
  // The function body runs inside the browser context
  return `
    (() => {
      const NOISE = ${JSON.stringify(noiseSelectors)};
      const root = ${rootSelector ? `document.querySelector(${JSON.stringify(rootSelector)})` : 'document.body'};
      if (!root) return null;

      // Remove noise elements
      for (const sel of NOISE) {
        for (const el of root.querySelectorAll(sel)) {
          el.remove();
        }
      }

      function serialise(node) {
        if (node.nodeType === 3) {
          const text = node.textContent || '';
          if (!text.trim()) return null;
          return { type: 3, text };
        }
        if (node.nodeType !== 1) return null;

        const el = node;
        const tag = el.tagName;
        const attrs = {};
        if (el.hasAttribute('href')) attrs['href'] = el.getAttribute('href');
        if (el.hasAttribute('src')) attrs['src'] = el.getAttribute('src');
        if (el.hasAttribute('alt')) attrs['alt'] = el.getAttribute('alt');

        const children = [];
        for (const child of el.childNodes) {
          const s = serialise(child);
          if (s) children.push(s);
        }

        return { type: 1, tag, attrs, children };
      }

      return serialise(root);
    })()
  `;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract page content as clean markdown.
 *
 * Strips navigation, footer, ad, and other non-content elements, then
 * converts the remaining HTML structure into readable markdown text.
 *
 * Takes a JsonEvaluator rather than a Page so the same logic serves both the
 * Playwright transport and the packaged-build RPC fallback (issue #105). The
 * in-page work is a string script (buildSerialiseScript), so neither transport
 * changes behavior.
 */
export async function extractMarkdown(
  evaluate: JsonEvaluator,
  options?: ExtractionOptions,
): Promise<string> {
  const selector = options?.selector ?? null;
  const script = buildSerialiseScript(selector, NOISE_SELECTORS);
  const tree = (await evaluate(script)) as SerializedNode | null;
  return treeToMarkdown(tree, options);
}

/**
 * Convert a serialised DOM tree (the output of buildSerialiseScript) into clean
 * markdown. Pure Node-side logic — split out from extractMarkdown so it can be
 * unit-tested against a canned tree without a browser.
 */
export function treeToMarkdown(
  tree: SerializedNode | null,
  options?: ExtractionOptions,
): string {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;
  const includeLinks = options?.includeLinks ?? true;
  const includeImages = options?.includeImages ?? false;

  if (!tree) {
    return '';
  }

  const raw = convertNode(tree, includeLinks, includeImages);
  return cleanMarkdown(raw, maxLength);
}

// ---------------------------------------------------------------------------
// Structured data extraction
// ---------------------------------------------------------------------------

/**
 * Extract structured data from a page based on a goal description and
 * a set of field definitions.
 *
 * Uses heuristic DOM parsing (NOT LLM) to find repeated data patterns
 * such as tables, lists, or repeated elements and maps them to the
 * requested fields.
 *
 * @param page      Playwright Page, or null to use the RPC fallback (issue #105)
 * @param surfaceId Optional surface to target on the RPC path
 * @param goal      Human-readable description of what to extract (reserved;
 *                  not yet used to narrow scope)
 * @param fields    Mapping of field names to human descriptions, e.g.
 *                  `{ title: "product name", price: "price in USD" }`
 * @returns         Array of objects with keys matching `fields`
 */
export async function extractStructuredData(
  page: Page | null,
  surfaceId: string | undefined,
  goal: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  void goal; // reserved for future scope-narrowing; not yet used
  const fieldNames = Object.keys(fields);
  if (fieldNames.length === 0) return [];

  // Strategy 1: Try to extract from <table> elements
  const tableData = await extractFromTables(page, surfaceId, fieldNames);
  if (tableData.length > 0) return tableData;

  // Strategy 2: Try to extract from repeated list items
  const listData = await extractFromLists(page, surfaceId, fieldNames);
  if (listData.length > 0) return listData;

  // Strategy 3: Try to find repeated element patterns (grids, cards, etc.)
  const repeatedData = await extractFromRepeatedElements(page, surfaceId, fieldNames);
  if (repeatedData.length > 0) return repeatedData;

  return [];
}

// ---------------------------------------------------------------------------
// Table extraction
// ---------------------------------------------------------------------------

async function extractFromTables(
  page: Page | null,
  surfaceId: string | undefined,
  fieldNames: string[],
): Promise<Record<string, unknown>[]> {
  return await evalFunctionOrRpc(
    page,
    ({ fieldNames: names }: { fieldNames: string[] }) => {
      const tables = document.querySelectorAll('table');
      if (tables.length === 0) return [];

      for (const table of tables) {
        const rows = table.querySelectorAll('tr');
        if (rows.length < 2) continue;

        // Extract headers from first row
        const headerCells = rows[0].querySelectorAll('th, td');
        const headers: string[] = [];
        headerCells.forEach((cell) => {
          headers.push((cell.textContent ?? '').trim().toLowerCase());
        });

        if (headers.length === 0) continue;

        // Map requested field names to column indices
        const fieldToCol = new Map<string, number>();
        for (const name of names) {
          const lower = name.toLowerCase();
          // Exact match first
          let idx = headers.indexOf(lower);
          if (idx === -1) {
            // Partial match
            idx = headers.findIndex(
              (h) => h.includes(lower) || lower.includes(h),
            );
          }
          if (idx !== -1) {
            fieldToCol.set(name, idx);
          }
        }

        // If we matched at least one field, extract rows
        if (fieldToCol.size === 0) continue;

        const results: Record<string, unknown>[] = [];
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll('td, th');
          const record: Record<string, unknown> = {};
          let hasValue = false;

          for (const name of names) {
            const colIdx = fieldToCol.get(name);
            if (colIdx !== undefined && colIdx < cells.length) {
              const text = (cells[colIdx].textContent ?? '').trim();
              record[name] = text;
              if (text) hasValue = true;
            } else {
              record[name] = null;
            }
          }

          if (hasValue) results.push(record);
        }

        if (results.length > 0) return results;
      }

      return [];
    },
    { fieldNames },
    surfaceId,
  );
}

// ---------------------------------------------------------------------------
// List extraction
// ---------------------------------------------------------------------------

async function extractFromLists(
  page: Page | null,
  surfaceId: string | undefined,
  fieldNames: string[],
): Promise<Record<string, unknown>[]> {
  return await evalFunctionOrRpc(
    page,
    ({ fieldNames: names }: { fieldNames: string[] }) => {
      const lists = document.querySelectorAll('ul, ol');
      if (lists.length === 0) return [];

      // Find the largest list with enough items
      let bestList: Element | null = null;
      let bestCount = 0;

      for (const list of lists) {
        const items = list.querySelectorAll(':scope > li');
        if (items.length > bestCount) {
          bestCount = items.length;
          bestList = list;
        }
      }

      if (!bestList || bestCount < 2) return [];

      const items = bestList.querySelectorAll(':scope > li');
      const results: Record<string, unknown>[] = [];

      for (const item of items) {
        const record: Record<string, unknown> = {};
        const text = (item.textContent ?? '').trim();
        if (!text) continue;

        if (names.length === 1) {
          // Single field — map entire text
          record[names[0]] = text;
        } else {
          // Multiple fields — try splitting by common delimiters or child elements
          const childElements = item.querySelectorAll('*');
          const textSegments: string[] = [];

          if (childElements.length > 0) {
            // Use direct child elements' text
            const directChildren = item.children;
            for (const child of directChildren) {
              const t = (child.textContent ?? '').trim();
              if (t) textSegments.push(t);
            }
          }

          if (textSegments.length === 0) {
            // Split on common delimiters
            textSegments.push(...text.split(/\s*[|–—:,]\s*/).filter(Boolean));
          }

          for (let i = 0; i < names.length; i++) {
            record[names[i]] = i < textSegments.length ? textSegments[i] : null;
          }
        }

        results.push(record);
      }

      return results;
    },
    { fieldNames },
    surfaceId,
  );
}

// ---------------------------------------------------------------------------
// Repeated-element extraction (cards, grids, etc.)
// ---------------------------------------------------------------------------

async function extractFromRepeatedElements(
  page: Page | null,
  surfaceId: string | undefined,
  fieldNames: string[],
): Promise<Record<string, unknown>[]> {
  return await evalFunctionOrRpc(
    page,
    ({ fieldNames: names }: { fieldNames: string[] }) => {
      // Find class names that appear 3+ times, suggesting repeated items
      const classCount = new Map<string, number>();
      const allElements = document.querySelectorAll('div, li, article, section');

      for (const el of allElements) {
        const cls = el.className;
        if (typeof cls === 'string' && cls.trim()) {
          const key = el.tagName + '.' + cls.trim();
          classCount.set(key, (classCount.get(key) ?? 0) + 1);
        }
      }

      // Sort by count descending, pick the most repeated pattern with 3+ items
      const candidates = [...classCount.entries()]
        .filter(([, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1]);

      for (const [tagClass] of candidates) {
        const dotIdx = tagClass.indexOf('.');
        const tag = tagClass.slice(0, dotIdx);
        const cls = tagClass.slice(dotIdx + 1);

        // Build selector: tag.class1.class2...
        const classes = cls.split(/\s+/).filter(Boolean);
        const sel = tag.toLowerCase() + classes.map((c) => '.' + CSS.escape(c)).join('');

        let elements: NodeListOf<Element>;
        try {
          elements = document.querySelectorAll(sel);
        } catch {
          continue;
        }

        if (elements.length < 3) continue;

        const results: Record<string, unknown>[] = [];

        for (const el of elements) {
          const record: Record<string, unknown> = {};
          let hasValue = false;

          for (const name of names) {
            const lower = name.toLowerCase();

            // Try to find a child element whose class/tag/aria-label hints at the field
            let value: string | null = null;

            // Check common patterns: heading elements for title-like fields
            if (/title|name|heading/i.test(lower)) {
              const heading =
                el.querySelector('h1, h2, h3, h4, h5, h6') ??
                el.querySelector('[class*="title"], [class*="name"], [class*="heading"]');
              if (heading) value = (heading.textContent ?? '').trim();
            }

            // Price-like fields
            if (!value && /price|cost|amount/i.test(lower)) {
              const priceEl = el.querySelector(
                '[class*="price"], [class*="cost"], [class*="amount"]',
              );
              if (priceEl) value = (priceEl.textContent ?? '').trim();
            }

            // Description-like fields
            if (!value && /desc|summary|text|content/i.test(lower)) {
              const descEl = el.querySelector(
                'p, [class*="desc"], [class*="summary"], [class*="text"]',
              );
              if (descEl) value = (descEl.textContent ?? '').trim();
            }

            // Link / URL fields
            if (!value && /link|url|href/i.test(lower)) {
              const anchor = el.querySelector('a[href]');
              if (anchor) value = anchor.getAttribute('href');
            }

            // Image fields
            if (!value && /image|img|photo|src/i.test(lower)) {
              const img = el.querySelector('img[src]');
              if (img) value = img.getAttribute('src');
            }

            // Fallback: use full text for first unmatched field
            if (!value) {
              value = (el.textContent ?? '').trim().slice(0, 200);
            }

            record[name] = value || null;
            if (value) hasValue = true;
          }

          if (hasValue) results.push(record);
        }

        if (results.length > 0) return results;
      }

      return [];
    },
    { fieldNames },
    surfaceId,
  );
}
