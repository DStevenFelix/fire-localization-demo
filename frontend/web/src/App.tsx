import { useEffect, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowUpRight, Check, ChevronRight, CircleDot, Crosshair, Database, Flame, LoaderCircle, MapPin, Play, Radio, RotateCcw, ShieldCheck, Target, Wifi, WifiOff } from 'lucide-react';
import SandboxMap from './components/SandboxMap';
import LiveConfirmation from './components/LiveConfirmation';
import { api } from './services/api';
import type { Candidate, Mode, Poi, Session } from './types';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请检查本地桥接服务。';

export default function App() {
  const [pois, setPois] = useState<Poi[]>([]);
  const [scenarios, setScenarios] = useState<Poi[]>([]);
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<Mode>('offline');
  const [session, setSession] = useState<Session | null>(null);
  const [connected, setConnected] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRank, setSelectedRank] = useState(1);
  const [confirmLive, setConfirmLive] = useState(false);
  const [reload, setReload] = useState(0);
  const [prepareNonce, setPrepareNonce] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const seed = 42;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.health(), api.pois(), api.scenarios()]).then(([, points, data]) => {
      if (cancelled) return;
      setPois(points); setScenarios(data.scenarios); setTargetId(data.default_target_poi_id); setConnected(true); setError(null);
    }).catch(err => { if (!cancelled) { setConnected(false); setError(`桥接服务未连接：${errorMessage(err)}`); } });
    const timer = window.setInterval(() => { api.health().then(() => { if (!cancelled) setConnected(true); }).catch(() => { if (!cancelled) setConnected(false); }); }, 10000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [reload]);

  useEffect(() => {
    if (!targetId) return;
    const revision = ++generation.current;
    const controller = new AbortController();
    setPreparing(true); setSession(null); setSelectedRank(1); setError(null); setStarting(false); inFlight.current = false;
    api.prepare(targetId, mode, seed, controller.signal).then(prepared => {
      if (generation.current === revision) setSession(prepared);
    }).catch(err => {
      if (!controller.signal.aborted && generation.current === revision) setError(errorMessage(err));
    }).finally(() => { if (generation.current === revision) setPreparing(false); });
    return () => { controller.abort(); generation.current++; };
  }, [targetId, mode, prepareNonce, reload]);

  const running = starting || session?.status === 'running';
  const busy = preparing || running;
  const completed = session?.status === 'completed';
  const prediction = completed ? session.prediction : null;
  const candidates = prediction?.candidates ?? [];
  const top1 = candidates[0];
  const highlight: Candidate | null = candidates.find(c => c.rank === selectedRank) ?? null;
  const stage = preparing ? '准备场景' : running ? '正在定位' : session?.status === 'failed' ? '运行失败' : completed ? '定位完成' : session ? '场景就绪' : connected ? '等待准备' : '等待连接';

  useEffect(() => {
    if (starting || session?.status !== 'running') return;
    const id = session.session_id;
    const revision = generation.current;
    let cancelled = false;
    const timer = window.setInterval(() => {
      api.session(id).then(current => { if (!cancelled && generation.current === revision) {
        setSession(current); if (current.status !== 'running') setError(null);
      } }).catch(() => { /* next poll retries status only; never resubmits run */ });
    }, 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [starting, session?.session_id, session?.status]);

  async function run(confirmed = false) {
    if (!session || session.status !== 'prepared' || inFlight.current || !connected) return;
    if (mode === 'live' && !confirmed) { setConfirmLive(true); return; }
    setConfirmLive(false); inFlight.current = true; setStarting(true); setError(null); setSelectedRank(1);
    const revision = generation.current;
    const id = session.session_id;
    try {
      let current = await api.run(id, confirmed);
      while (generation.current === revision) {
        setSession(current);
        if (current.status !== 'running') break;
        await new Promise(resolve => window.setTimeout(resolve, 350));
        if (generation.current !== revision) return;
        current = await api.session(id);
      }
    } catch (err) {
      if (generation.current === revision) {
        setError(errorMessage(err));
        // Recover actual state without re-submitting a potentially paid run.
        try { const recovered = await api.session(id); if (generation.current === revision) setSession(recovered); } catch { /* keep last known state */ }
      }
    } finally { if (generation.current === revision) { setStarting(false); inFlight.current = false; } }
  }

  async function reset() {
    if (!session || busy || inFlight.current) return;
    const id = session.session_id;
    const revision = ++generation.current;
    setSession(null); setPreparing(true); setSelectedRank(1); setError(null);
    try { const next = await api.reset(id); if (generation.current === revision) setSession(next); }
    catch (err) { if (generation.current === revision) setError(errorMessage(err)); }
    finally { if (generation.current === revision) setPreparing(false); }
  }

  return <div className="application-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-symbol"><Flame size={26} /></div><div><h1>火灾应急管理仿真沙盘系统</h1><span>FIRE EMERGENCY SIMULATION</span></div></div>
      <div className="topbar-title"><span>研究演示</span><ChevronRight size={14} /><strong>火情智能定位</strong></div>
      <div className="header-status"><span className={connected ? 'connection connected' : 'connection'}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connected ? '后端已连接' : '后端未连接'}</span><span className={`mode-badge ${mode}`}><i />{mode === 'offline' ? 'OFFLINE' : 'LIVE'}</span></div>
    </header>
    <main>
      <div className="page-heading"><div><div className="eyebrow">INTELLIGENT FIRE LOCALIZATION</div><h2>让火情，从线索到坐标。</h2><p>多条火情证据融合 · POI 空间约束 · 原始算法实时回放</p></div><div className="research-label"><ShieldCheck size={17} /><span>研究仿真环境<small>原始后端 · 独立演示会话</small></span></div></div>
      {error && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{error}</span><button onClick={() => { if (!connected) setReload(v => v+1); else setPrepareNonce(v => v+1); }}>重新准备</button></div>}
      <div className="workspace-grid">
        <div className="map-column">
          <SandboxMap pois={pois} session={session} highlighted={highlight} />
          <div className="metrics-row">
            <div><span className="metric-icon"><Database size={19} /></span><span><small>地图兴趣点</small><strong>{pois.length || '—'} <em>POI</em></strong></span></div>
            <div><span className="metric-icon"><Activity size={19} /></span><span><small>已处理火情帖子</small><strong>{session?.processed_count ?? 0}<em> / {session?.post_count ?? 10} 条</em></strong></span></div>
            <div><span className="metric-icon"><CircleDot size={19} /></span><span><small>活跃证据簇</small><strong>{prediction?.active_cluster_count ?? '—'}<em> 个</em></strong></span></div>
            <div><span className="metric-icon"><Crosshair size={19} /></span><span><small>Top1 坐标距离误差</small><strong>{completed && session.evaluation?.distance_m != null ? session.evaluation.distance_m.toFixed(3) : '—'}<em> m</em></strong></span></div>
          </div>
          <section className="evidence-card"><div className="evidence-title"><Radio size={16} /><strong>演示运行记录</strong><span className={`status-pill ${completed ? 'success' : running ? 'active' : ''}`}>{stage}</span></div>
            <div className="run-timeline"><div className={session ? 'done' : ''}><span>{session ? <Check size={13} /> : '1'}</span><strong>场景准备</strong><small>原始生成器 · 10 条帖子</small></div><div className={running ? 'active' : completed ? 'done' : ''}><span>{running ? <LoaderCircle size={13} className="spin" /> : completed ? <Check size={13} /> : '2'}</span><strong>原始算法定位</strong><small>{mode === 'offline' ? '规则提取 + 字符哈希向量' : 'Chat + Embedding 真实模型'}</small></div><div className={completed ? 'done' : ''}><span>{completed ? <Check size={13} /> : '3'}</span><strong>发布候选</strong><small>{completed ? `${session.batch_count} 批完成 · ${session.ignored_count} 条无储罐候选` : '等待实际算法结果'}</small></div></div>
            <div className="session-footnote"><span>SESSION</span><code>{session ? session.session_id.slice(0, 12).toUpperCase() : '等待创建'}</code><p>真实标签仅用于展示与评估，不参与推理和排名。</p></div>
          </section>
        </div>
        <aside className="control-column">
          <section className="control-card"><div className="card-heading"><span><SlidersIcon /><h2>定位控制台</h2></span><span className="tag-muted">DEMO</span></div>
            <div className="control-body"><label className="field-label" htmlFor="scenario">火情场景<span>{scenarios.length} 个独立储罐</span></label><select id="scenario" value={targetId} disabled={busy || !connected} onChange={e => setTargetId(e.target.value)}>{!scenarios.length && <option value="">等待场景加载</option>}{scenarios.map(p => <option value={p.poi_id} key={p.poi_id}>{p.name}</option>)}</select>
              <div className="ground-truth-box"><MapPin size={17} /><div><small>真实着火位置</small><strong>{session?.ground_truth.name ?? (preparing ? '正在准备场景…' : '尚未准备')}</strong><span>{session ? `${session.ground_truth.poi_id} · (${session.ground_truth.coordinates.x_m.toFixed(3)}, ${session.ground_truth.coordinates.y_m.toFixed(3)}) m` : '灰黑色中心标记 · 与预测结果独立'}</span></div></div>
              <div className="field-label">运行模式<span>固定种子 42 · 10 条帖子</span></div><div className="mode-switch" role="group" aria-label="运行模式"><button className={mode === 'offline' ? 'chosen' : ''} disabled={busy} onClick={() => setMode('offline')}>Offline <span>离线模拟</span></button><button className={mode === 'live' ? 'chosen live' : ''} disabled={busy} onClick={() => setMode('live')}>Live <span>付费模型</span></button></div>
              <p className={`mode-note ${mode}`}>{mode === 'offline' ? '使用原始规则提取与字符哈希向量，不调用外部模型 API。' : '智增增真实模型 · 会产生 API 费用，启动前需要再次确认。'}</p>
              <div className="run-buttons"><button className="primary-button" disabled={!connected || busy || session?.status !== 'prepared'} onClick={() => void run()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Play size={16} fill="currentColor" />}{preparing ? '准备场景中' : running ? '正在定位' : completed ? '本轮已完成' : '开始定位'}</button><button className="secondary-button reset-button" aria-label="重置演示" disabled={!session || busy || !connected} onClick={() => void reset()}><RotateCcw size={17} />重置</button></div>
              <div className="algorithm-status" role="status" aria-live="polite"><i className={running ? 'pulse-dot' : completed ? 'complete-dot' : ''} /><span>{stage}</span><small>{running ? '批次计算进行中' : completed ? '结果来自真实算法输出' : '结果将在计算完成后显示'}</small></div>
              {session?.error && <div className="run-error" role="alert"><AlertCircle size={17} /><div><strong>{session.error.error_type}</strong><p>{session.error.message}</p></div></div>}
            </div>
          </section>
          <section className="results-card"><div className="card-heading"><span><Target size={17} /><h2>定位结果</h2></span><span className="tag-muted">TOP 3</span></div>
            {top1 ? <div className="result-body"><div className="top1-heading"><span className="top1-badge">TOP 1</span><span className={session?.evaluation?.top1_hit ? 'hit-badge' : 'miss-badge'}>{session?.evaluation?.top1_hit ? <><Check size={12} />命中真实火点</> : '未命中真实火点'}</span></div><h3 data-testid="top1-name">{top1.name}</h3><p className="poi-id">{top1.poi_id}</p><div className="result-coordinates"><span>X <strong>{top1.coordinates.x_m.toFixed(3)}</strong></span><span>Y <strong>{top1.coordinates.y_m.toFixed(3)}</strong></span><small>m</small></div><div className="candidate-heading">候选排名 <small>按原始算法得分排序</small></div><div className="candidate-list">{candidates.map(candidate => <button key={candidate.poi_id} className={`candidate-row ${selectedRank === candidate.rank ? 'selected' : ''}`} onClick={() => setSelectedRank(candidate.rank)} aria-label={`高亮候选 ${candidate.rank} ${candidate.name}`} aria-pressed={selectedRank === candidate.rank}><span className="rank-number">0{candidate.rank}</span><div><strong>{candidate.name}</strong><small>{candidate.poi_id}</small><i style={{ width: `${Math.min(100, Math.max(0, candidate.relative_score * 100))}%` }} /></div><span className="candidate-score">{candidate.score.toFixed(3)}<small>得分</small></span><ArrowUpRight size={14} /></button>)}</div><p className="score-note">相对得分用于候选比较，不代表火灾概率。</p></div>
              : <div className="empty-results" data-testid="empty-results"><div><Crosshair size={32} /></div><h3>{completed ? '当前没有定位候选' : running ? '正在分析火情证据' : '等待算法定位'}</h3><p>{completed ? '算法未发现有效储罐证据。可重置或更换场景重试。' : running ? '完成本批计算后，显示实际 Top3 候选和坐标。' : '准备场景并开始定位，查看候选储罐、空间坐标与误差。'}</p><span>灰黑色真实点 · 红色预测圆环</span></div>}
          </section>
          <div className="algorithm-caption"><ShieldCheck size={15} /><p>复用同门原始 FireLocalizer<br /><span>独立会话 · 缓存隔离 · 历史结果保护</span></p></div>
        </aside>
      </div>
      <footer><span>火灾应急管理仿真沙盘 · 火情智能定位研究演示</span><span>{mode === 'offline' ? '离线模拟模式' : 'Live 模型模式'}<i />本地坐标系 / METERS</span></footer>
    </main>
    {confirmLive && <LiveConfirmation onCancel={() => setConfirmLive(false)} onConfirm={() => void run(true)} />}
  </div>;
}

function SlidersIcon() { return <Activity size={17} />; }
