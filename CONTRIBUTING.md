# Contributing to wmux

Thanks for your interest in contributing to wmux! Here's how to get started.

## Getting Started

```bash
git clone https://github.com/openwong2kim/wmux.git
cd wmux
npm install
npm run start   # dev mode
npm test        # run tests
```

Requires Node.js 22+ and Windows 10/11 (ConPTY).

## Pull Requests

### One PR, One Purpose

Keep PRs focused on a single concern. Don't mix unrelated changes.

- **Security fix** → security PR only
- **New feature** → feature PR only
- **Bug fix** → bug fix PR only

If your work touches multiple areas, split it into separate PRs.

### PR Checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes
- [ ] New code has tests
- [ ] Commit messages are clear and descriptive

### Test layout

Use `*.runtime.test.ts`, `*.runtime.test.tsx`, or `*.runtime.test.mjs` for
tests that spawn real OS resources, such as ConPTY shells or Windows process
probes. `npm test` runs these runtime tests serially after the regular parallel
suite to avoid cross-test contention.

### Commit Style

```
<type>: <short description>

fix: resolve zombie pipe cleanup on daemon restart
feat: add split pane keyboard shortcuts
security: harden filesystem bridge path resolution
refactor: extract token writer to shared module
test: add SSRF validation coverage for IPv6-mapped IPv4
docs: update CLI reference for org commands
```

## Reporting Security Issues

If you find a security vulnerability, please **do not open a public issue**. Instead, email [open.wong2kim@gmail.com] or open a draft security advisory on GitHub. We'll respond within 48 hours.

## Code Style

- TypeScript strict mode
- Vitest for testing
- No `any` unless absolutely necessary — explain why in a comment

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
