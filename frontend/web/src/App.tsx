import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AlertCircle, ArrowUpRight, Check, ChevronRight, Crosshair, Flame, LoaderCircle, Play, RotateCcw, ShieldCheck, Target, Wifi, WifiOff } from 'lucide-react';
import SandboxMap from './components/SandboxMap';
import LiveConfirmation from './components/LiveConfirmation';
import OpinionPanel from './components/OpinionPanel';
import SimulationSettingsModal from './components/SimulationSettingsModal';
import FireScenePanel, { FireSceneInfo } from './components/FireScenePanel';
import { api } from './services/api';
import type { Candidate, FireSceneSeverity, Mode, Poi, Session, SceneActorSnapshot } from './types';
import { TrafficSimulation } from './utils/trafficSimulation';
import { connectTrafficControl } from './utils/trafficSignalController';
import EmergencyPanel from './components/EmergencyPanel';
import EmergencyDemoControls from './components/EmergencyDemoControls';
import { EmergencyService } from './utils/emergency';
import { EmergencyDemo, type DemoNotice } from './utils/emergencyDemo';
import { createOpinionFeed, useSocialNetPosts } from './utils/opinionFeed';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请检查本地桥接服务。';
const demoEnabled = import.meta.env.VITE_EMERGENCY_DEMO !== 'false';

