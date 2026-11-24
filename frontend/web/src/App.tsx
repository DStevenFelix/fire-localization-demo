import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AlertCircle, Flame, LoaderCircle, Play, RotateCcw, Settings } from 'lucide-react';
import SandboxMap from './components/SandboxMap';
import LiveConfirmation from './components/LiveConfirmation';
import OpinionPanel from './components/OpinionPanel';
import SimulationSettingsModal from './components/SimulationSettingsModal';
import FireScenePanel from './components/FireScenePanel';
import LocationPanel from './components/LocationPanel';
import MediaPanel from './components/MediaPanel';
import DispatchLog from './components/DispatchLog';
import { api } from './services/api';
import { connectionLabels, DashboardInput, registerDashboard } from './services/dashboardInput';
import { connectPhysicalDashboardSource } from './config/dashboardSource';
import type { Candidate, FireSceneSeverity, Mode, OpinionPost, Poi, Session, SceneActorSnapshot } from './types';
import { TrafficSimulation } from './utils/trafficSimulation';
import { connectTrafficControl } from './utils/trafficSignalController';
import { subscribeLiveTrafficSignals } from './utils/liveTrafficSignals';
import EmergencyPanel from './components/EmergencyPanel';
import EmergencyDemoControls from './components/EmergencyDemoControls';
import { EmergencyService } from './utils/emergency';
import { EmergencyDemo, type DemoNotice } from './utils/emergencyDemo';
import { createOpinionFeed, useSocialNetPosts } from './utils/opinionFeed';
import { mockTruckHomes } from './utils/roadNetwork';
import { connectSimulatedResponders, localPois, observeSimulatedWorld, prepareMockSession, runMockExercise } from './utils/mockExercise';
import { tabletopCalibration } from './utils/deviceCoordinates';
import { tankAtCityPosition } from './utils/fireSceneData';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请检查本地桥接服务。';
const sources = { physical: '真实联动', mock: '本地应急演练', 'bridge-demo': 'SocialNet 联动演练' } as const;
type WorkspaceSource = keyof typeof sources;

function createSimulation(source: WorkspaceSource, notify: (notice: DemoNotice) => void, revision = 0) {
  const mode = source === 'physical' ? 'physical' : 'simulation';
  const traffic = new TrafficSimulation(undefined, undefined, undefined, mode === 'simulation' ? mockTruckHomes : []);
  const emergency = new EmergencyService(traffic);
  const dashboard = new DashboardInput(mode, mode === 'simulation' ? { calibrations: [tabletopCalibration] } : undefined);
  const demo = mode === 'simulation' && (source === 'mock' || import.meta.env.VITE_EMERGENCY_DEMO !== 'false') ? new EmergencyDemo(emergency, notify, dashboard) : undefined;
  return { traffic, emergency, demo, revision, dashboard };
}

export default function App() {
  const [source, setSource] = useState<WorkspaceSource>(() => {
    const value = new URLSearchParams(window.location.search).get('workspace');
    return value === 'mock' || value === 'bridge-demo' ? value : 'physical';
  });
  return <Workspace key={source} source={source} onSourceChange={value => {
    const url = new URL(window.location.href);
    if (value === 'physical') url.searchParams.delete('workspace');
    else url.searchParams.set('workspace', value);
    window.history.replaceState(null, '', url);
    setSource(value);
  }} />;
}

