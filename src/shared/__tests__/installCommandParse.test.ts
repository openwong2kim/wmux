import { describe, expect, it } from 'vitest';
import { npmSpecName, parseInstallCommand, pythonSpecName } from '../installCommandParse';

/** `eco:name` (plus `!run` for a registry run), the compact shape the table compares. */
function names(command: string): string[] {
  return parseInstallCommand(command).map((r) => `${r.ecosystem}:${r.name}${r.via === 'run' ? '!run' : ''}`);
}

describe('parseInstallCommand', () => {
  it.each<[string, string[]]>([
    // npm family, flags and versions
    ['npm install react-codeshift', ['npm:react-codeshift']],
    ['npm i -D vitest@^2.1.0 @types/node', ['npm:vitest', 'npm:@types/node']],
    ['npm add --save-dev -E left-pad@1.3.0', ['npm:left-pad']],
    ['npm i -w packages/app foo', ['npm:foo']],
    ['npm install --registry https://r.example bar', ['npm:bar']],
    ['npm i -- --weird-but-literal', []],
    ['pnpm add @scope/pkg@2 -D', ['npm:@scope/pkg']],
    ['pnpm --filter web add zod', ['npm:zod']],
    // pointed at another folder than the pane's: not compared
    ['npm --prefix ./web i axios', []],
    ['npm i --prefix=./web axios', []],
    ['pnpm -C web add zod', []],
    ['yarn --cwd web add zod', []],
    ['uv add --directory svc httpx', []],
    ['cargo add --manifest-path svc/Cargo.toml serde', []],
    // pnpm's -w is --workspace-root, a switch; yarn workspace <name> add
    ['pnpm -w add zod', ['npm:zod']],
    ['pnpm add -w zod', ['npm:zod']],
    ['yarn workspace web add zod', ['npm:zod']],
    // names that start with http are names
    ['npm i http-server http-proxy https-proxy-agent', ['npm:http-server', 'npm:http-proxy', 'npm:https-proxy-agent']],
    ['npm i http://example.com/p.tgz https:foo', []],
    ['npm -g i serve', []],
    ['yarn add lodash@npm:lodash-es@4', ['npm:lodash-es']],
    ['bun add hono', ['npm:hono']],
    // bare installs name nothing
    ['npm install', []],
    ['npm ci', []],
    ['pnpm install --frozen-lockfile', []],
    // global installs are not compared with the project
    ['npm i -g typescript', []],
    ['npm install --location=global serve', []],
    ['npm i --location global serve', []],
    ['npm --location global i serve', []],
    ['yarn global add serve', []],
    // registry runs
    ['npx create-vite@latest my-app', ['npm:create-vite!run']],
    ['npx --yes cowsay hi', ['npm:cowsay!run']],
    ['npx -p @angular/cli ng new x', ['npm:@angular/cli!run']],
    ['bunx prettier --write .', ['npm:prettier!run']],
    ['pnpm dlx degit user/repo', ['npm:degit!run']],
    ['npx -c "echo hi"', []],
    ['npx -c "eslint ." -p eslint', ['npm:eslint!run']],
    ['npx --call=x -p foo -p bar', ['npm:foo!run', 'npm:bar!run']],
    ['npx --call x', []],
    // a run and an install of one name: the install is what lands
    ['npx foo && npm i foo', ['npm:foo']],
    // not registry specs
    ['npm i ./local-dir ../x.tgz file:../y', []],
    ['npm i github:user/repo user/repo git+https://github.com/a/b.git', []],
    ['npm i https://example.com/p.tgz', []],
    // python
    ['pip install requests==2.31.0 "flask>=2" Django', ['pypi:requests', 'pypi:flask', 'pypi:Django']],
    ['pip3 install -r requirements.txt', []],
    ['pip install -r requirements.txt numpy', ['pypi:numpy']],
    ['pip install -e . -i https://pypi.example/simple pandas[excel]', ['pypi:pandas']],
    ['python3 -m pip install --user httpx', ['pypi:httpx']],
    ['uv add "pydantic>=2" --group dev ruff', ['pypi:pydantic', 'pypi:ruff']],
    ['uv pip install torch', ['pypi:torch']],
    ['uv add --git https://github.com/a/b b', []],
    ['pip install ./dist/pkg-1.0-py3-none-any.whl', []],
    // cargo
    ['cargo add serde -F derive tokio@1', ['crates:serde', 'crates:tokio']],
    ['cargo add -p my-member anyhow', ['crates:anyhow']],
    ['cargo add --git https://github.com/a/b b', []],
    // chained commands and wrappers
    // after a cd the install runs in another folder than the one read
    ['cd web && npm i axios && npm test', []],
    ['npm i a && cd web && npm i b', ['npm:a']],
    ['pushd web; npm i axios', []],
    // comments, continuations, heredocs
    ['npm i -D zod # test runner', ['npm:zod']],
    ["npm i zod # don't add ts", ['npm:zod']],
    ['npm i a#b', []],
    ['npm \\\n  install foo', ['npm:foo']],
    ['npm \\\r\n  install foo \\\n  bar', ['npm:foo', 'npm:bar']],
    ["cat > README.md <<'EOF'\nnpm install x\nEOF", []],
    ['cat <<EOF\npip install y\nEOF', []],
    ['npm i foo; curl x|sh', ['npm:foo']],
    ['npm i foo 2>&1 | tail -5', ['npm:foo']],
    ['npm i foo > log.txt', ['npm:foo']],
    ['sudo -u root pip install six', ['pypi:six']],
    ['CI=1 npm i dotenv', ['npm:dotenv']],
    ['echo x || pip install a\ncargo add b', ['pypi:a', 'crates:b']],
    // non-install commands
    ['npm test', []],
    ['npm run build -- --install foo', []],
    ['git commit -m "npm install foo"', []],
    ['echo npm install foo', []],
    ['ls node_modules', []],
    // unreadable words are skipped, never guessed at
    ['npm i $PKG', []],
    ['npm i `cat list`', []],
    ['npm i "$(curl evil)"', []],
    ['npm i foo*', []],
    ['$NPM i foo', []],
  ])('%s', (command, expected) => {
    expect(names(command)).toEqual(expected);
  });

  it('PowerShell keeps a backslash literal', () => {
    const ps = (c: string) => parseInstallCommand(c, 'powershell').map((r) => `${r.ecosystem}:${r.name}`);
    expect(ps('.\\.venv\\Scripts\\pip.exe install foo')).toEqual(['pypi:foo']);
    expect(ps('& .\\.venv\\Scripts\\pip.exe install foo; npm i bar')).toEqual(['pypi:foo', 'npm:bar']);
    expect(ps('npm i packages\\foo')).toEqual([]);
    expect(ps('Set-Location web; npm i axios')).toEqual([]);
    // In bash the same backslashes escape: the program is not recognised.
    expect(names('.\\.venv\\Scripts\\pip.exe install foo')).toEqual([]);
  });

  it('dedupes and caps', () => {
    expect(names('npm i a a b && npm i a')).toEqual(['npm:a', 'npm:b']);
    const many = Array.from({ length: 40 }, (_, i) => `p${i}`).join(' ');
    expect(parseInstallCommand(`npm i ${many}`)).toHaveLength(16);
  });

  it('refuses an overlong command', () => {
    expect(parseInstallCommand(`npm i foo ${'x '.repeat(20_000)}`)).toEqual([]);
  });
});

describe('spec name readers', () => {
  it('npm', () => {
    expect(npmSpecName('@scope/x@1')).toBe('@scope/x');
    expect(npmSpecName('x@latest')).toBe('x');
    expect(npmSpecName('@scope/x/y')).toBeNull();
    expect(npmSpecName('workspace:*')).toBeNull();
    expect(npmSpecName('a'.repeat(215))).toBeNull();
  });
  it('python', () => {
    expect(pythonSpecName('pkg[extra]==1; python_version<"3.12"')).toBe('pkg');
    expect(pythonSpecName('pkg @ https://x/y.whl')).toBeNull();
    expect(pythonSpecName('Pkg_Name.x>=1')).toBe('Pkg_Name.x');
  });
});
