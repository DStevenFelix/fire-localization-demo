import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import type { OpinionPost } from '../types';

type OpinionSnapshot = Readonly<{
  current?: OpinionPost;
  previous?: OpinionPost;
  shown: number;
}>;

export function createOpinionFeed(sessionId: string | undefined) {
  let snapshot: OpinionSnapshot = { shown: 0 };
  const listeners = new Set<() => void>();

  function publish(next: OpinionSnapshot) {
    snapshot = next;
    listeners.forEach(listener => listener());
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    receivePost(id: string, post: OpinionPost) {
      if (id !== sessionId) return;
      publish({ current: post, previous: snapshot.current, shown: snapshot.shown + 1 });
    },
    clearPosts(id: string) {
      if (id === sessionId) publish({ shown: 0 });
    },
  };
}

export type OpinionFeed = ReturnType<typeof createOpinionFeed>;

export function useSocialNetPosts(sessionId: string | undefined, running: boolean, paused: boolean, feed: OpinionFeed) {
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [received, setReceived] = useState<{ id: string; total: number }>();
  const queue = useMemo(() => ({ recent: [] as readonly OpinionPost[], fresh: [] as OpinionPost[], total: 0, next: 0 }), [sessionId]);

  useEffect(() => {
    if (!sessionId || !running) return;
    const controller = new AbortController();
    let requestTimer: number | undefined;

    async function poll() {
      try {
        const data = await api.posts(sessionId!, controller.signal);
        if (controller.signal.aborted || data.session_id !== sessionId) return;
        if (data.post_count > queue.total) {
          queue.fresh = [...queue.fresh, ...data.posts.slice(-Math.min(data.post_count - queue.total, data.posts.length))].slice(-60);
          queue.recent = data.posts;
          queue.total = data.post_count;
          setReceived({ id: sessionId!, total: queue.total });
        }
        setFailure(undefined);
      } catch (error) {
        if (!controller.signal.aborted) setFailure({ id: sessionId!, message: error instanceof Error ? error.message : '读取帖子失败' });
      } finally {
        if (!controller.signal.aborted) requestTimer = window.setTimeout(poll, 1000);
      }
    }

    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(requestTimer);
    };
  }, [sessionId, running, queue]);

  useEffect(() => {
    if (!sessionId || !running || paused) return;
    const playback = window.setInterval(() => {
      const post = queue.fresh.shift() ?? (queue.recent.length ? queue.recent[queue.next++ % queue.recent.length] : undefined);
      if (post) feed.receivePost(sessionId, post);
    }, 1000);
    return () => window.clearInterval(playback);
  }, [sessionId, running, paused, feed, queue]);

  const total = received?.id === sessionId ? received?.total : undefined;
  return { status: running ? paused ? '滚动已暂停' : total ? '播放中' : '等待 SocialNet 发帖' : total ? '滚动已停止' : '等待开始仿真',
    scanning: running && !paused, receivedTotal: total, error: running && failure?.id === sessionId ? failure?.message : undefined };
}
