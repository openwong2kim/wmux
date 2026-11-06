// Lists the literal constants of integrations/claude/bin/wmux-bridge.mjs: every
// `const NAME = <literal>` with an UPPER_CASE name, at any depth, whose value
// can be read without running the file (numbers, strings, arrays, objects,
// `new Set([...])`, regex literals, and arithmetic on numbers). One declared
// inside a function is listed as `function.NAME`.
//
//   node scripts/extract-claude-bridge-constants.mjs           print them as JSON
//   node scripts/extract-claude-bridge-constants.mjs --write   refresh the snapshot
//
// The snapshot (integrations/claude/__tests__/fixtures/claude-hook/constants.json)
// is the bridge's numeric and textual contract — budgets, caps, the hook table,
// the client name — so a port can be checked against it value by value.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE = path.join(ROOT, 'integrations/claude/bin/wmux-bridge.mjs');
export const SNAPSHOT = path.join(ROOT, 'integrations/claude/__tests__/fixtures/claude-hook/constants.json');

const NOT_LITERAL = Symbol('not-literal');

function literal(node) {
  if (ts.isParenthesizedExpression(node)) return literal(node.expression);
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isRegularExpressionLiteral(node)) return { regex: node.text };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const value = literal(node.operand);
    return typeof value === 'number' ? -value : NOT_LITERAL;
  }
  if (ts.isBinaryExpression(node)) {
    const left = literal(node.left);
    const right = literal(node.right);
    if (typeof left !== 'number' || typeof right !== 'number') return NOT_LITERAL;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      default: return NOT_LITERAL;
    }
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(literal);
    return items.includes(NOT_LITERAL) ? NOT_LITERAL : items;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop) || ts.isComputedPropertyName(prop.name)) return NOT_LITERAL;
      const value = literal(prop.initializer);
      if (value === NOT_LITERAL) return NOT_LITERAL;
      out[prop.name.text] = value;
    }
    return out;
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Set') {
    const [arg] = node.arguments ?? [];
    const items = arg ? literal(arg) : [];
    return Array.isArray(items) ? { set: items } : NOT_LITERAL;
  }
  return NOT_LITERAL;
}

function enclosingFunction(node) {
  for (let up = node.parent; up; up = up.parent) {
    if (ts.isFunctionDeclaration(up) && up.name) return up.name.text;
  }
  return null;
}

/** The constants of `source`, sorted by name. Throws on a name declared twice. */
export function extractConstants(source) {
  const file = ts.createSourceFile('wmux-bridge.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = {};
  const visit = (node) => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const)) {
      for (const decl of node.declarations) {
        if (!ts.isIdentifier(decl.name) || !/^[A-Z][A-Z0-9_]*$/.test(decl.name.text) || !decl.initializer) continue;
        const value = literal(decl.initializer);
        if (value === NOT_LITERAL) continue;
        const scope = enclosingFunction(node);
        const name = scope ? `${scope}.${decl.name.text}` : decl.name.text;
        if (name in found) throw new Error(`constant ${name} is declared twice`);
        found[name] = value;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return Object.fromEntries(Object.keys(found).sort().map((name) => [name, found[name]]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = `${JSON.stringify(extractConstants(readFileSync(BRIDGE, 'utf8')), null, 2)}\n`;
  if (process.argv.includes('--write')) writeFileSync(SNAPSHOT, text);
  else process.stdout.write(text);
}
