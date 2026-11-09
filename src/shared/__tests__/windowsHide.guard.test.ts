// @wmux-lane unit
// Reads source text only and spawns nothing; it names win32 because that is what it looks for.
//
// Guard: no NEW child process that can flash a console window on Windows.
//
// wmux.exe is a GUI program, so a console program it starts opens a window of
// its own unless the call says `windowsHide: true` (Node's default is false).
// This test parses the non-test code under src/, counts per file the spawning
// calls it cannot show are hidden, and compares them with the snapshot in
// windowsHide.allowlist.json. It fails when
//   - a file that is not in the snapshot gains such a call, or
//   - a file in the snapshot has more of them than its snapshot count.
// Fewer always pass; lower the count in the snapshot when you fix some, so the
// room is not reused. The aim is "no new ones", not triaging the existing ones.
// If a new one really must show a window, regenerate and say why in the PR:
//
//   WMUX_UPDATE_WINDOWS_HIDE=1 npx vitest run src/shared/__tests__/windowsHide.guard.test.ts
//
// What is checked: calls to child_process's spawn, spawnSync, exec, execSync,
// execFile, execFileSync and fork, promisified aliases of them, and cross-spawn.
// One passes when its options, as a literal or a `const` object in the same
// file, say `windowsHide: true` with no spread after it.
//
// A shared wrapper passes on its own call: `spawn(cmd, args, { ...opts,
// windowsHide: true })` is hidden whatever its callers hand in, and they are
// not child_process calls, so they are not looked at. A wrapper whose options
// parameter is declared with a `windowsHide` field passes too: every caller has
// to write the field, in code a reader can see. A wrapper that forwards options
// the guard cannot read is counted, as is a spawn function passed around as a
// value (`deps.spawn ?? spawn`), because either can reach a console. A known gap:
// a caller handing `windowsHide: false` to a wrapper that requires the field.
//
// Code that cannot run on Windows does not count when the source says so where
// the call stands: inside `if (process.platform === 'darwin')`, or after an
// early exit such as `if (process.platform !== 'darwin') return;`. A Mac-only
// helper guarded only by its callers does count; the option is ignored off
// Windows, so adding it is the fix and costs nothing.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(SRC, '..');
const ALLOWLIST = path.join(__dirname, 'windowsHide.allowlist.json');

const SPAWNERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const COMMAND_THEN_OPTIONS = new Set(['exec', 'execSync']);
const MODULES = new Set(['child_process', 'node:child_process']);

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function requireOf(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  const call = unwrap(node);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'require') return null;
  const arg = call.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** `process.platform <op> '<name>'` as [op, name]. */
function platformCheck(node: ts.Expression): [string, string] | null {
  const expr = unwrap(node);
  if (!ts.isBinaryExpression(expr) || !ts.isStringLiteralLike(expr.right) || expr.left.getText() !== 'process.platform') return null;
  const op = expr.operatorToken.getText();
  return op === '===' || op === '!==' ? [op, expr.right.text] : null;
}

/** The condition being true means this is not Windows. */
function trueMeansOffWindows(node: ts.Expression): boolean {
  const expr = unwrap(node);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return trueMeansOffWindows(expr.left) || trueMeansOffWindows(expr.right);
  }
  const check = platformCheck(expr);
  return check !== null && (check[0] === '===' ? check[1] !== 'win32' : check[1] === 'win32');
}

/** The condition being false means this is not Windows. */
function falseMeansOffWindows(node: ts.Expression): boolean {
  const expr = unwrap(node);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return falseMeansOffWindows(expr.left) || falseMeansOffWindows(expr.right);
  }
  const check = platformCheck(expr);
  return check !== null && (check[0] === '===' ? check[1] === 'win32' : check[1] !== 'win32');
}

function exitsEarly(statement: ts.Statement): boolean {
  if (ts.isBlock(statement)) {
    const last = statement.statements[statement.statements.length - 1];
    return last !== undefined && exitsEarly(last);
  }
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
}

function isOffWindows(node: ts.Node): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) || ts.isConditionalExpression(parent)) {
      const [test, whenTrue, whenFalse] = ts.isIfStatement(parent)
        ? [parent.expression, parent.thenStatement, parent.elseStatement]
        : [parent.condition, parent.whenTrue, parent.whenFalse];
      if (child === whenTrue && trueMeansOffWindows(test)) return true;
      if (child === whenFalse && falseMeansOffWindows(test)) return true;
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      for (const statement of parent.statements) {
        if (statement === child) break;
        if (ts.isIfStatement(statement) && !statement.elseStatement && exitsEarly(statement.thenStatement) && falseMeansOffWindows(statement.expression)) return true;
      }
    }
  }
  return false;
}

