import fs from 'node:fs';

/**
 * A repository source file's text with LF line endings, whatever the
 * checkout. Git's core.autocrlf (on by default on Windows, and on the
 * windows-latest runners) checks text files out with CRLF, one more character
 * per line, so a source-level test that measures or slices the text found a
 * different answer on Windows than on Linux: `source.slice(at, at + 500)` held
 * 7 fewer lines' worth of code. Tests that read source to pin its wiring read
 * it through this, so they see the same text on every OS.
 */
export function readSourceText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The source from `index` through the end of the first `{ ... }` block that
 * starts at or after it: for `src.indexOf('const startResync')`, that
 * function's whole body. Use it instead of `src.slice(index, index + N)`
 * when a test means "inside this function": a character count is a guess at
 * the body's length that one added line can push past, while this ends where
 * the body ends. Braces inside comments and string or template literals are
 * skipped (a template's `${...}` counts as code), and so is a brace in a
 * parameter or type position (right after `(`, `,`, `:` or `<`), so that
 * `({ id }: { id: string }) => {` yields the body, not the pattern. A regex
 * literal holding an unbalanced brace would throw it off, which no current
 * caller has. Throws when there is no block or it never closes, so a moved
 * anchor fails loudly.
 */
export function blockAt(source: string, index: number): string {
  if (index < 0) throw new Error('blockAt: anchor not found');
  let depth = 0;
  let opened = false;
  // Depth inside a destructuring pattern or an object type before the body.
  let pattern = 0;
  // Template literals nest: each entry is the brace depth its `${` opened at.
  const templates: number[] = [];
  let i = index;
  const skipString = (quote: string) => {
    for (i++; i < source.length && source[i] !== quote; i++) if (source[i] === '\\') i++;
  };
  const skipTemplate = (): boolean => {
    // Returns true when it stopped at a `${` (code resumes), false at the closing backtick.
    for (i++; i < source.length; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === '`') return false;
      else if (source[i] === '$' && source[i + 1] === '{') {
        i++;
        return true;
      }
    }
    return false;
  };
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
    } else if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      if (i <= 0) break;
    } else if (ch === "'" || ch === '"') {
      skipString(ch);
    } else if (ch === '`') {
      if (skipTemplate()) templates.push(++depth);
    } else if (ch === '{' && !opened && (pattern > 0 || /[(,:<]\s*$/.test(source.slice(index, i)))) {
      pattern++;
    } else if (ch === '}' && pattern > 0) {
      pattern--;
    } else if (ch === '{') {
      depth++;
      opened = true;
    } else if (ch === '}') {
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        depth--;
        if (skipTemplate()) templates.push(++depth);
        continue;
      }
      depth--;
      if (opened && depth === 0) return source.slice(index, i + 1);
    }
  }
  throw new Error(`blockAt: no complete block after index ${index}`);
}
