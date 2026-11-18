import { useSyncExternalStore } from 'react';
import { AlertCircle, Check, Radio, ScanEye, Truck } from 'lucide-react';
import { droneStatusLabels, phaseLabels, severityLabels, type EmergencyService } from '../utils/emergency';
import { poiRegistry } from '../utils/poiRegistry';

export default function EmergencyPanel({ service }: { service: EmergencyService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const incident = state.incident, assessment = incident?.assessment;
  return <section className="emergency-card" aria-label="应急联动指挥">
    <div className="card-heading"><span><Radio size={17} /><h2>应急联动指挥</h2></span><span className={`emergency-source ${state.connected ? 'online' : ''}`}>{state.connected ? state.source ?? '调度已连接' : '等待调度连接'}</span></div>
    <div className="emergency-body">
      <div className="emergency-phase" role="status" data-testid="emergency-phase" data-phase={incident?.phase ?? 'idle'}><i />{phaseLabels[incident?.phase ?? 'idle']}</div>
      <div className="drone-fleet" aria-label="无人机机队">{state.drones.map(drone => <div key={drone.id} data-drone-card={drone.id}>
        <ScanEye size={17} /><span><strong>{drone.id}</strong><small>{droneStatusLabels[drone.status]}</small></span><em>{drone.altitude > 0 ? '空中' : '停靠'}</em>
      </div>)}</div>
      <div className="emergency-content" role="region" aria-label="应急任务详情" tabIndex={0}>
      {!incident && <div className="emergency-standby"><Radio size={32} aria-hidden="true" /><p className="emergency-empty">当前无应急任务，城市交通正常运行。</p></div>}
      {incident && <>
        <dl className="emergency-details"><div><dt>侦察目标</dt><dd>{poiRegistry.get(incident.targetPoiId)?.name}<small>{incident.targetPoiId}</small></dd></div>
          <div><dt>火情等级</dt><dd>{assessment?.status === 'completed' ? severityLabels[assessment.severity] : assessment?.status === 'failed' ? '评估失败' : '等待侦察评估'}</dd></div>
          <div><dt>侦察结果</dt><dd>{assessment?.status === 'completed' ? assessment.result : '等待外部侦察结果'}</dd></div>
          {assessment?.source && <div><dt>评估来源</dt><dd>{assessment.source}</dd></div>}
        </dl>
        {incident.plan && <div className="emergency-plan" data-testid="emergency-plan"><h3><Truck size={16} />调度方案 · {incident.plan.dispatches.length} 辆消防车</h3><p>{incident.plan.summary}</p>
          <ul>{incident.plan.dispatches.map(dispatch => <li key={dispatch.vehicleId}><strong>{dispatch.vehicleId}</strong><span>目标 {dispatch.targetPoiId} · ({dispatch.targetPosition.x.toFixed(2)}, {dispatch.targetPosition.y.toFixed(2)})</span></li>)}</ul>
          <p className="emergency-policy">{incident.plan.trafficLockdown ? '消防路线沿线信号优先 · 冲突方向停车' : '保持正常交通信号'}</p>
        </div>}
        {incident.cancelled && <div className="emergency-cancelled"><p>方案已取消，侦察结果已保留。</p><button className="secondary-button" onClick={() => service.reopen()}>重新审核方案</button></div>}
        {incident.error && <div className="emergency-error" role="alert"><AlertCircle size={16} /><p>{incident.error}</p>{incident.phase === 'failed' && <button className="secondary-button" disabled={state.pending || !state.connected} onClick={() => void service.retry()}>重新请求</button>}</div>}
      </>}
      {state.inputError && <div className="emergency-error" role="alert"><AlertCircle size={16} /><p>{state.inputError}</p></div>}
      </div>
      {incident?.phase === 'awaiting_confirmation' && <div className="emergency-actions"><button className="primary-button" disabled={state.pending || !state.connected} onClick={() => void service.confirm()}><Check size={16} />{state.pending ? '正在执行方案' : '确认并执行方案'}</button><button className="secondary-button" disabled={state.pending} onClick={() => service.cancel()}>取消执行</button></div>}
    </div>
  </section>;
}
