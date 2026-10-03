// Source-level guards for #1688: jsdom cannot reproduce Chromium's caret
// reveal scrolling an overflow:hidden ancestor. Keep the root shell clipped
// and the sheet clipped, with the scroll-pin backstop wired before React mounts.
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'Layout', 'AppLayout.tsx'), 'utf8');
const entry = fs.readFileSync(path.join(__dirname, '..', 'index.tsx'), 'utf8');
const stylesDir = path.join(__dirname, '..', 'styles');
const styles = fs.readdirSync(stylesDir).filter((name) => name.endsWith('.css'))
  .map((name) => fs.readFileSync(path.join(stylesDir, name), 'utf8')).join('\n');
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
    expectInstallBeforeMount(entry);
  });

  it('finds createRoot by AST, so a reformatted mount still passes', () => {
    expectInstallBeforeMount("installChromeScrollPin();\nconst container = document.getElementById('root')!;\nconst root = createRoot(\n  container,\n);");
    expect(() => expectInstallBeforeMount("createRoot(\n  el);\ninstallChromeScrollPin();")).toThrow();
    expect(() => expectInstallBeforeMount('createRoot(el);')).toThrow(/installChromeScrollPin/);
    expect(() => expectInstallBeforeMount('installChromeScrollPin();')).toThrow(/createRoot/);
  });

  it('clips the sheet that holds the parked agent toolbar (#1733)', () => {
    expectSheetClipped(styles);
  });

  it('rejects a sheet overflow override inside an at-rule or behind an ancestor selector', () => {
    const base = '.wmux-shell-body { overflow: clip; }\n';
    expectSheetClipped(base);
    expect(() => expectSheetClipped(`${base}@media (max-width: 600px) { .wmux-shell-body { overflow: hidden; } }`)).toThrow();
    expect(() => expectSheetClipped(`${base}@supports (display: grid) { @container (width > 1px) { .wmux-shell-body.flex-row-reverse { overflow-y: auto; } } }`)).toThrow();
    expect(() => expectSheetClipped(`${base}html[data-fullscreen] .wmux-shell-body { overflow-x: scroll; }`)).toThrow();
    expect(() => expectSheetClipped(`${base}.wmux-shell-body:has(.foo .bar) { overflow: hidden; }`)).toThrow();
    expect(() => expectSheetClipped(`${base}main > .wmux-shell-body:not(:has(.a > .b)) { overflow-y: auto; }`)).toThrow();
    expect(() => expectSheetClipped(`${base}:is(.wmux-shell-body) { overflow: hidden; }`)).toThrow();
    expect(() => expectSheetClipped(`${base}:where(.x, html .wmux-shell-body) { overflow-y: auto; }`)).toThrow();
    expect(() => expectSheetClipped('@media print { .wmux-shell-body { overflow: clip; } }')).toThrow();
    // A descendant of the sheet is a different box and may scroll, and so may
    // an ancestor that only mentions the sheet inside :has().
    expectSheetClipped(`${base}.wmux-shell-body .wmux-fleet-body { overflow-y: auto; }`);
    expectSheetClipped(`${base}.wmux-shell-body:has(.x) .wmux-fleet-body { overflow-y: auto; }`);
    expectSheetClipped(`${base}.wmux-frame:has(.wmux-shell-body) { overflow: hidden; }`);
    expectSheetClipped(`${base}:is(.wmux-frame):not(.wmux-shell-body) { overflow: hidden; }`);
    expectSheetClipped(`${base}:is(.a:has(.wmux-shell-body)) { overflow: hidden; }`);
  });
});

/** installChromeScrollPin() runs as a top-level statement before the createRoot call. */
function expectInstallBeforeMount(text: string): void {
  const file = ts.createSourceFile('index.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const install = file.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(file) === 'installChromeScrollPin');
  let mount: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (!mount && ts.isCallExpression(node) && node.expression.getText(file) === 'createRoot') mount = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!install) throw new Error('installChromeScrollPin() is missing from the renderer entry');
  if (!mount) throw new Error('createRoot() is missing from the renderer entry');
  expect(install.getStart(file)).toBeLessThan(mount.getStart(file));
}

/**
 * Every rule whose selector targets the sheet box itself (the last compound
 * selector names .wmux-shell-body, any ancestors allowed, at-rules included)
 * may only set overflow to clip, and an unconditional rule must declare it.
 */
function expectSheetClipped(css: string): void {
  // Rewrite pseudo-class arguments before finding the last compound, so a
  // combinator inside one cannot be mistaken for that compound's boundary.
  // `:is()`/`:where()` match the subject itself: their argument is kept, with
  // its combinators dropped. Every other argument (`:has()` names a related
  // element, `:not()` excludes the sheet) is blanked out, nested ones too.
  const SUBJECT_PSEUDOS = /:(?:is|where|matches|-webkit-any|-moz-any)$/;
  const stripArgs = (selector: string) => {
    let out = '';
    const keep: boolean[] = [];
    for (const ch of selector) {
      const kept = keep.every(Boolean);
      if (ch === '(') {
        keep.push(kept && SUBJECT_PSEUDOS.test(out));
        continue;
      }
      if (ch === ')' && keep.length > 0) {
        keep.pop();
        continue;
      }
      if (!kept) continue;
      if (keep.length > 0 && /[\s>+~,]/.test(ch)) continue;
      out += ch;
    }
    return out;
  };
  const targetsSheet = (selector: string) =>
    /\.wmux-shell-body(?![\w-])/.test(stripArgs(selector).trim().split(/\s*[\s>+~]\s*/).pop() ?? '');
  let clipped = false;
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selectors.some(targetsSheet)) return;
    rule.walkDecls(/^overflow(-[xy])?$/, (decl) => {
      expect(decl.value.trim().split(/\s+/), `${rule.selector} { ${decl.prop}: ${decl.value} }`).toEqual(
        decl.value.trim().split(/\s+/).map(() => 'clip'));
      if (decl.prop === 'overflow' && rule.parent?.type === 'root') clipped = true;
    });
  });
  if (!clipped) throw new Error('no unconditional .wmux-shell-body rule declares overflow: clip');
}
