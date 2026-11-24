import { useSyncExternalStore, type ReactNode } from 'react';
import { AlertCircle, Check, Radio, ScanEye, Truck } from 'lucide-react';
import { droneStatusLabels, phaseLabels, severityLabels, type EmergencyService } from '../utils/emergency';
import { poiRegistry } from '../utils/poiRegistry';
import { candidateStageLabels, connectionLabels, deviceStatusLabels, type DashboardSnapshot } from '../services/dashboardInput';
import { deviceQuality } from './VehicleLayer';

export default function EmergencyPanel({ service, dashboard, demoControls, automatic = false }: { service: EmergencyService; dashboard?: DashboardSnapshot; demoControls?: ReactNode; automatic?: boolean }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const incident = state.incident, assessment = incident?.assessment;
  const dispatch = dashboard?.agents.dispatch;
  const candidateIncident = incident?.id ?? dispatch?.incidentId ?? dashboard?.reconnaissance.at(-1)?.incidentId;
  const candidates = dashboard?.reconnaissance.filter(report => report.incidentId === candidateIncident)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return <section className="emergency-card" aria-label="应急联动指挥">
    <div className="card-heading"><span><Radio size={16} /><h2>调度 Agent</h2></span><span className={`emergency-source ${state.connected ? 'online' : ''}`}>{state.connected ? state.source ?? '调度已连接' : dispatch ? '已收到调度消息' : '等待调度连接'}</span></div>
    <div className="emergency-body">
      <div className="emergency-phase" role="status" data-testid="emergency-phase" data-phase={incident?.phase ?? dispatch?.phase ?? 'idle'}><i />{incident ? phaseLabels[incident.phase] : dispatch?.phase ?? '等待任务'}</div>
      <div className="emergency-content" role="region" aria-label="应急任务详情" tabIndex={0}>
      {dispatch && !incident && <p className="emergency-empty" data-incident-id={dispatch.incidentId} data-task-id={dispatch.taskId}
        data-device-id={dispatch.deviceId} title={[dispatch.incidentId, dispatch.taskId, dispatch.deviceId].filter(Boolean).join(' · ')}>{dispatch.summary}</p>}
      {!!candidates?.length && <ul className="recon-candidates" aria-label="候选侦查进度">{candidates.map(report => <li
        key={`${report.taskId}:${report.deviceId}:${report.candidatePoiId}`} data-recon-candidate={report.candidatePoiId}
        data-recon-stage={report.stage} data-device-id={report.deviceId} data-recon-event={report.eventId}
        data-task-id={report.taskId} data-incident-id={report.incidentId}>
        <div><strong>{report.rank !== undefined && `Top${report.rank} · `}{poiRegistry.get(report.candidatePoiId)?.name ?? report.candidatePoiId}</strong>
          <time dateTime={new Date(report.occurredAt).toISOString()}>{new Date(report.occurredAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time></div>
        <small title={report.result}>{report.deviceId} · {candidateStageLabels[report.stage]}{report.result && ` · ${report.result}`}</small>
      </li>)}</ul>}
      {dashboard ? <ul className="device-roster" aria-label="应急设备">{Object.values(dashboard.devices).map(device => <li key={device.id} data-device-card={device.id}
        data-drone-card={device.kind === 'drone' ? device.id : undefined} title={device.id} data-connection={device.connection}>
        {device.kind === 'drone' ? <ScanEye size={14} /> : <Truck size={14} />}
        <div><strong>{device.label}</strong><small>{connectionLabels[device.connection]} · {deviceQuality(device)}{device.accuracyMeters !== undefined && ` ±${device.accuracyMeters} m`}{device.altitudeMeters !== undefined && ` · 高度 ${device.altitudeMeters} m`}</small>
          {device.task && <small className="device-task" data-incident-id={device.task.incidentId} data-task-id={device.task.id}
            title={`${device.task.incidentId} · ${device.task.id}`}>{device.task.phase ?? device.task.id}{device.task.result && ` · ${device.task.result}`}</small>}</div>
        <span>{deviceStatusLabels[device.status]}</span>
      </li>)}</ul> : <div className="drone-fleet" aria-label="无人机机队">{state.drones.map(drone => <div key={drone.id} data-drone-card={drone.id}>
        <ScanEye size={17} /><span><strong>{drone.id}</strong><small>{droneStatusLabels[drone.status]}</small></span><em>{drone.altitude > 0 ? '空中' : '停靠'}</em>
      </div>)}</div>}
      {demoControls}
      {!incident && !dashboard && <p className="emergency-empty">当前无应急任务，城市交通正常运行。</p>}
      {incident && <>
        <dl className="emergency-details"><div><dt>侦察目标</dt><dd>{poiRegistry.get(incident.targetPoiId)?.name}<small>{incident.targetPoiId}</small></dd></div>
          <div><dt>火情等级</dt><dd>{assessment?.status === 'completed' ? severityLabels[assessment.severity] : assessment?.status === 'failed' ? '评估失败' : '等待侦察评估'}</dd></div>
          <div><dt>侦察结果</dt><dd>{assessment?.status === 'completed' ? assessment.result : '等待外部侦察结果'}</dd></div>
          {assessment?.source && <div><dt>评估来源</dt><dd>{assessment.source}</dd></div>}
        </dl>
        {incident.plan && <div className="emergency-plan" data-testid="emergency-plan"><h3><Truck size={16} />调度方案 · {incident.plan.dispatches.length} 辆消防车</h3><p>{incident.plan.summary}</p>
          <ul>{incident.plan.dispatches.map(dispatch => <li key={dispatch.vehicleId}><strong>{dispatch.vehicleId}</strong><span>目标 {dispatch.targetPoiId} · ({dispatch.targetPosition.x.toFixed(2)}, {dispatch.targetPosition.y.toFixed(2)})</span></li>)}</ul>
          <p className="emergency-policy">红绿灯照常轮换 · 出警消防车可越过红灯</p>
        </div>}
        {incident.cancelled && <div className="emergency-cancelled"><p>方案已取消，侦察结果已保留。</p><button className="secondary-button" onClick={() => service.reopen()}>重新审核方案</button></div>}
        {incident.error && <div className="emergency-error" role="alert"><AlertCircle size={16} /><p>{incident.error}</p>{incident.phase === 'failed' && <button className="secondary-button" disabled={state.pending || !state.connected} onClick={() => void service.retry()}>重新请求</button>}</div>}
      </>}
      {state.inputError && <div className="emergency-error" role="alert"><AlertCircle size={16} /><p>{state.inputError}</p></div>}
      </div>
      {incident?.phase === 'awaiting_confirmation' && (!automatic || !!incident.error) && <div className="emergency-actions"><button className="primary-button" disabled={state.pending || !state.connected} onClick={() => void service.confirm()}><Check size={16} />{state.pending ? '正在执行方案' : '确认并执行方案'}</button><button className="secondary-button" disabled={state.pending} onClick={() => service.cancel()}>取消执行</button></div>}
    </div>
  </section>;
}
