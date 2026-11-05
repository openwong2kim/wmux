// #2095 — every push to main keeps its CI result, and perf's artifact-contract
// job runs only when bench produced the file it asserts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows');
const load = (name) => YAML.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

describe('CI runs on main', () => {
  it.each(['ci.yml', 'ci-cross-platform-baseline.yml', 'perf.yml'])('%s groups a push by commit and never cancels it', (name) => {
    const { concurrency } = load(name);
    expect(concurrency.group).toContain("github.event_name == 'pull_request' && github.ref || github.sha");
    expect(concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });
});

describe('perf artifact-contract', () => {
  const { jobs } = load('perf.yml');
  const steps = jobs.bench.steps;
  const produced = steps.findIndex((s) => s.id === 'produced');
  const upload = steps.findIndex((s) => s.name === 'Upload artifacts');

  it('runs only when bench produced the measurement it asserts', () => {
    expect(jobs['artifact-contract'].needs).toBe('bench');
    expect(jobs['artifact-contract'].if).toMatch(/^always\(\) && needs\.bench\.outputs\.perf-current-produced == 'true' && /);
    expect(jobs.bench.outputs['perf-current-produced']).toBe('${{ steps.produced.outputs.present }}');
  });

  it('notes the file on every bench run, before the upload, from the path the contract asserts', () => {
    expect(produced).toBeGreaterThan(-1);
    expect(produced).toBeLessThan(upload);
    expect(steps[produced].if).toBe('always()');
    expect(steps[produced].run).toContain('Test-Path out/perf-current.json');
    expect(steps[produced].run).toContain('GITHUB_OUTPUT');
    const assertStep = jobs['artifact-contract'].steps.find((s) => /round trip/.test(s.name));
    expect(assertStep.run).toContain('first/out/perf-current.json');
  });
});