function Workspace({ source, onSourceChange }: { source: WorkspaceSource; onSourceChange: (source: WorkspaceSource) => void }) {
  const standalone = source === 'mock';
  const [pois, setPois] = useState<Poi[]>(localPois);
  const [scenarios, setScenarios] = useState<Poi[]>([]);
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<Mode>('offline');
  const [session, setSession] = useState<Session | null>(() => standalone ? prepareMockSession() : null);
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
  const [simulation, setSimulation] = useState(() => createSimulation(source, setNotice));
  const [mockCount, setMockCount] = useState(4);
  const mockExercise = useRef<ReturnType<typeof runMockExercise>>(undefined);
  const { traffic, emergency, demo, dashboard } = simulation;
  const dashboardState = useSyncExternalStore(dashboard.subscribe, dashboard.getSnapshot);
  useEffect(() => {
    if (dashboard.mode !== 'physical') return;
    let sequence = 0;
    const disconnect = subscribeLiveTrafficSignals(devices => dashboard.consume({ sourceMode: 'physical',
      eventType: 'traffic.snapshot', eventId: `signal-sse:${++sequence}`, occurredAt: Date.now(), payload: { devices },
    }, { report: false }).accepted, () => dashboard.disconnectSignals());
    const expire = window.setInterval(() => dashboard.expirePositions(), 1000);
    return () => { disconnect(); window.clearInterval(expire); };
  }, [dashboard]);
  useEffect(() => traffic.signals.setHardwareSignals(dashboardState.signals), [traffic, dashboardState.signals]);
  useEffect(() => connectTrafficControl(traffic.signals), [traffic]);
  useEffect(() => dashboard.mode === 'simulation' ? emergency.attach(demo) : undefined, [emergency, demo, dashboard]);
  useEffect(() => {
    if (dashboard.mode !== 'simulation') return;
    const unsubscribe = connectSimulatedResponders(dashboard, emergency);
    return () => { unsubscribe(); mockExercise.current?.unsubscribe(); mockExercise.current = undefined; };
  }, [dashboard, emergency]);
  useEffect(() => () => { generation.current++; }, []);
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
  const realDispatch = dashboard.mode === 'physical' ? dashboardState.agents.dispatch : undefined;
  const fireTargetId = realDispatch?.firePosition ? realDispatch.targetPoiId ?? tankAtCityPosition(realDispatch.firePosition) ?? null :
    sceneIncident?.targetPoiId ?? session?.ground_truth.poi_id ?? null;
  const fireStatus = realDispatch?.firePosition ? realDispatch.fireStatus : (sceneIncident?.targetPoiId === fireTargetId ? sceneIncident?.fireStatus : undefined) ??
    (standalone && session?.status === 'running' ? 'burning' : 'normal');
  const seed = 42;
  const sessionId = session?.session_id;
  const streaming = session?.status === 'running';
  const paused = streaming && !standalone ? (session.paused ?? false) || pauseRequested : mapPaused;
  const opinionFeed = useMemo(() => createOpinionFeed(sessionId), [sessionId]);
  useEffect(() => dashboard.setSession(sessionId), [dashboard, sessionId]);
  useEffect(() => {
    const unregister = registerDashboard(dashboard);
    try {
      if (dashboard.mode === 'physical') connectPhysicalDashboardSource();
    } catch (error) {
      unregister();
      throw error;
    }
    return unregister;
  }, [dashboard]);
  const recordPost = useCallback((id: string, post: OpinionPost) => {
    dashboard.consume({ sourceMode: dashboard.mode, eventType: 'agent.event', eventId: `bridge:post:${id}:${post.id}`,
      sessionId: id, occurredAt: Date.parse(post.timestamp ?? '') || Date.now(),
      payload: { agent: 'opinion', type: '收到帖子', phase: '监测中', summary: post.text, object: post.id } }, { report: false });
  }, [dashboard]);
  const feedState = useSocialNetPosts(sessionId, streaming && !standalone, paused, opinionFeed, recordPost);
  useEffect(() => {
    if (!session || standalone) return;
    for (const batch of session.batch_history ?? []) {
      const top1 = batch.prediction.candidates.find(candidate => candidate.rank === 1);
      dashboard.consume({ sourceMode: dashboard.mode, sessionId, eventType: 'agent.event',
        eventId: `bridge:batch:${sessionId}:${batch.batch_number}`, occurredAt: Date.parse(batch.prediction.current_time ?? '') || Date.now(),
        payload: { agent: 'location', type: '批次更新', phase: '候选更新',
          summary: `第 ${batch.batch_number} 批 · 累计定位 ${batch.processed_count} 条${top1 ? ` · ${top1.name}` : ''}` } }, { report: false });
    }
    if (['completed', 'failed'].includes(session.status) || session.analysis_frozen) {
      dashboard.consume({ sourceMode: dashboard.mode, sessionId, eventType: 'agent.event',
        eventId: `bridge:location:${sessionId}:${session.status}:${session.analysis_frozen}`, occurredAt: Date.now(),
        payload: { agent: 'location', type: '定位状态', phase: session.status === 'failed' ? '失败' : '完成',
          summary: session.error?.message ?? `累计定位 ${session.processed_count} 条` } }, { report: false });
    }
  }, [session, sessionId, standalone, dashboard]);

  useEffect(() => {
    if (standalone) return;
    if (activeIncident && !demoIncident && !streaming) setTargetId(incident.targetPoiId);
  }, [activeIncident, demoIncident, incident?.targetPoiId, streaming, standalone]);

  useEffect(() => {
    if (standalone) return;
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
  }, [reload, standalone]);

  useEffect(() => {
    if (standalone || !targetId) return;
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
  }, [targetId, mode, prepareNonce, reload, standalone]);

  const running = streaming && !paused && !session.analysis_frozen && !session.error;
  const busy = preparing || starting || changing;
  const canReset = !!session && (standalone || connected) && !busy && (!activeIncident || demoIncident);
  const completed = session?.status === 'completed';
  const prediction = session?.prediction ?? null;
  const candidates = prediction?.candidates ?? [];
  const top1 = candidates.find(c => c.rank === 1);
  const highlight: Candidate | null = candidates.find(c => c.rank === selectedRank) ?? null;
  useEffect(() => {
    if (source !== 'bridge-demo' || !demoConnected || !session || session.status !== 'running' ||
        !session.analysis_frozen || demo.hasStarted(session.session_id)) return;
    try {
      demo.start(session.session_id, session.prediction?.candidates ?? [], observeSimulatedWorld(session.ground_truth.poi_id));
    } catch (error) {
      setError(errorMessage(error));
    }
  }, [source, demoConnected, demo, session]);

  useEffect(() => {
    if (standalone || !streaming || changing || !sessionId) return;
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
  }, [changing, sessionId, streaming, standalone]);

  async function run(confirmed = false) {
    if (!session || session.status !== 'prepared' || inFlight.current) return;
    if (standalone) {
      if (!demo || mockExercise.current) return;
      setMapPaused(false);
      mockExercise.current = runMockExercise(session, mockCount, dashboard, emergency, demo, setSession,
        post => opinionFeed.receivePost(session.session_id, post));
      return;
    }
    if (!connected) return;
    if (!confirmed) { setConfirmLive(true); return; }
    setConfirmLive(false); inFlight.current = true; setStarting(true); setError(null); setSelectedRank(1);
    const revision = generation.current;
    const id = session.session_id;
    try {
      const current = await api.run(id, confirmed, mapPaused, source === 'bridge-demo' && !!demo);
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
    if (standalone) {
      setSimulation(createSimulation(source, setNotice, simulation.revision + 1));
      setSession(prepareMockSession()); setSelectedRank(1); setNotice(undefined); setMapPaused(false);
      return;
    }
    inFlight.current = true;
    const id = session.session_id;
    const revision = ++generation.current;
    setChanging(true); setError(null); setConfirmLive(false);
    try {
      const next = await api.reset(id);
      if (generation.current !== revision) return;
      setSession(next); setSelectedRank(1); setNotice(undefined); setMapPaused(false);
      sceneActors.current = [];
      if (source === 'bridge-demo') setSimulation(createSimulation(source, setNotice, simulation.revision + 1));
    }
    catch (err) { if (generation.current === revision) setError(errorMessage(err)); }
    finally { if (generation.current === revision) { setChanging(false); inFlight.current = false; } }
  }

  async function togglePause() {
    if (inFlight.current) return;
    if (standalone || !streaming || !sessionId) {
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
    if (standalone) {
      if (action === 'handoff') mockExercise.current?.handoff();
      else demo.confirmExtinction();
      return;
    }
    inFlight.current = true;
    ++generation.current;
    setChanging(true);
    try {
      const current = await api[action](sessionId);
      setSession(current);
      if (action === 'stop') demo.confirmExtinction();
    } finally {
      setChanging(false);
      inFlight.current = false;
    }
  }

  const sourceConnections = Object.entries(dashboardState.connections);
  const opinionStatus = standalone ? {
    status: paused ? '滚动已暂停' : streaming ? session.post_count ? '监测中' : '等待模拟火情帖' : completed ? '监测完成' : '等待开始演练',
    scanning: streaming && !paused, receivedTotal: session?.post_count,
  } : { ...feedState, status: streaming || feedState.receivedTotal ? feedState.status : dashboardState.agents.opinion?.phase ?? feedState.status };

  return <div className="application-shell dashboard-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-symbol"><Flame size={20} /></div><h1>火灾应急管理沙盘</h1></div>
      <div className="header-status">
        <label className="source-choice">数据来源<select aria-label="数据来源" value={source} disabled={busy}
          onChange={event => onSourceChange(event.target.value as WorkspaceSource)}>
          {Object.entries(sources).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <span className={connected || standalone ? 'connection connected' : 'connection'} data-testid="dashboard-source" data-source-mode={dashboard.mode}>
          {standalone ? '模拟数据' : connected ? 'Bridge 已连接' : 'Bridge 未连接'}
        </span>
        {sourceConnections.map(([name, state]) => <span key={name} className="source-status">{name} · {standalone && state === 'online' ? '已启动' : connectionLabels[state]}</span>)}
        {dashboard.mode === 'physical' && !sourceConnections.length && <span className="source-status">设备联动 · 待连接</span>}
      </div>
      <div className="workspace-actions">
        {standalone ? <label className="source-choice">模拟派车<select aria-label="模拟派车数量" value={mockCount} disabled={session?.status !== 'prepared'}
          onChange={event => setMockCount(Number(event.target.value))}>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count} 辆</option>)}</select></label> :
          <button className="secondary-button" type="button" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}><Settings size={15} />仿真设置</button>}
        <button className="primary-button" aria-label={standalone ? '开始演练' : '开始仿真'}
          disabled={(!standalone && !connected) || busy || session?.status !== 'prepared'} onClick={() => void run()}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Play size={14} fill="currentColor" />}{standalone ? '开始演练' : '开始仿真'}</button>
        <button className="secondary-button" disabled={!canReset} onClick={() => void resetAll()}><RotateCcw size={15} />全局重置</button>
      </div>
    </header>
    <main className="dashboard-main">
      {(error || session?.error || dashboardState.rejected) && <div className={`workspace-error${session?.error ? ' run-error' : ''}`} role="alert">
        <AlertCircle size={16} /><strong>{session?.error ? '仿真或定位异常' : '接入状态'}</strong>
        {session?.error ? <details><summary>查看错误详情</summary><p><strong>{session.error.error_type}</strong> · {session.error.message}</p></details> :
          error && <span>{error}</span>}
        {dashboardState.rejected && <span data-testid="dashboard-input-error">{dashboardState.rejected}</span>}
        {error && !session && <button disabled={busy} onClick={() => { if (!connected) setReload(value => value + 1); else setPrepareNonce(value => value + 1); }}>重新准备</button>}
      </div>}
      <div className="workspace-grid" key={simulation.revision}>
        <aside className="media-column" aria-label="现场媒体与三维火场">
          <MediaPanel group="air" media={dashboardState.media} />
          <MediaPanel group="ground" media={dashboardState.media} />
          <FireScenePanel targetId={fireTargetId} status={fireStatus} actors={sceneActors} severity={severity} showInfo={false} />
        </aside>
        <div className="map-column">
          <SandboxMap pois={pois} session={session} targetId={fireTargetId} firePosition={realDispatch?.firePosition} fireState={fireStatus} highlighted={highlight} sceneActors={sceneActors} severity={severity}
            traffic={traffic} dashboard={dashboard} emergency={emergency} demoNotice={demoConnected && sceneIncident ? notice : undefined}
            paused={paused} pauseBusy={starting || changing} onTogglePause={() => void togglePause()} />
        </div>
        <aside className="control-column" aria-label="智能体与调度记录">
          <OpinionPanel feed={opinionFeed} source={standalone ? '演练火情帖' : 'SocialNet 火情初筛'} {...opinionStatus} />
          <LocationPanel session={session} running={running} selectedRank={selectedRank} onSelect={setSelectedRank} agent={dashboardState.agents.location} />
          <EmergencyPanel service={emergency} dashboard={dashboardState} automatic={demoConnected && demoIncident} demoControls={
            demoConnected && <EmergencyDemoControls demo={demo} active={activeIncident} pending={emergencyState.pending || busy}
              onHandoff={() => emergencyAction('handoff')} onExtinguish={() => emergencyAction('stop')}
              handoff={streaming && top1 ? { sessionId: session.session_id, candidates,
                done: session.analysis_frozen, trigger: session.handoff_trigger } : undefined} />} />
          <DispatchLog entries={dashboardState.log} />
        </aside>
      </div>
    </main>
    {settingsOpen && <SimulationSettingsModal scenarios={scenarios} targetId={targetId} groundTruth={session?.ground_truth}
      mode={mode} preparing={preparing} busy={busy || session?.status !== 'prepared'} connected={connected} activeIncident={activeIncident}
      onTargetChange={setTargetId} onModeChange={setMode} onClose={() => setSettingsOpen(false)} />}
    {confirmLive && <LiveConfirmation live={mode === 'live'} onCancel={() => setConfirmLive(false)} onConfirm={() => void run(true)} />}
  </div>;
}
