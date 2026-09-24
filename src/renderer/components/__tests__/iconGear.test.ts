// The settings gear is drawn at 14–16px in the sidebar and at 9px on the
// workspace profile / project badges. Eight teeth and a hub smudge at 9px, so
// small sizes switch to a ring with six teeth on a heavier stroke.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IconGear } from '../icons';

describe('IconGear', () => {
  it('draws the eight-tooth cog at sidebar sizes', () => {
    const html = renderToStaticMarkup(createElement(IconGear, { size: 16 }));
    expect(html).toContain('A5.7 5.7');
    expect(html).not.toContain('stroke-width="1.8"');
  });

  it('draws the simplified heavier glyph at badge sizes (10px and below)', () => {
    for (const size of [9, 10]) {
      const html = renderToStaticMarkup(createElement(IconGear, { size }));
      expect(html).toContain('stroke-width="1.8"');
      expect(html).not.toContain('A5.7 5.7');
    }
  });
});
