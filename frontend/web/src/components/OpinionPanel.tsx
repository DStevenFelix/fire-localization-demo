import { useId, useSyncExternalStore } from 'react';
import { Activity } from 'lucide-react';
import type { OpinionPost } from '../types';
import type { OpinionFeed } from '../utils/opinionFeed';
import { poiRegistry } from '../utils/poiRegistry';

type Props = {
  feed: OpinionFeed;
  source: string;
  status: string;
  scanning?: boolean;
  receivedTotal?: number;
  error?: string;
};

const signalPositions = [[36, 41], [78, 31], [88, 65], [52, 87], [34, 64], [72, 81]];

export default function OpinionPanel({ feed, source, status, scanning = status === '播放中', receivedTotal, error }: Props) {
  const { current, previous, shown } = useSyncExternalStore(feed.subscribe, feed.getSnapshot);

  return <section className="control-card opinion-card" aria-labelledby="opinion-title">
    <div className="card-heading">
      <div className="opinion-heading"><Activity size={17} /><div>
        <h2 id="opinion-title">舆情监测 Agent</h2>
      </div></div>
    </div>
    <div className="control-body opinion-body opinion-radar-body">
      <div className="opinion-radar-overview">
        <OpinionRadar key={scanning || current ? 'started' : 'idle'} active={scanning} signal={shown} />
        <div className="opinion-radar-summary">
          <div className="opinion-source">
            <span>{source}</span>
            <span role="status">{status}</span>
          </div>
          <div className="opinion-caption">
            <span>累计收到 {receivedTotal ?? 0} 条</span>
          </div>
        </div>
      </div>
      <div className="opinion-viewport" role="region" aria-label="当前帖子">
        {previous && <PostEntry key={shown - 1} post={previous} outgoing />}
        {current ? <PostEntry key={shown} post={current} /> :
          <p className="opinion-placeholder">{error ?? '等待本轮帖子展示'}</p>}
      </div>
    </div>
  </section>;
}

function OpinionRadar({ active, signal }: { active: boolean; signal: number }) {
  const trail = useId();
  const position = signal > 0 ? signalPositions[(signal - 1) % signalPositions.length] : undefined;

  return <svg className="opinion-radar" data-active={active} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={trail} x2="100%" y2="12%">
        <stop offset="0%" stopColor="#80c8c7" stopOpacity="0" />
        <stop offset="66%" stopColor="#80c8c7" stopOpacity=".08" />
        <stop offset="100%" stopColor="#80c8c7" stopOpacity=".34" />
      </linearGradient>
    </defs>
    <circle className="opinion-radar-frame" cx="60" cy="60" r="55" />
    <g className="opinion-radar-grid" fill="none">
      <circle cx="60" cy="60" r="14" />
      <circle cx="60" cy="60" r="27" />
      <circle cx="60" cy="60" r="41" />
      <path className="opinion-radar-axis" d="M60 5v110M5 60h110M21 21l78 78M99 21L21 99" />
    </g>
    <g className="opinion-radar-sweep">
      <path d="M60 60L8 43A55 55 0 0 1 60 5Z" fill={`url(#${trail})`} />
      <path className="opinion-radar-beam" d="M60 60V5" />
    </g>
    <circle className="opinion-radar-center" cx="60" cy="60" r="1.8" />
    {position && <circle key={signal} className="opinion-radar-signal" cx={position[0]} cy={position[1]} r="3" />}
  </svg>;
}

function PostEntry({ post, outgoing = false }: { post: OpinionPost; outgoing?: boolean }) {
  const location = post.location_poi_id;

  return <article className={`opinion-entry opinion-entry-${outgoing ? 'outgoing' : 'current'}`} aria-hidden={outgoing || undefined} inert={outgoing || undefined}>
    <div className="opinion-post-meta">
      <strong>{post.id}</strong>
      {post.timestamp && <time dateTime={post.timestamp}>{new Date(post.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false })}</time>}
    </div>
    <div className="opinion-post-text" tabIndex={0}><p>{post.text}</p></div>
    {(location || post.urgency) && <div className="opinion-post-details">
      {location && <span>发帖位置 · {poiRegistry.get(location)?.name ?? location}</span>}
      {post.urgency && <span>紧急程度 · {post.urgency}</span>}
    </div>}
  </article>;
}
