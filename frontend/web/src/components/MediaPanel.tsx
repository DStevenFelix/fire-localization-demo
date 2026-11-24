import { useEffect, useRef, useState } from 'react';
import { Camera, Image, Video } from 'lucide-react';
import { mediaSlots, responders, type DashboardSnapshot } from '../services/dashboardInput';

type Feed = DashboardSnapshot['media'][string];
const statusLabels = {
  idle: '空闲 · 等待来源', connecting: '连接中', ready: '加载中',
  disconnected: '已断流', error: '来源异常', reconnecting: '重连中',
};

export default function MediaPanel({ group, media }: { group: 'air' | 'ground'; media: DashboardSnapshot['media'] }) {
  const title = group === 'air' ? '无人机视角' : '无人车视角';
  return <section className="media-card" aria-label={title}>
    <div className="card-heading"><span><Camera size={16} /><h2>{title}</h2></span></div>
    <div className="media-grid">{mediaSlots.filter(slot => slot.id.startsWith(group)).map(slot => {
      const feed = media[slot.id];
      const device = responders.find(device => device.id === (feed?.deviceId ?? ('deviceId' in slot ? slot.deviceId : undefined)));
      return <div className="media-tile" key={slot.id} data-feed-slot={slot.id} data-device={device?.id} data-feed-id={feed?.feedId}>
        <div className="media-tile-heading"><strong>{slot.label}</strong>{device && <span title={device.id}>{device.label}</span>}</div>
        <MediaPlayback key={`${feed?.feedId}:${feed?.url}:${feed?.status}`} kind={slot.kind} feed={feed} label={`${title} ${slot.label}`} />
      </div>;
    })}</div>
  </section>;
}

function MediaPlayback({ kind, feed, label }: { kind: 'image' | 'video'; feed?: Feed; label: string }) {
  const [playback, setPlayback] = useState<{ stream?: MediaStream; status: 'playing' | 'buffering' | 'paused' | 'error' | 'disconnected' }>();
  const video = useRef<HTMLVideoElement>(null);
  const stream = feed?.status === 'ready' ? feed.stream : undefined;
  useEffect(() => {
    const element = video.current;
    if (!stream || !element) return;
    element.srcObject = stream;
    const disconnected = () => setPlayback({ stream, status: 'disconnected' });
    stream.addEventListener('inactive', disconnected);
    const tracks = stream.getTracks();
    const check = () => { if (!stream.active) disconnected(); };
    tracks.forEach(track => track.addEventListener('ended', check));
    check();
    return () => {
      stream.removeEventListener('inactive', disconnected);
      tracks.forEach(track => track.removeEventListener('ended', check));
      element.srcObject = null;
    };
  }, [stream]);
  const active = feed?.status === 'ready';
  const status = active ? (playback?.stream === stream ? playback?.status : undefined) ?? 'ready' : feed?.status ?? 'idle';
  const labelText = status === 'playing' ? kind === 'video' ? '播放中' : '图片已加载' :
    status === 'buffering' ? '缓冲中' : status === 'paused' ? '已暂停' : statusLabels[status];
  return <div className="media-surface" data-media-status={status}>
    {active && (kind === 'image' ?
      <img src={feed.url} alt={label} onLoad={() => setPlayback({ status: 'playing' })} onError={() => setPlayback({ status: 'error' })} /> :
      <video ref={video} aria-label={label} src={feed.url} autoPlay muted playsInline controls
        onPlaying={() => setPlayback({ stream, status: 'playing' })} onPause={() => setPlayback({ stream, status: 'paused' })}
        onWaiting={() => setPlayback({ stream, status: 'buffering' })} onStalled={() => setPlayback({ stream, status: 'buffering' })}
        onEnded={() => setPlayback({ stream, status: 'disconnected' })} onError={() => setPlayback({ stream, status: 'error' })} />)}
    {!active && (kind === 'image' ? <Image size={17} aria-hidden="true" /> : <Video size={17} aria-hidden="true" />)}
    <span className="media-state" role="status">{labelText}</span>
  </div>;
}