/** A spread the source shows cannot carry the option: `...(env ? { env } : {})`. */
function spreadLeavesItAlone(node: ts.Expression): boolean {
  const expr = unwrap(node);
  if (ts.isConditionalExpression(expr)) return spreadLeavesItAlone(expr.whenTrue) && spreadLeavesItAlone(expr.whenFalse);
  return ts.isObjectLiteralExpression(expr)
    && expr.properties.every((p) => !ts.isSpreadAssignment(p) && p.name?.getText() !== 'windowsHide');
}

function hiddenLiteral(literal: ts.ObjectLiteralExpression): boolean {
  let hidden = false;
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) hidden = hidden && spreadLeavesItAlone(property.expression);
    else if (property.name?.getText() === 'windowsHide') {
      hidden = ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
  }
  return hidden;
}

function declaresWindowsHide(type: ts.TypeNode | undefined, file: ts.SourceFile): boolean {
  if (!type) return false;
  const required = (members: readonly ts.TypeElement[]) =>
    members.some((m) => ts.isPropertySignature(m) && m.name.getText() === 'windowsHide' && !m.questionToken);
  if (ts.isTypeLiteralNode(type)) return required(type.members);
  if (!ts.isTypeReferenceNode(type)) return false;
  const name = type.typeName.getText();
  return file.statements.some((s) =>
    (ts.isInterfaceDeclaration(s) && s.name.text === name && required(s.members))
    || (ts.isTypeAliasDeclaration(s) && s.name.text === name && declaresWindowsHide(s.type, file)));
}

/** What a name in this file was declared as: nearest enclosing scope first. */
function declarationOf(name: string, from: ts.Node): ts.VariableDeclaration | ts.ParameterDeclaration | null {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const param = scope.parameters.find((p) => p.name.getText() === name);
      if (param) return param;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const found = statement.declarationList.declarations.find((d) => d.name.getText() === name);
        if (found) return found;
      }
    }
  }
  return null;
}

function optionsHidden(node: ts.Expression | undefined, file: ts.SourceFile): boolean {
  if (!node) return false;
  const options = unwrap(node);
  if (ts.isObjectLiteralExpression(options)) return hiddenLiteral(options);
  if (!ts.isIdentifier(options)) return false;
  const declared = declarationOf(options.text, options);
  if (!declared) return false;
  if (ts.isParameter(declared)) return declaresWindowsHide(declared.type, file);
  return declared.initializer !== undefined && optionsHidden(declared.initializer, file);
}

function optionsArgument(name: string, args: readonly ts.Expression[]): ts.Expression | undefined {
  if (COMMAND_THEN_OPTIONS.has(name)) return args[1];
  const second = args[1] && unwrap(args[1]);
  return second && ts.isObjectLiteralExpression(second) ? second : args[2];
}

