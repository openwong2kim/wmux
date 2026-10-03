// Source-level guards for #1688: jsdom cannot reproduce Chromium's caret
// reveal scrolling an overflow:hidden ancestor. Keep the root shell clipped
// and the sheet clipped, with the scroll-pin backstop wired before React mounts.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'Layout', 'AppLayout.tsx'), 'utf8');
const entry = fs.readFileSync(path.join(__dirname, '..', 'index.tsx'), 'utf8');
const uiCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tree = ts.createSourceFile('AppLayout.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function rootShell(): ts.JsxOpeningElement {
  let shell: ts.JsxOpeningElement | undefined;
  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'ErrorBoundary'
      && node.openingElement.attributes.properties.some((attr) => ts.isJsxAttribute(attr)
        && attr.name.getText(tree) === 'name' && attr.initializer
        && ts.isStringLiteral(attr.initializer) && attr.initializer.text === 'AppLayout')) {
      shell = node.children.find(ts.isJsxElement)?.openingElement;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!shell) throw new Error('AppLayout root shell is missing');
  return shell;
}

describe('app chrome overflow guard (#1688)', () => {
  it('clips the root shell without creating a scroll container', () => {
    const attr = rootShell().attributes.properties.find((attr) => ts.isJsxAttribute(attr)
      && attr.name.getText(tree) === 'className') as ts.JsxAttribute;
    expect(attr?.initializer && ts.isStringLiteral(attr.initializer)).toBe(true);
    const classes = (attr.initializer as ts.StringLiteral).text.split(/\s+/);
    expect(classes).toContain('overflow-clip');
    expect(classes.filter((name) => /^(?:.*:)?overflow(?:-[xy])?-/.test(name))).toEqual(['overflow-clip']);
  });

  it('keeps the scroll-pin marker on that same root shell', () => {
    expect(rootShell().attributes.properties.some((attr) => ts.isJsxAttribute(attr)
      && attr.name.getText(tree) === 'data-pin-scroll')).toBe(true);
  });

  it('installs the scroll-pin backstop before mounting React', () => {
    const entryTree = ts.createSourceFile('index.tsx', entry, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const install = entryTree.statements.find((node) => ts.isExpressionStatement(node)
      && ts.isCallExpression(node.expression) && node.expression.expression.getText(entryTree) === 'installChromeScrollPin');
    if (!install) throw new Error('scroll-pin installation is missing');
    expect(install.getStart(entryTree)).toBeLessThan(entry.indexOf('createRoot(document.'));
  });

  it('clips the sheet that holds the parked agent toolbar (#1733)', () => {
    // Declaration blocks whose selector targets the sheet itself, not a descendant.
    const blocks = [...uiCss.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, selector]) => selector.split(',').some((part) => /\.wmux-shell-body(?![\w-])[^\s>+~]*$/.test(part.trim())))
      .map(([, , body]) => body);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((body) => /overflow:\s*clip\b/.test(body))).toBe(true);
    for (const body of blocks) expect(body).not.toMatch(/overflow(-[xy])?:\s*(hidden|visible|scroll|auto)\b/);
  });
});
