import { describe, expect, it } from 'vitest';
import { ancestryScript, parseAncestryOutput } from '../callerAncestry';

describe('callerAncestry', () => {
  it('parses child/parent pairs and skips noise', () => {
    expect([...parseAncestryOutput('39876 25020\r\n25020 49076\r\n\r\nbogus\r\n7 7\r\n')]).toEqual([
      [39876, 25020],
      [25020, 49076],
    ]);
  });

  it('stops the chain at a parent created after its child', () => {
    expect(ancestryScript(42)).toContain('$q.CreationDate -gt $c.CreationDate');
    expect(ancestryScript(42)).toMatch(/^\$p=42;/);
  });
});
