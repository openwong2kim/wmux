import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// napi's generated callbacks are `extern "C"`, so a Rust panic that reaches one
// aborts the process. In the daemon that's every pane. `catch_unwind` turns it
// into a JS exception, which the callers already survive. It's per method, so a
// new method would otherwise miss it silently.

const SOURCE_DIR = path.join(process.cwd(), 'core', 'wmux-term', 'src');

function uncontainedNapiFns(source) {
  const lines = source.split('\n');
  const missing = [];
  lines.forEach((line, index) => {
    const attribute = /^\s*#\[napi(\(.*\))?\]\s*$/.exec(line);
    if (!attribute) return;
    let next = index + 1;
    while (next < lines.length && /^\s*(#\[|\/\/)/.test(lines[next])) next += 1;
    const isFn = /^\s*(pub(\(crate\))?\s+)?(unsafe\s+)?fn\s/.test(lines[next] ?? '');
    if (isFn && !/catch_unwind/.test(attribute[1] ?? '')) missing.push(`${index + 1}: ${lines[next].trim()}`);
  });
  return missing;
}

describe('native terminal core panic containment', () => {
  it('finds a method with no containment', () => {
    expect(uncontainedNapiFns('#[napi]\n/// doc\npub fn feed(&mut self) {}')).toHaveLength(1);
    expect(uncontainedNapiFns('#[napi(getter)]\npub fn size(&self) -> u32 { 0 }')).toHaveLength(1);
    expect(uncontainedNapiFns('#[napi(catch_unwind)]\npub fn feed(&mut self) {}')).toEqual([]);
    expect(uncontainedNapiFns('#[napi(constructor, catch_unwind)]\npub fn new() -> Self { Self }')).toEqual([]);
    expect(uncontainedNapiFns('#[napi]\npub struct Terminal;\n#[napi]\nimpl Terminal {}')).toEqual([]);
  });

  it('holds for every napi function in the crate', () => {
    const files = fs.readdirSync(SOURCE_DIR).filter((name) => name.endsWith('.rs'));
    expect(files.length).toBeGreaterThan(0);
    const missing = files.flatMap((name) =>
      uncontainedNapiFns(fs.readFileSync(path.join(SOURCE_DIR, name), 'utf8')).map((hit) => `${name}:${hit}`));
    expect(missing).toEqual([]);
  });
});
