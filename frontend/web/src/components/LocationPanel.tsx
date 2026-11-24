import { ArrowUpRight, Check, Crosshair, Target } from 'lucide-react';
import type { DashboardSnapshot } from '../services/dashboardInput';
import type { Session } from '../types';

export default function LocationPanel({ session, running, selectedRank, onSelect, agent }: {
  session: Session | null; running: boolean; selectedRank: number; onSelect: (rank: number) => void;
  agent?: DashboardSnapshot['agents']['location'];
}) {
  const candidates = session?.prediction?.candidates ?? [];
  const top1 = candidates.find(candidate => candidate.rank === 1);
  const phase = session?.error || session?.status === 'failed' ? '定位失败' :
    session?.analysis_frozen || session?.status === 'completed' ? '定位完成' :
    top1 ? '得到候选' : running ? '处理中' : agent?.phase ?? '等待线索';
  return <section className="results-card" aria-label="定位结果">
    <div className="card-heading"><span><Target size={16} /><h2>火情定位 Agent</h2></span><span className="agent-phase">{phase}</span></div>
    <div className="result-content" role="region" aria-label="定位结果详情" tabIndex={0}>
      <div className="location-count" aria-live="polite">{session?.batch_count ?? 0} 批 <span>已定位 {session?.processed_count ?? 0} / {session?.post_count ?? 0} 条</span></div>
      {top1 ? <div className="result-body" key={session?.session_id}>
        <div className="top1-heading"><strong>Top1</strong><small className="top1-id poi-id">{top1.poi_id}</small>
          {session?.evaluation && <span className={session.evaluation.top1_hit ? 'hit-badge' : 'miss-badge'}>
            {session.evaluation.top1_hit ? <><Check size={12} />命中真实火点</> : '未命中真实火点'}</span>}</div>
        <div className="candidate-list">{candidates.map(candidate =>
          <button type="button" key={candidate.poi_id} className={`candidate-row ${selectedRank === candidate.rank ? 'selected' : ''}`}
            onClick={() => onSelect(candidate.rank)} title={candidate.poi_id} aria-label={`高亮候选 ${candidate.rank} ${candidate.name}`} aria-pressed={selectedRank === candidate.rank}>
            <span className="rank-number">{candidate.rank}</span><div><strong data-testid={candidate.rank === 1 ? 'top1-name' : undefined}>{candidate.name}</strong>
              <i style={{ width: `${Math.min(100, Math.max(0, candidate.relative_score * 100))}%` }} /></div>
            <span className="candidate-score" title={`得分 ${candidate.score.toFixed(3)} · ${candidate.votes} 票`}>{candidate.score.toFixed(3)}<small>· {candidate.votes} 票</small></span>
            <ArrowUpRight size={13} />
          </button>)}</div>
        {session?.evaluation && <div className="error-metric"><div><Crosshair size={14} /><span>与真实火点的距离误差</span></div>
          <strong data-testid="distance-error">{session.evaluation.distance_m?.toFixed(2) ?? '—'}{session.evaluation.distance_m !== null && <small>m</small>}</strong></div>}
      </div> : <p className="location-empty" data-testid="empty-results">{session?.error?.message ?? (session?.status === 'completed' ? '当前没有定位候选' : agent?.summary ?? (running ? '正在分析火情证据' : '等待算法定位'))}</p>}
      {!!session?.batch_history?.length && <details className="runtime-details"><summary>批次历史<span>{session.batch_history.length} 批</span></summary>
        <ol className="location-history">{[...session.batch_history].reverse().map(batch => <li key={batch.batch_number}>
          <strong>第 {batch.batch_number} 批 · 累计定位 {batch.processed_count} 条</strong>
          <small>{batch.prediction.candidates.map(candidate => `#${candidate.rank} ${candidate.name} · ${candidate.votes} 票`).join(' / ') || '无候选'}</small>
        </li>)}</ol>
      </details>}
    </div>
  </section>;
}
