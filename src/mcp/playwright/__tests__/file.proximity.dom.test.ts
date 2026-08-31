// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { findFileInputNearElement } from '../tools/file';

// The search runs inside the page, so its rules are tested against a real DOM
// rather than a mock. Shapes taken from actual styled uploaders.

function mount(html: string): void {
  document.body.innerHTML = html;
}

function idOf(node: unknown): string | null {
  return (node as { id?: string } | null)?.id ?? null;
}

describe('findFileInputNearElement', () => {
  it('finds the hidden sibling input of a styled upload button', () => {
    mount(`
      <form id="mine">
        <div class="uploader">
          <button type="button" id="pick">Choose a file…</button>
          <input type="file" id="hidden-input" style="display:none">
        </div>
      </form>
    `);
    expect(idOf(findFileInputNearElement(document.getElementById('pick')))).toBe('hidden-input');
  });

  it('returns the element itself when it already is a file input', () => {
    mount('<input type="file" id="direct">');
    expect(idOf(findFileInputNearElement(document.getElementById('direct')))).toBe('direct');
  });

  it('reaches an input nested under an ancestor, within the depth limits', () => {
    mount(`
      <div id="widget">
        <div><div><button id="pick">Upload</button></div></div>
        <div><input type="file" id="deep-input"></div>
      </div>
    `);
    expect(idOf(findFileInputNearElement(document.getElementById('pick')))).toBe('deep-input');
  });

  it('never crosses into another form', () => {
    mount(`
      <form id="mine"><button type="button" id="pick">Upload</button></form>
      <form id="other"><input type="file" id="other-input"></form>
    `);
    expect(findFileInputNearElement(document.getElementById('pick'))).toBeNull();
  });

  it('does not pull a formless anchor into a form input', () => {
    mount(`
      <div><button type="button" id="pick">Upload</button></div>
      <form id="other"><input type="file" id="other-input"></form>
    `);
    expect(findFileInputNearElement(document.getElementById('pick'))).toBeNull();
  });

  it('returns null when there is no file input anywhere near', () => {
    mount('<div><button id="pick">Upload</button></div>');
    expect(findFileInputNearElement(document.getElementById('pick'))).toBeNull();
  });
});