function createSimulation(notify: (notice: DemoNotice) => void, revision = 0) {
  const traffic = new TrafficSimulation();
  const emergency = new EmergencyService(traffic);
  const demo = demoEnabled ? new EmergencyDemo(emergency, notify) : undefined;
  return { traffic, emergency, demo, revision };
}

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [mapPaused, setMapPaused] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [reload, setReload] = useState(0);
  const [prepareNonce, setPrepareNonce] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const restoringStream = useRef(false);
  const sceneActors = useRef<readonly SceneActorSnapshot[]>([]);
  const [notice, setNotice] = useState<DemoNotice>();
  const [simulation, setSimulation] = useState(() => createSimulation(setNotice));
  const { traffic, emergency, demo } = simulation;
  useEffect(() => connectTrafficControl(traffic.signals), [traffic]);
  useEffect(() => emergency.attach(demo), [emergency, demo]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  const emergencyState = useSyncExternalStore(emergency.subscribe, emergency.getSnapshot);
  const incident = emergencyState.incident;
  const demoConnected = demo && emergency.isConnectedTo(demo);
  const demoIncident = demo?.owns(incident) ?? false;
  const activeIncident = !!incident && incident.phase !== 'completed';
  const sceneIncident = incident && (activeIncident || (demoIncident ? demo?.hasStarted(session?.session_id) : incident.targetPoiId === targetId)) ? incident : null;
  const assessment = sceneIncident?.assessment;
  const severity: FireSceneSeverity = assessment?.status === 'completed' ? assessment.severity : demoIncident ? demo!.getSeverity() : 1;
  const fireTargetId = sceneIncident?.targetPoiId ?? session?.ground_truth.poi_id ?? null;
  const fireStatus = sceneIncident?.fireStatus ?? 'normal';
  const seed = 42;
  const sessionId = session?.session_id;
  const streaming = session?.status === 'running';
  const paused = streaming ? (session.paused ?? false) || pauseRequested : mapPaused;
  const opinionFeed = useMemo(() => createOpinionFeed(sessionId), [sessionId]);
  const feedState = useSocialNetPosts(sessionId, streaming, paused, opinionFeed);

  useEffect(() => {
    if (activeIncident && !demoIncident && !streaming) setTargetId(incident.targetPoiId);
  }, [activeIncident, demoIncident, incident?.targetPoiId, streaming]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.health(), api.pois(), api.scenarios(), api.active()]).then(([, points, data, restored]) => {
      if (cancelled) return;
      if (restored) {
        restoringStream.current = true;
        setSession(restored);
        setMode(restored.mode);
      }
      setPois(points); setScenarios(data.scenarios); setTargetId(restored?.target_poi_id ?? data.default_target_poi_id); setConnected(true); setError(null);
    }).catch(err => { if (!cancelled) { setConnected(false); setError(`桥接服务未连接：${errorMessage(err)}`); } });
    const timer = window.setInterval(() => { api.health().then(() => { if (!cancelled) setConnected(true); }).catch(() => { if (!cancelled) setConnected(false); }); }, 10000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [reload]);

  useEffect(() => {
    if (!targetId) return;
    if (restoringStream.current) { restoringStream.current = false; return; }
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

  const running = streaming && !paused && !session.analysis_frozen && !session.error;
  const busy = preparing || starting || changing;
  const canReset = !!session && connected && !busy && (!activeIncident || demoIncident);
  const completed = session?.status === 'completed';
  const prediction = session?.prediction ?? null;
  const candidates = prediction?.candidates ?? [];
  const top1 = candidates.find(c => c.rank === 1);
  const highlight: Candidate | null = candidates.find(c => c.rank === selectedRank) ?? null;
  const stage = preparing ? '准备场景' : starting ? '启动 SocialNet' : pauseRequested ? '正在暂停' : session?.error ? '仿真或定位异常' :
    completed ? '本轮已结束' : streaming && paused ? '仿真已暂停' : session?.analysis_frozen ? '定位已冻结 · 继续收帖' :
    running ? '等待火情帖并定位' : session ? '场景就绪' : connected ? '等待准备' : '等待连接';

  useEffect(() => {
    if (!streaming || changing || !sessionId) return;
    const id = sessionId;
    const revision = generation.current;
    let cancelled = false;
    let timer: number | undefined;
    async function poll() {
      try {
        const current = await api.session(id);
        if (!cancelled && generation.current === revision) setSession(current);
      } catch { /* Retry only the status read. */ }
      if (!cancelled) timer = window.setTimeout(poll, 1000);
    }
    timer = window.setTimeout(poll, 1000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [changing, sessionId, streaming]);

  async function run(confirmed = false) {
    if (!session || session.status !== 'prepared' || inFlight.current || !connected) return;
    if (!confirmed) { setConfirmLive(true); return; }
    setConfirmLive(false); inFlight.current = true; setStarting(true); setError(null); setSelectedRank(1);
    const revision = generation.current;
    const id = session.session_id;
    try {
      const current = await api.run(id, confirmed, mapPaused);
      if (generation.current === revision) setSession(current);
    } catch (err) {
      if (generation.current === revision) {
        setError(errorMessage(err));
        // Recover actual state without re-submitting a potentially paid run.
        try { const recovered = await api.session(id); if (generation.current === revision) setSession(recovered); } catch { /* keep last known state */ }
      }
    } finally { if (generation.current === revision) { setStarting(false); inFlight.current = false; } }
  }

  async function resetAll() {
    if (!canReset || !session || inFlight.current) return;
    inFlight.current = true;
    const id = session.session_id;
    const revision = ++generation.current;
    setChanging(true); setError(null); setConfirmLive(false);
    try {
      const next = await api.reset(id);
      if (generation.current !== revision) return;
      setSession(next); setSelectedRank(1); setNotice(undefined); setMapPaused(false);
      sceneActors.current = [];
      setSimulation(createSimulation(setNotice, simulation.revision + 1));
    }
    catch (err) { if (generation.current === revision) setError(errorMessage(err)); }
    finally { if (generation.current === revision) { setChanging(false); inFlight.current = false; } }
  }

  async function togglePause() {
    if (inFlight.current) return;
    if (!streaming || !sessionId) {
      setMapPaused(value => !value);
      return;
    }
    const nextPaused = !paused;
    inFlight.current = true;
    const revision = ++generation.current;
    setChanging(true); setPauseRequested(nextPaused); setError(null);
    try {
      const current = await api.setPause(sessionId, nextPaused);
      if (generation.current !== revision) return;
      setSession(current);
      setMapPaused(current.paused ?? false);
    } catch (err) {
      if (generation.current === revision) setError(errorMessage(err));
    } finally {
      setPauseRequested(false);
      setChanging(false);
      inFlight.current = false;
    }
  }

  async function emergencyAction(action: 'handoff' | 'stop') {
    if (!sessionId || !demo || inFlight.current) return;
    inFlight.current = true;
    ++generation.current;
    setChanging(true);
    try {
      const current = await api[action](sessionId);
      setSession(current);
      if (action === 'handoff') demo.start(sessionId, current.ground_truth.poi_id, current.prediction?.candidates ?? []);
      else demo.confirmExtinction();
    } finally {
      setChanging(false);
      inFlight.current = false;
    }
  }

  return <div className="application-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-symbol"><Flame size={23} /></div><div><span className="brand-name">URBAN INTELLIGENCE LAB</span><span>城市应急态势 · 实时感知</span></div></div>
      <div className="topbar-title"><span>数字孪生沙盘</span><ChevronRight size={14} /><strong>火情定位智能体</strong></div>
      <div className="header-status"><span className={connected ? 'connection connected' : 'connection'}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connected ? 'Bridge：已连接' : 'Bridge：未连接'}</span><span className={`mode-badge ${mode}`}><i />SocialNet · {mode === 'offline' ? '离线定位' : 'Live 定位'}</span></div>
    </header>
    <main>
      <div className="page-heading"><div><div className="eyebrow">Agent-based Urban Fire Localization System</div><h1>城市火灾应急管理系统</h1><p>城市数字孪生 · 多源火情感知 · 实时空间定位</p></div><div className="research-label"><ShieldCheck size={19} /><span>城市应急态势中心<small>多源信息 → 空间推理 → 定位评估</small></span></div></div>
      {error && <div className="error-banner" role="alert"><AlertCircle size={18} /><div><strong>{connected ? '本次操作未完成' : '桥接服务未连接'}</strong><p>{error}</p></div>{!session && <button disabled={busy} onClick={() => { if (!connected) setReload(v => v+1); else setPrepareNonce(v => v+1); }}>重新准备</button>}</div>}
      <div className="workspace-grid">
        <div className="map-column" key={simulation.revision}>
          <div className="map-region">
            <SandboxMap pois={pois} session={session} targetId={fireTargetId} highlighted={highlight} sceneActors={sceneActors} severity={severity} traffic={traffic} emergency={emergency} demoNotice={demoConnected && sceneIncident ? notice : undefined}
              paused={paused} pauseBusy={starting || changing} onTogglePause={() => void togglePause()} />
          </div>
          <FireScenePanel targetId={fireTargetId} status={fireStatus} actors={sceneActors} severity={severity} showInfo={false} />
        </div>
        <aside className="control-column" aria-label="综合控制面板">
          <OpinionPanel feed={opinionFeed} source="SocialNet 火情初筛" {...feedState} onOpenSettings={() => setSettingsOpen(true)}>
            <div className="run-buttons"><button className={`primary-button ${completed ? 'is-completed' : ''}`} aria-label="开始仿真" disabled={!connected || busy || session?.status !== 'prepared'} onClick={() => void run()}>{busy ? <LoaderCircle size={17} className="spin" /> : completed ? <Check size={17} /> : <Play size={15} fill="currentColor" />}<span>{stage === '场景就绪' ? '开始仿真' : stage}</span></button><button className="secondary-button reset-button" disabled={!canReset} onClick={() => void resetAll()} title="停止 SocialNet，清空主项目历史会话和帖子缓存"><RotateCcw size={16} />全局重置</button></div>
            <div className="algorithm-status" role="status" aria-live="polite"><i className={running ? 'pulse-dot' : completed ? 'complete-dot' : ''} /><span>{stage}</span><small>{session ? `已收 ${session.post_count} 条 · 定位 ${session.processed_count} 条 / ${session.batch_count} 批` : '等待定位进度'}</small></div>
            {session?.error && <div className="run-error" role="alert"><AlertCircle size={17} /><div><strong>仿真或定位异常</strong><details><summary>查看错误详情</summary><strong>{session.error.error_type}</strong><p>{session.error.message}</p></details></div></div>}
          </OpinionPanel>
          <section className="results-card" aria-label="定位结果"><div className="card-heading"><span><Target size={17} /><h2>定位结果</h2></span><span className="tag-muted">AI PREDICTION</span></div>
            <div className="result-content" role="region" aria-label="定位结果详情" tabIndex={0}>
            {top1 ? <div className="result-body" key={session?.session_id}><div className="top1-heading"><span className="prediction-kicker">火灾预测位置</span><span className={session?.evaluation?.top1_hit ? 'hit-badge' : 'miss-badge'}>{session?.evaluation ? session.evaluation.top1_hit ? <><Check size={12} />命中真实火点</> : '未命中真实火点' : '暂无评估'}</span></div><h3 data-testid="top1-name">{top1.name}</h3><p className="poi-id">{top1.poi_id}<span>TOP 1</span></p>
                <div className="error-metric"><div><Crosshair size={15} /><span>与真实火点的距离误差</span></div><strong data-testid="distance-error">{session?.evaluation?.distance_m != null ? session.evaluation.distance_m.toFixed(2) : '—'}<small>m</small></strong></div>
                <div className="candidate-heading">Top3 候选位置<small>点击高亮地图</small></div><div className="candidate-list">{candidates.map(candidate => <button key={candidate.poi_id} className={`candidate-row ${selectedRank === candidate.rank ? 'selected' : ''}`} onClick={() => setSelectedRank(candidate.rank)} aria-label={`高亮候选 ${candidate.rank} ${candidate.name}`} aria-pressed={selectedRank === candidate.rank}><span className="rank-number">0{candidate.rank}</span><div><strong>{candidate.name}</strong><small>{candidate.region_name ? candidate.region_name+" · " : ""}{candidate.poi_id}</small><i style={{ width: `${Math.min(100, Math.max(0, candidate.relative_score * 100))}%` }} /></div><span className="candidate-score">{candidate.score.toFixed(3)}<small>得分 · {candidate.votes} 票</small></span><ArrowUpRight size={14} /></button>)}</div><p className="score-note">原始算法得分排序 · 相对得分不代表火灾概率</p>
              </div>
              : <div className={`empty-results ${running ? 'analyzing' : ''}`} data-testid="empty-results"><div>{running ? <LoaderCircle size={28} className="spin" /> : <Crosshair size={30} />}</div><h3>{session?.status === 'failed' ? '本轮定位未完成' : completed ? '当前没有定位候选' : running ? '正在分析火情证据' : '等待算法定位'}</h3><p>{session?.status === 'failed' ? '请重置场景后重试，错误详情见上方提示。' : completed ? '算法未发现有效储罐证据。可重置或更换场景重试。' : running ? '正在处理火情证据，每批完成后更新预测位置与 Top3。' : '选择火情场景并开始仿真，每收到 3 条火情帖更新一次定位。'}</p><span>{running ? 'ANALYZING...' : 'LOCATION INFERENCE'}</span></div>}
            <details className="runtime-details"><summary>运行信息<span>{stage}</span></summary><dl><div><dt>运行模式</dt><dd>{mode === 'offline' ? 'Offline · 规则提取 / 字符哈希向量' : 'Live · Chat / Embedding'}</dd></div><div><dt>处理批次</dt><dd>{session?.batch_count ?? 0}</dd></div><div><dt>无候选信息</dt><dd>{session?.ignored_count ?? 0} 条</dd></div><div><dt>预测坐标</dt><dd>{top1 ? `(${top1.coordinates.x_m.toFixed(3)}, ${top1.coordinates.y_m.toFixed(3)}) m` : '—'}</dd></div><div><dt>真实坐标</dt><dd>{session ? `(${session.ground_truth.coordinates.x_m.toFixed(3)}, ${session.ground_truth.coordinates.y_m.toFixed(3)}) m` : '—'}</dd></div><div><dt>会话 ID</dt><dd>{session?.session_id ?? '等待创建'}</dd></div></dl></details>
            </div>
          </section>
          <EmergencyPanel key={simulation.revision} service={emergency} automatic={demoConnected && demoIncident} demoControls={demoConnected && <EmergencyDemoControls
            demo={demo} active={activeIncident} pending={emergencyState.pending || busy}
             onHandoff={() => emergencyAction('handoff')} onExtinguish={() => emergencyAction('stop')}
            handoff={streaming && top1 ? { sessionId: session.session_id, groundTruth: session.ground_truth, candidates } : undefined}
          />} />
          <FireSceneInfo targetId={fireTargetId} status={fireStatus} />
        </aside>
      </div>
      <footer><span>城市火灾应急管理系统 · 城市应急态势</span><span>{mode === 'offline' ? 'Offline 离线模式' : 'Live 模型模式'}<i />CITY90x75 · 仿真单位</span></footer>
    </main>
    {settingsOpen && <SimulationSettingsModal scenarios={scenarios} targetId={targetId} groundTruth={session?.ground_truth}
      mode={mode} preparing={preparing} busy={busy || session?.status !== 'prepared'} connected={connected} activeIncident={activeIncident}
      onTargetChange={setTargetId} onModeChange={setMode} onClose={() => setSettingsOpen(false)} />}
    {confirmLive && <LiveConfirmation live={mode === 'live'} onCancel={() => setConfirmLive(false)} onConfirm={() => void run(true)} />}
  </div>;
}
