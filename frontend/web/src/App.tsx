import { useEffect, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowRight, ArrowUpRight, BrainCircuit, Check, ChevronRight, CircleDot, Crosshair, Database, Flame, LoaderCircle, MapPin, MessagesSquare, Network, Play, RotateCcw, ShieldCheck, Target, Wifi, WifiOff } from 'lucide-react';
import SandboxMap from './components/SandboxMap';
import LiveConfirmation from './components/LiveConfirmation';
import { api } from './services/api';
import type { Candidate, Mode, Poi, Session } from './types';
import { poiRegistry } from './utils/poiRegistry';

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
  const prediction = session?.prediction ?? null;
  const candidates = prediction?.candidates ?? [];
  const top1 = candidates.find(c => c.rank === 1);
  const highlight: Candidate | null = candidates.find(c => c.rank === selectedRank) ?? null;
  const stage = preparing ? '准备场景' : running ? '正在定位' : session?.status === 'failed' ? '运行失败' : completed ? '定位完成' : session ? '场景就绪' : connected ? '等待准备' : '等待连接';
  const buttonState = preparing ? 'Preparing...' : running ? 'Analyzing...' : session?.status === 'failed' ? 'Failed' : completed ? 'Completed' : session && connected ? 'Ready' : 'Waiting';

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
      <div className="brand"><div className="brand-symbol"><Flame size={23} /></div><div><span className="brand-name">URBAN INTELLIGENCE LAB</span><span>城市应急态势 · 实时感知</span></div></div>
      <div className="topbar-title"><span>数字孪生沙盘</span><ChevronRight size={14} /><strong>火情定位智能体</strong></div>
      <div className="header-status"><span className={connected ? 'connection connected' : 'connection'}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connected ? 'Bridge 已连接' : 'Bridge 未连接'}</span><span className={`mode-badge ${mode}`}><i />{mode === 'offline' ? 'OFFLINE' : 'LIVE'}</span></div>
    </header>
    <main>
      <div className="page-heading"><div><div className="eyebrow">Agent-based Urban Fire Localization System</div><h1>城市火灾应急管理系统</h1><p>城市数字孪生 · 多源火情感知 · 实时空间定位</p></div><div className="research-label"><ShieldCheck size={19} /><span>城市应急态势中心<small>多源信息 → 空间推理 → 定位评估</small></span></div></div>
      {error && <div className="error-banner" role="alert"><AlertCircle size={18} /><div><strong>{connected ? '本次操作未完成' : '桥接服务未连接'}</strong><p>请检查本地 Bridge 服务，再重新准备场景。</p><details><summary>查看错误详情</summary><p>{error}</p></details></div><button disabled={busy} onClick={() => { if (!connected) setReload(v => v+1); else setPrepareNonce(v => v+1); }}>重新准备</button></div>}
      <section className="pipeline-card" aria-label="Agent 定位流程">
        <div className="pipeline-heading"><Network size={17} /><strong>Agent 定位流程</strong><span className={`status-pill ${completed ? 'success' : running ? 'active' : ''}`}>{stage}</span></div>
        <div className="pipeline-steps">
          <div><MessagesSquare size={19} /><span><strong>居民火情信息</strong><small>模拟帖子输入</small></span></div><ArrowRight className="pipeline-arrow" size={15} />
          <div><BrainCircuit size={19} /><span><strong>语义理解 Agent</strong><small>{mode === 'offline' ? '规则提取 · 离线' : 'Chat 信息提取'}</small></span></div><ArrowRight className="pipeline-arrow" size={15} />
          <div><Network size={19} /><span><strong>空间定位 Agent</strong><small>空间约束与证据聚合</small></span></div><ArrowRight className="pipeline-arrow" size={15} />
          <div><MapPin size={19} /><span><strong>POI 匹配</strong><small>候选储罐排序</small></span></div><ArrowRight className="pipeline-arrow" size={15} />
          <div><Target size={19} /><span><strong>火点预测</strong><small>Top3 与位置评估</small></span></div>
        </div>
        <p className="pipeline-note">火情证据每 10 条更新一批，实时发布候选位置与证据得分</p>
      </section>
      <div className="workspace-grid">
        <div className="map-column">
          <SandboxMap pois={pois} session={session} highlighted={highlight} />
          <div className="metrics-row">
            <div><span className="metric-icon"><Database size={18} /></span><span><small>空间参照点</small><strong>{poiRegistry.size} <em>POI</em></strong></span></div>
            <div><span className="metric-icon"><Activity size={18} /></span><span><small>已处理火情信息</small><strong>{session?.processed_count ?? 0}<em> / {session?.post_count ?? 100} 条</em></strong></span></div>
            <div><span className="metric-icon"><CircleDot size={18} /></span><span><small>活跃证据簇</small><strong>{prediction?.active_cluster_count ?? '—'}<em> 个</em></strong></span></div>
            <div><span className="metric-icon"><Crosshair size={18} /></span><span><small>Top1 距离误差</small><strong>{completed && session.evaluation?.distance_m != null ? session.evaluation.distance_m.toFixed(3) : '—'}<em> m</em></strong></span></div>
          </div>
          <p className="map-footnote"><ShieldCheck size={13} />真实火点仅用于展示与评估，不参与推理和候选排名。</p>
        </div>
        <aside className="control-column">
          <section className="control-card"><div className="card-heading"><span><Activity size={17} /><h2>火情场景配置</h2></span><span className="tag-muted">SCENARIO CONTROL</span></div>
            <div className="control-body"><label className="field-label" htmlFor="scenario">火情场景<span>{scenarios.length} 个储罐</span></label><select id="scenario" value={targetId} disabled={busy || !connected} onChange={e => setTargetId(e.target.value)}>{!scenarios.length && <option value="">等待场景加载</option>}{scenarios.map(p => <option value={p.poi_id} key={p.poi_id}>{p.name}</option>)}</select>
              <div className="ground-truth-box"><MapPin size={16} /><div><small>GROUND TRUTH · 真实着火位置</small><strong>{session?.ground_truth.name ?? (preparing ? '正在准备场景…' : '尚未准备')}</strong><span>{session?.ground_truth.poi_id ?? '等待场景准备'}</span></div></div>
              <div className="mode-switch" role="group" aria-label="运行模式"><button className={mode === 'offline' ? 'chosen' : ''} disabled={busy} onClick={() => setMode('offline')}>Offline <span>离线模拟</span></button><button className={mode === 'live' ? 'chosen live' : ''} disabled={busy} onClick={() => setMode('live')}>Live <span>付费模型</span></button></div>
              <p className={`mode-note ${mode}`}>{mode === 'offline' ? '规则提取 + 字符哈希向量 · 无外部模型调用' : '真实 Chat + Embedding · 启动前确认 API 费用'}</p>
              <div className="run-buttons"><button className={`primary-button ${completed ? 'is-completed' : ''}`} aria-label="开始定位" disabled={!connected || busy || session?.status !== 'prepared'} onClick={() => void run()}>{busy ? <LoaderCircle size={17} className="spin" /> : completed ? <Check size={17} /> : <Play size={15} fill="currentColor" />}<span>{preparing ? '准备场景中' : running ? '正在定位' : completed ? '定位完成' : session?.status === 'failed' ? '请重置后重试' : '开始定位'}<small data-testid="run-button-state">{buttonState}</small></span></button><button className="secondary-button reset-button" aria-label="重置演示" disabled={!session || busy || !connected} onClick={() => void reset()}><RotateCcw size={16} />重置</button></div>
              <div className="algorithm-status" role="status" aria-live="polite"><i className={running ? 'pulse-dot' : completed ? 'complete-dot' : ''} /><span>{stage}</span><small>{running ? `第 ${session?.batch_count ?? 0} 批 · ${session?.processed_count ?? 0} 条` : completed ? '实际算法结果' : `种子 ${seed} · ${session?.post_count ?? 100} 条帖子`}</small></div>
              {session?.error && <div className="run-error" role="alert"><AlertCircle size={17} /><div><strong>定位未完成，请重置后重试</strong><p>场景已保留，可重新运行当前场景。</p><details><summary>查看错误详情</summary><strong>{session.error.error_type}</strong><p>{session.error.message}</p></details></div></div>}
            </div>
          </section>
          <section className="results-card" aria-label="定位结果"><div className="card-heading"><span><Target size={17} /><h2>定位结果</h2></span><span className="tag-muted">AI PREDICTION</span></div>
            {top1 ? <div className="result-body" key={session?.session_id}><div className="top1-heading"><span className="prediction-kicker">火灾预测位置</span><span className={session?.evaluation?.top1_hit ? 'hit-badge' : 'miss-badge'}>{session?.evaluation ? session.evaluation.top1_hit ? <><Check size={12} />命中真实火点</> : '未命中真实火点' : '暂无评估'}</span></div><h3 data-testid="top1-name">{top1.name}</h3><p className="poi-id">{top1.poi_id}<span>TOP 1</span></p>
                <div className="error-metric"><div><Crosshair size={15} /><span>与真实火点的距离误差</span></div><strong data-testid="distance-error">{session?.evaluation?.distance_m != null ? session.evaluation.distance_m.toFixed(2) : '—'}<small>m</small></strong></div>
                <div className="candidate-heading">Top3 候选位置<small>点击高亮地图</small></div><div className="candidate-list">{candidates.map(candidate => <button key={candidate.poi_id} className={`candidate-row ${selectedRank === candidate.rank ? 'selected' : ''}`} onClick={() => setSelectedRank(candidate.rank)} aria-label={`高亮候选 ${candidate.rank} ${candidate.name}`} aria-pressed={selectedRank === candidate.rank}><span className="rank-number">0{candidate.rank}</span><div><strong>{candidate.name}</strong><small>{candidate.region_name ? candidate.region_name+" ? " : ""}{candidate.poi_id}</small><i style={{ width: `${Math.min(100, Math.max(0, candidate.relative_score * 100))}%` }} /></div><span className="candidate-score">{candidate.score.toFixed(3)}<small>得分 · {candidate.votes} 票</small></span><ArrowUpRight size={14} /></button>)}</div><p className="score-note">原始算法得分排序 · 相对得分不代表火灾概率</p>
              </div>
              : <div className={`empty-results ${running ? 'analyzing' : ''}`} data-testid="empty-results"><div>{running ? <LoaderCircle size={28} className="spin" /> : <Crosshair size={30} />}</div><h3>{session?.status === 'failed' ? '本轮定位未完成' : completed ? '当前没有定位候选' : running ? '正在分析火情证据' : '等待算法定位'}</h3><p>{session?.status === 'failed' ? '请重置场景后重试，错误详情见上方提示。' : completed ? '算法未发现有效储罐证据。可重置或更换场景重试。' : running ? '正在处理火情证据，每批完成后更新预测位置与 Top3。' : '选择火情场景，开始定位后查看空间推理结果。'}</p><span>{running ? 'ANALYZING...' : 'LOCATION INFERENCE'}</span></div>}
            <details className="runtime-details"><summary>运行信息<span>{stage}</span></summary><dl><div><dt>运行模式</dt><dd>{mode === 'offline' ? 'Offline · 规则提取 / 字符哈希向量' : 'Live · Chat / Embedding'}</dd></div><div><dt>处理批次</dt><dd>{session?.batch_count ?? 0}</dd></div><div><dt>无候选信息</dt><dd>{session?.ignored_count ?? 0} 条</dd></div><div><dt>预测坐标</dt><dd>{top1 ? `(${top1.coordinates.x_m.toFixed(3)}, ${top1.coordinates.y_m.toFixed(3)}) m` : '—'}</dd></div><div><dt>真实坐标</dt><dd>{session ? `(${session.ground_truth.coordinates.x_m.toFixed(3)}, ${session.ground_truth.coordinates.y_m.toFixed(3)}) m` : '—'}</dd></div><div><dt>会话 ID</dt><dd>{session?.session_id ?? '等待创建'}</dd></div></dl></details>
          </section>
        </aside>
      </div>
      <footer><span>城市火灾应急管理系统 · 城市应急态势</span><span>{mode === 'offline' ? 'Offline 离线模式' : 'Live 模型模式'}<i />CITY90x75 · 仿真单位</span></footer>
    </main>
    {confirmLive && <LiveConfirmation postCount={session?.post_count ?? 100} onCancel={() => setConfirmLive(false)} onConfirm={() => void run(true)} />}
  </div>;
}