/** Calls in `source` that can show a console window on Windows, as `line: text`. */
function unhiddenSpawns(source: string, fileName = 'sample.ts'): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Local name -> child_process function it is; the module's own names ('*').
  const functions = new Map<string, string>();
  const modules = new Set<string>();
  const crossSpawn = new Set<string>();

  const noteImport = (statement: ts.ImportDeclaration) => {
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) return;
    if (from === 'cross-spawn') {
      if (clause.name) crossSpawn.add(clause.name.text);
      return;
    }
    if (!MODULES.has(from)) return;
    if (clause.name) modules.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && SPAWNERS.has(imported)) functions.set(element.name.text, imported);
      }
    }
  };

  /** The child_process function this expression names, if any. */
  const spawnerOf = (node: ts.Expression): string | null => {
    const expr = unwrap(node);
    if (ts.isIdentifier(expr)) return functions.get(expr.text) ?? null;
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && modules.has(expr.expression.text) && SPAWNERS.has(expr.name.text)) return expr.name.text;
    return null;
  };

  const collectAliases = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const required = requireOf(node.initializer);
      if (required && MODULES.has(required)) {
        if (ts.isIdentifier(node.name)) modules.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const imported = (element.propertyName ?? element.name).getText();
            if (ts.isIdentifier(element.name) && SPAWNERS.has(imported)) functions.set(element.name.text, imported);
          }
        }
      } else if (required === 'cross-spawn' && ts.isIdentifier(node.name)) crossSpawn.add(node.name.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  for (const statement of file.statements) if (ts.isImportDeclaration(statement)) noteImport(statement);
  collectAliases(file);
  // `const run = promisify(execFile)` is the same call under another name.
  const collectPromisified = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const init = unwrap(node.initializer);
      if (ts.isCallExpression(init) && /(^|\.)promisify$/.test(init.expression.getText()) && init.arguments[0]) {
        const target = spawnerOf(init.arguments[0]);
        if (target) functions.set(node.name.text, target);
      }
    }
    ts.forEachChild(node, collectPromisified);
  };
  collectPromisified(file);

  const found: string[] = [];
  const report = (node: ts.Node) => {
    if (isOffWindows(node)) return;
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${line + 1}: ${node.getText().split('\n')[0].slice(0, 100)}`);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isCallExpression(node)) {
      const name = spawnerOf(node.expression);
      if (name) {
        if (!optionsHidden(optionsArgument(name, node.arguments), file)) report(node);
        node.arguments.forEach(visit);
        return;
      }
      const callee = unwrap(node.expression);
      const isCross = (ts.isIdentifier(callee) && crossSpawn.has(callee.text))
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'sync' && ts.isIdentifier(callee.expression) && crossSpawn.has(callee.expression.text));
      if (isCross) {
        if (!optionsHidden(optionsArgument('spawn', node.arguments), file)) report(node);
        node.arguments.forEach(visit);
        return;
      }
      if (/(^|\.)promisify$/.test(callee.getText()) && node.arguments[0] && spawnerOf(node.arguments[0])) return;
    } else if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && spawnerOf(node)) {
      // A spawn function handed on as a value: whoever calls it is out of sight.
      const parent = node.parent;
      const isName = (ts.isVariableDeclaration(parent) && parent.name === node)
        || (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || ts.isParameter(parent) || ts.isBindingElement(parent);
      if (!isName) report(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'test-utils') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Spawning calls found per file, keyed by repo-relative forward-slash path. */
function scan(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of walk(SRC, []).sort()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('child_process') && !text.includes('cross-spawn')) continue;
    const calls = unhiddenSpawns(text, file);
    if (calls.length > 0) found[path.relative(REPO, file).split(path.sep).join('/')] = calls;
  }
  return found;
}

function readAllowlist(): Record<string, number> {
  return (JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) as { files: Record<string, number> }).files;
}

const IMPORT = "import { spawn, execFile, exec, execSync } from 'node:child_process';\n";

describe('windowsHide guard', () => {
  const found = scan();

  if (process.env.WMUX_UPDATE_WINDOWS_HIDE === '1') {
    fs.writeFileSync(ALLOWLIST, `${JSON.stringify({
      comment: 'Per-file count of spawning calls under src/ not shown to hide their console window. See windowsHide.guard.test.ts.',
      files: Object.fromEntries(Object.entries(found).map(([file, calls]) => [file, calls.length])),
    }, null, 2)}\n`);
  }

  describe('what it counts', () => {
    const count = (body: string, head = IMPORT) => unhiddenSpawns(head + body).length;

    it('a call with no options or without the option', () => {
      expect(count("spawn('a');")).toBe(1);
      expect(count("spawn('a', ['b'], { stdio: 'ignore' });")).toBe(1);
      expect(count("execSync('a', { encoding: 'utf8' });")).toBe(1);
      expect(count("execFile('a', ['b'], (e) => e);")).toBe(1);
    });

    it('the option set to something other than true', () => {
      expect(count("spawn('a', [], { windowsHide: false });")).toBe(1);
      expect(count("spawn('a', [], { windowsHide: hide });")).toBe(1);
    });

    it('options the file does not show', () => {
      expect(count("function f(o: object) { spawn('a', [], o); }")).toBe(1);
      expect(count("spawn('a', [], { windowsHide: true, ...o });")).toBe(1);
      expect(count("spawn('a', [], { windowsHide: true, ...(c ? { windowsHide: false } : {}) });")).toBe(1);
    });

    it('the other ways of reaching the same functions', () => {
      expect(count("cp.spawn('a');", "import * as cp from 'child_process';\n")).toBe(1);
      expect(count("cp.execFileSync('a');", "import cp from 'node:child_process';\n")).toBe(1);
      expect(count("run('a');", "import { spawn as run } from 'child_process';\n")).toBe(1);
      expect(count("spawn('a');", '')).toBe(0);
      expect(count("const { spawn } = require('child_process');\nspawn('a');", '')).toBe(1);
      expect(count("launch('a', []);", "import launch from 'cross-spawn';\n")).toBe(1);
      expect(count("launch.sync('a', []);", "import launch from 'cross-spawn';\n")).toBe(1);
    });

    it('a promisified alias', () => {
      expect(count("const run = promisify(execFile);\nawait run('a', ['b']);")).toBe(1);
      expect(count("const run = promisify(execFile);\nawait run('a', ['b'], { windowsHide: true });")).toBe(0);
    });

    it('a spawn function handed on as a value', () => {
      expect(count('const deps = { run: execFile };')).toBe(1);
      expect(count('use(spawn);')).toBe(1);
    });
  });

  describe('what it lets through', () => {
    const count = (body: string) => unhiddenSpawns(IMPORT + body).length;

    it('the option on the call, in any argument position', () => {
      expect(count("spawn('a', ['b'], { windowsHide: true });")).toBe(0);
      expect(count("spawn('a', { windowsHide: true });")).toBe(0);
      expect(count("exec('a', { windowsHide: true }, (e) => e);")).toBe(0);
      expect(count("execFile('a', [], { windowsHide: true }, (e) => e);")).toBe(0);
    });

    it('a wrapper that sets it after what its caller hands in', () => {
      expect(count("function run(o: object) { spawn('a', [], { ...o, windowsHide: true }); }")).toBe(0);
      expect(count("spawn('a', [], { windowsHide: true, ...(env ? { env } : {}) });")).toBe(0);
    });

    it('a const in the same file', () => {
      expect(count("const o = { windowsHide: true };\nspawn('a', [], o);")).toBe(0);
      expect(count("const o = { stdio: 'ignore' };\nspawn('a', [], o);")).toBe(1);
    });

    it('a wrapper whose options must carry the field', () => {
      expect(count("function run(o: { windowsHide: boolean }) { spawn('a', [], o); }")).toBe(0);
      expect(count("function run(o: { windowsHide?: boolean }) { spawn('a', [], o); }")).toBe(1);
      expect(count("interface O { windowsHide: boolean }\nfunction run(o: O) { spawn('a', [], o); }")).toBe(0);
    });

    it('a call the source shows cannot run on Windows', () => {
      expect(count("if (process.platform === 'darwin') { spawn('a'); }")).toBe(0);
      expect(count("if (process.platform !== 'win32') spawn('a');")).toBe(0);
      expect(count("if (process.platform === 'win32') { x(); } else { spawn('a'); }")).toBe(0);
      expect(count("function f() { if (process.platform !== 'darwin') return; spawn('a'); }")).toBe(0);
      expect(count("function f() { if (process.platform === 'win32') { return 1; } spawn('a'); }")).toBe(0);
      expect(count("const c = process.platform === 'linux' ? spawn('a') : null;")).toBe(0);
    });

    it('but not a guard that lets Windows in', () => {
      expect(count("if (process.platform === 'win32') { spawn('a'); }")).toBe(1);
      expect(count("if (process.platform !== 'darwin') { spawn('a'); }")).toBe(1);
      expect(count("if (process.platform === 'darwin' || x) { spawn('a'); }")).toBe(1);
      expect(count("function f() { if (process.platform === 'darwin') return; spawn('a'); }")).toBe(1);
    });
  });

  it('adds no call that can show a console window', () => {
    const allowed = readAllowlist();
    const grown = Object.entries(found)
      .filter(([file, calls]) => calls.length > (allowed[file] ?? 0))
      .map(([file, calls]) => `${file}: ${calls.length} (snapshot allows ${allowed[file] ?? 0})\n  ${calls.join('\n  ')}`);
    expect(grown, [
      'A spawning call under src/ that can flash a console window on Windows. Add `windowsHide: true` to its',
      'options; it is ignored off Windows. See the header of src/shared/__tests__/windowsHide.guard.test.ts',
      'if the window is wanted.',
    ].join(' ')).toEqual([]);
  });
});
