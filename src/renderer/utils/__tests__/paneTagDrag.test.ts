import { describe, it, expect, afterEach } from 'vitest';
import { beginPaneTagDrag, endPaneTagDrag, paneTagDropText } from '../paneTagDrag';

describe('paneTagDrag', () => {
  afterEach(() => endPaneTagDrag());

  it('a pane-header drag dropped on a terminal inserts the tag and a space', () => {
    beginPaneTagDrag('# wmux Pane in "ws"\n- Pane tag: #w1-2', '#w1-2');
    expect(paneTagDropText('# wmux Pane in "ws"\n- Pane tag: #w1-2')).toBe('#w1-2 ');
  });

  it('leaves any other drag text alone, even while a stale pane drag lingers', () => {
    beginPaneTagDrag('pane markdown', '#w1-2');
    expect(paneTagDropText('/Users/me/file.ts')).toBeNull();
  });

  it('is off once the drag ends', () => {
    beginPaneTagDrag('pane markdown', '#w1-2');
    endPaneTagDrag();
    expect(paneTagDropText('pane markdown')).toBeNull();
  });
});
