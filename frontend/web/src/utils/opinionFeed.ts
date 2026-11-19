import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { OpinionPost, SessionPosts } from '../types';

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

type ReplayLoad = { id: string; data: SessionPosts } | { id: string; error: string };

export function useSessionPostReplay(sessionId: string | undefined, accepted: boolean, feed: OpinionFeed) {
  const [load, setLoad] = useState<ReplayLoad>();
  const [finishedId, setFinishedId] = useState<string>();
  const current = sessionId && load?.id === sessionId ? load : undefined;
  const data = current && 'data' in current ? current.data : undefined;

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    api.posts(sessionId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.session_id !== sessionId) throw new Error('帖子数据与当前会话不匹配。');
      setLoad({ id: sessionId, data: result });
    }).catch(error => {
      if (controller.signal.aborted) return;
      setLoad({ id: sessionId, error: error instanceof Error ? error.message : '无法加载本轮演示帖子。' });
    });
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !accepted || !data?.posts.length) return;
    let index = 0;
    let finish: number | undefined;
    const timer = window.setInterval(() => {
      feed.receivePost(sessionId, data.posts[index++]);
      if (index !== data.posts.length) return;
      window.clearInterval(timer);
      finish = window.setTimeout(() => setFinishedId(sessionId), 350);
    }, 1000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(finish);
    };
  }, [sessionId, accepted, data, feed]);

  if (!sessionId) return { status: '等待场景' };
  if (!data) return current && 'error' in current
    ? { status: '加载失败', error: current.error }
    : { status: '正在加载帖子' };
  if (!data.post_count) return { status: '暂无帖子', total: 0 };
  return {
    status: !accepted ? '等待定位启动' : finishedId === sessionId ? '播放完成' : '播放中',
    total: data.post_count,
  };
}
