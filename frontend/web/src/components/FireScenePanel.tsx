import { Box, Flame } from 'lucide-react';
import FireScene3D from './FireScene3D';
import { getFireScene } from '../utils/fireSceneData';
import type { FireSceneSeverity, FireSceneStatus, SceneActorSource } from '../types';

const statusLabels: Record<FireSceneStatus, string> = { normal: '正常', burning: '着火', extinguishing: '灭火中', extinguished: '已扑灭' };

export default function FireScenePanel({ targetId, status, actors, severity, showInfo = true }: { targetId: string | null; status: FireSceneStatus; actors: SceneActorSource; severity?: FireSceneSeverity; showInfo?: boolean }) {
  const data = getFireScene(targetId);
  const effectiveStatus = data ? status : 'normal';
  return <><section className="fire-scene-card" aria-label="三维火场展示">
      <div className="card-heading"><span><Box size={17} /><h2>三维火场展示</h2></span><span className="tag-muted">LOCAL 3D</span></div>
      <div className="fire-scene-area">{data?.area.name ?? '局部罐区'}<span className={`fire-status ${effectiveStatus}`}>{data ? statusLabels[effectiveStatus] : '准备中'}</span></div>
      <FireScene3D targetId={data?.target.id ?? null} status={effectiveStatus} actors={actors} severity={severity} />
    </section>{showInfo && <FireSceneInfo targetId={targetId} status={effectiveStatus} />}</>;
}

export function FireSceneInfo({ targetId, status }: { targetId: string | null; status: FireSceneStatus }) {
  const data = getFireScene(targetId);
  return <section className="fire-scene-card fire-info-card" aria-label="火场信息">
      <div className="card-heading"><span><Flame size={17} /><h2>火场信息</h2></span></div>
      <dl className="fire-scene-info"><div><dt>当前储罐</dt><dd>{data?.target.name ?? '等待场景准备'}</dd></div><div><dt>POI ID</dt><dd>{data?.target.id ?? '—'}</dd></div><div><dt>火情状态</dt><dd>{data ? <span className={`fire-status ${status}`}>{statusLabels[status]}</span> : '—'}</dd></div></dl>
    </section>;
}
