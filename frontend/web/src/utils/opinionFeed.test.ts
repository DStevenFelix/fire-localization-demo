import { describe, expect, it, vi } from 'vitest';
import { createOpinionFeed } from './opinionFeed';

describe('opinion feed', () => {
  it('accepts consecutive external posts for the bound session and clears its display', () => {
    const feed = createOpinionFeed('current');
    const notify = vi.fn();
    const unsubscribe = feed.subscribe(notify);
    const first = { id: 'first', text: '测试帖子一' };
    const second = { id: 'second', text: '测试帖子二' };

    feed.receivePost('obsolete', first);
    expect(feed.getSnapshot()).toEqual({ shown: 0 });
    feed.receivePost('current', first);
    feed.receivePost('current', second);
    feed.clearPosts('obsolete');
    expect(feed.getSnapshot()).toEqual({ current: second, previous: first, shown: 2 });
    expect(notify).toHaveBeenCalledTimes(2);

    feed.clearPosts('current');
    expect(feed.getSnapshot()).toEqual({ shown: 0 });
    expect(notify).toHaveBeenCalledTimes(3);
    unsubscribe();
    feed.receivePost('current', first);
    expect(notify).toHaveBeenCalledTimes(3);
  });
});
