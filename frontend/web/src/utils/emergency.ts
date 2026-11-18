import config from '../config/emergency.json';
import type { CityPosition, DroneSnapshot, EmergencyAdapter, EmergencyCommand, EmergencyEvent, EmergencyIncident, EmergencyPhase, EmergencySnapshot, FireTruckDispatch, FireTruckRoute } from '../types';
import { poiRegistry } from './poiRegistry';
import { getTrafficControlService } from './trafficSignalController';
import type { TrafficSimulation } from './trafficSimulation';

export const droneStatusLabels = { idle: '待命', dispatched: '已派遣', flying: '飞行中', observing: '侦察中', returning: '返航中', charging: '停靠充电' };
export const phaseLabels: Record<EmergencyPhase, string> = {
  idle: '正常运行', fire_detected: '已发现火情', drone_dispatched: '无人机已派遣', observing: '无人机侦察中',
  assessment_completed: '火情评估完成', awaiting_confirmation: '方案待确认', traffic_lockdown: '交通管制已启动',
  fire_trucks_dispatched: '消防车已派遣', fire_trucks_en_route: '消防车前往火场', fire_trucks_arrived: '消防车已抵达',
  extinguishing: '灭火作业中', extinguished: '火情已扑灭', traffic_restored: '交通已恢复', returning: '应急力量返航中', completed: '应急处置完成', failed: '处置需要关注',
};
export const severityLabels = { 1: '小火', 2: '中火', 3: '大火' };
const isTank = (id: unknown): id is string => typeof id === 'string' && poiRegistry.get(id)?.type === 'Tank';
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const position = (v: unknown): v is CityPosition => object(v) && finite(v.x) && finite(v.y) && v.x >= 0 && v.x <= 90 && v.y >= 0 && v.y <= 75;
const route = (v: unknown): v is FireTruckRoute => object(v) && Array.isArray(v.pieceIds) && v.pieceIds.length > 0 && v.pieceIds.every(text) && finite(v.stop) && v.stop >= 0;
const drone = (v: unknown): v is DroneSnapshot => object(v) && config.drones.some(d => d.id === v.id) && position(v.position) &&
  finite(v.heading) && finite(v.altitude) && v.altitude >= 0 && finite(v.updatedAt) && v.updatedAt >= 0 &&
  typeof v.status === 'string' && Object.hasOwn(droneStatusLabels, v.status) && (v.targetPoiId === undefined || isTank(v.targetPoiId)) &&
  (v.path === undefined || Array.isArray(v.path) && v.path.length >= 2 && v.path.every(position));

// This is the single untrusted input boundary for all transports.
function validEvent(v: unknown): v is EmergencyEvent {
  if (!object(v) || !text(v.messageId) || !text(v.incidentId) || !finite(v.occurredAt) || v.occurredAt < 0) return false;
  switch (v.type) {
    case 'fire.detected': return isTank(v.targetPoiId);
    case 'drone.update': return drone(v.drone);
    case 'drone.return': return drone(v.drone) && ['returning', 'idle', 'charging'].includes(v.drone.status);
    case 'drone.observed': return config.drones.some(d => d.id === v.droneId);
    case 'fire.assessed': return object(v.assessment) && isTank(v.assessment.targetPoiId) &&
      (v.assessment.source === undefined || text(v.assessment.source)) &&
      (v.assessment.assessedAt === undefined || finite(v.assessment.assessedAt)) &&
      (v.assessment.status === 'completed' ? [1, 2, 3].includes(Number(v.assessment.severity)) && finite(v.assessment.severity) && text(v.assessment.result)
        : ['pending', 'failed'].includes(String(v.assessment.status)) && (v.assessment.message === undefined || text(v.assessment.message)));
    case 'plan.proposed': return object(v.plan) && text(v.plan.id) && isTank(v.plan.targetPoiId) && typeof v.plan.trafficLockdown === 'boolean' &&
      text(v.plan.summary) && Array.isArray(v.plan.dispatches) && v.plan.dispatches.length > 0 &&
      v.plan.dispatches.every(d => object(d) && text(d.vehicleId) && object(v.plan) && d.targetPoiId === v.plan.targetPoiId && position(d.targetPosition) &&
        d.status === 'dispatched' && (d.route === undefined || route(d.route)) &&
        (d.path === undefined || Array.isArray(d.path) && d.path.length >= 2 && d.path.every(position)));
    case 'truck.position': return text(v.vehicleId) && position(v.position) && finite(v.updatedAt) && v.updatedAt >= 0;
    case 'truck.route': return text(v.vehicleId) && route(v.route);
    case 'truck.arrived': case 'truck.extinguishing': return text(v.vehicleId);
    case 'fire.extinguished': return true;
    case 'truck.return': return text(v.vehicleId) && (v.route === undefined || route(v.route));
    case 'operation.failed': return ['drone', 'assessment', 'dispatch', 'extinguish'].includes(String(v.operation)) && text(v.message);
    default: return false;
  }
}

export class EmergencyService {
  private state: EmergencySnapshot = { incident: null, connected: false, pending: false,
    drones: config.drones.map(d => ({ ...d, position: { ...d.position }, status: 'idle', updatedAt: 0 })) };
  private listeners = new Set<() => void>();
  private messages = new Set<string>();
  private timestamps = new Map<string, number>();
  private completed = new Set<string>();
  private adapter?: EmergencyAdapter;
  private disconnect?: () => void;
  private requests = new Set<AbortController>();
  private motion = new Map<string, { path: readonly CityPosition[]; index: number }>();
  private returnRequested = false;
  private retryPhase: EmergencyPhase = 'fire_detected';
  private elapsed = 0;
  private assignments = new Map<string, { dispatchedAt: number; observedAt?: number }>();
  constructor(readonly traffic: TrafficSimulation) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getDrone(id: string) { return this.state.drones.find(d => d.id === id); }
  getSceneActors() { return this.state.drones.map(d => ({ ...d, kind: 'drone' as const })); }
  private publish(patch: Partial<EmergencySnapshot>, notify = true) {
    this.state = { ...this.state, ...patch };
    if (notify) this.listeners.forEach(listener => listener());
  }
  private incident(patch: Partial<EmergencyIncident>) { this.publish({ incident: { ...this.state.incident!, ...patch }, inputError: undefined }); }
  connect(adapter: EmergencyAdapter) {
    if (this.adapter) this.disconnectAdapter(this.adapter);
    this.adapter = adapter;
    this.publish({ connected: true, source: adapter.source });
    try { this.disconnect = adapter.subscribe(event => { this.receive(event); }); }
    catch (error) { this.adapter = undefined; this.publish({ connected: false, inputError: error instanceof Error ? error.message : '应急数据源连接失败' }); }
    return () => this.disconnectAdapter(adapter);
  }
  disconnectAdapter(adapter: EmergencyAdapter) {
    if (this.adapter !== adapter) return;
    try { this.disconnect?.(); }
    catch (error) { this.publish({ inputError: error instanceof Error ? error.message : '应急数据源断开失败' }); }
    this.disconnect = undefined; this.adapter = undefined;
    this.requests.forEach(controller => controller.abort());
    this.publish({ connected: false, source: undefined });
  }
  attach() {
    activeService = this;
    this.traffic.trucks.forEach(t => this.traffic.signals.setEmergencyAccess(t.id, false));
    const disconnect = configuredAdapter ? this.connect(configuredAdapter) : undefined;
    const unsubscribe = this.traffic.subscribe(seconds => this.tick(seconds), 'update');
    return () => {
      unsubscribe(); disconnect?.(); if (this.adapter) this.disconnectAdapter(this.adapter);
      this.requests.forEach(controller => controller.abort());
      if (activeService === this) activeService = undefined;
    };
  }
  receive(input: unknown): { accepted: boolean; error?: string } {
    if (!validEvent(input)) { this.publish({ inputError: '应急数据格式无效，请检查事件字段、城市坐标及储罐编号。' }); return { accepted: false, error: this.state.inputError }; }
    if (this.messages.has(input.messageId) || this.completed.has(input.incidentId)) return { accepted: true };
    try {
      // 不同车辆和无人机的消息可能独立延迟，时序只在同一对象内比较。
      const subject = 'vehicleId' in input ? input.vehicleId : input.type === 'drone.observed' ? input.droneId : '';
      const key = `${input.incidentId}:${input.type}:${subject}`;
      if (input.occurredAt < (this.timestamps.get(key) ?? -1) && !['drone.update', 'drone.return', 'truck.position'].includes(input.type)) return { accepted: true };
      this.apply(structuredClone(input));
      this.timestamps.set(key, input.occurredAt);
      this.messages.add(input.messageId);
      if (this.state.inputError) this.publish({ inputError: undefined });
      return { accepted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '应急事件未接收';
      this.publish({ inputError: message });
      return { accepted: false, error: message };
    }
  }
  private apply(event: EmergencyEvent) {
    const current = this.state.incident;
    if (event.type === 'fire.detected') {
      if (current?.id === event.incidentId) {
        if (current.targetPoiId !== event.targetPoiId) throw new Error('同一应急事件不能更换目标储罐');
        return;
      }
      if (current && current.phase !== 'completed') throw new Error('请先完成当前应急处置，再接入下一起火情');
      this.returnRequested = false;
      this.assignments.clear();
      this.publish({ incident: { id: event.incidentId, targetPoiId: event.targetPoiId, phase: 'fire_detected', fireStatus: 'burning',
        confirmed: false, cancelled: false, droneIds: [], observedIds: [], arrivedIds: [], returningIds: [] }, inputError: undefined });
      return;
    }
    if (!current || current.id !== event.incidentId) throw new Error('请先接入对应 ID 的火情发现事件');
    if (event.type === 'drone.update' || event.type === 'drone.return') {
      if (event.drone.targetPoiId && event.drone.targetPoiId !== current.targetPoiId) throw new Error('无人机任务目标与本次火情不一致');
      if (current.fireStatus === 'extinguished' && !['returning', 'idle', 'charging'].includes(event.drone.status)) return;
      const previous = this.getDrone(event.drone.id)!;
      if (event.drone.updatedAt <= previous.updatedAt) return;
      if (event.drone.path && Math.hypot(event.drone.path[0].x - event.drone.position.x, event.drone.path[0].y - event.drone.position.y) > .05)
        throw new Error('无人机路径必须从本次上报位置开始');
      const assigned = ['dispatched', 'flying'].includes(event.drone.status);
      if (event.drone.status === 'observing' && !current.droneIds.includes(event.drone.id)) throw new Error('请先派遣无人机，再上报侦察状态');
      const reassigned = assigned && (!current.droneIds.includes(event.drone.id) ||
        current.observedIds.includes(event.drone.id) && ['dispatched', 'flying'].includes(event.drone.status));
      if (reassigned && (current.confirmed || this.state.pending)) throw new Error('方案执行期间不能重新派遣侦察任务');
      if (reassigned) this.assignments.set(event.drone.id, { dispatchedAt: event.occurredAt });
      const path = ['idle', 'charging'].includes(event.drone.status) ? undefined : event.drone.path;
      if (path) this.motion.set(event.drone.id, { path, index: 1 });
      if (!path) this.motion.delete(event.drone.id);
      this.publish({ drones: this.state.drones.map(d => d.id === event.drone.id ? { ...event.drone, position: { ...event.drone.position }, path: path?.map(p => ({ ...p })) } : d) });
      const ids = assigned ? [...new Set([...current.droneIds, event.drone.id])] : current.droneIds;
      this.incident({ droneIds: ids, ...(reassigned ? { observedIds: current.observedIds.filter(id => id !== event.drone.id),
        assessment: undefined, plan: undefined, fireStatus: 'burning' as const } : {}), ...((assigned || current.droneIds.includes(event.drone.id)) && !current.confirmed && (!current.assessment || reassigned) ?
        { phase: event.drone.status === 'observing' ? 'observing' : 'drone_dispatched' } : {}) });
      this.checkCompleted(); return;
    }
    if (event.type === 'drone.observed') {
      if (current.fireStatus === 'extinguished') return;
      const d = this.getDrone(event.droneId)!;
      if (!current.droneIds.includes(d.id)) throw new Error('无人机尚未接收本次任务');
      const assignment = this.assignments.get(d.id)!;
      if (event.occurredAt < assignment.dispatchedAt) throw new Error('侦察完成事件早于本次无人机派遣');
      if (current.observedIds.includes(d.id)) return;
      if (!['dispatched', 'flying', 'observing'].includes(d.status)) throw new Error('无人机当前未执行侦察任务');
      assignment.observedAt = event.occurredAt;
      this.motion.delete(d.id);
      this.publish({ drones: this.state.drones.map(drone => drone.id === d.id ? { ...drone, path: undefined, status: 'observing' } : drone) });
      this.incident({ observedIds: [...current.observedIds, d.id], ...(!current.assessment && !current.confirmed ? { phase: 'observing' } : {}) });
      return;
    }
    if (event.type === 'fire.assessed') {
      if (event.assessment.targetPoiId !== current.targetPoiId) throw new Error('火情判断目标与本次事件不一致');
      if (current.confirmed || current.fireStatus === 'extinguished') return;
      if (this.state.pending) throw new Error('方案执行请求处理中，请等待确认结果后再更新评估');
      if (event.assessment.status === 'completed') this.requireObservation(event.occurredAt);
      if (current.assessment?.status === 'completed' && event.assessment.status === 'completed' &&
        current.assessment.severity === event.assessment.severity && current.assessment.result === event.assessment.result) return;
      if (event.assessment.status === 'failed') {
        this.incident({ assessment: event.assessment, plan: undefined, fireStatus: 'normal', cancelled: false });
        this.fail(event.assessment.message ?? '火情判断失败，请重新获取侦察结果', 'assessment'); return;
      }
      this.incident({ assessment: { ...event.assessment }, plan: undefined, cancelled: false, error: undefined,
        phase: event.assessment.status === 'completed' ? 'assessment_completed' : 'observing',
        fireStatus: event.assessment.status === 'completed' ? 'burning' : 'normal' });
      return;
    }
    if (event.type === 'plan.proposed') {
      this.requireObservation(event.occurredAt);
      if (this.state.pending) throw new Error('方案执行请求处理中，请等待确认结果后再更新方案');
      if (current.confirmed) throw new Error('当前方案已执行，不能覆盖调度任务');
      if (current.assessment?.status !== 'completed') throw new Error('请先提供已完成的火情判断结果');
      if (event.plan.targetPoiId !== current.targetPoiId) throw new Error('调度方案目标与火情目标不一致');
      const ids = event.plan.dispatches.map(d => d.vehicleId);
      if (new Set(ids).size !== ids.length || ids.some(id => !this.traffic.trucks.some(t => t.id === id))) throw new Error('方案包含重复或不存在的消防车');
      if (current.plan?.id === event.plan.id) return;
      this.incident({ plan: structuredClone(event.plan), phase: 'awaiting_confirmation', error: undefined, cancelled: false }); return;
    }
    if (event.type === 'operation.failed') { this.fail(event.message, event.operation); return; }
    if (!current.confirmed) throw new Error('方案尚未确认，消防车任务和灭火事件不会执行');
    if (event.type === 'fire.extinguished') {
      if (current.fireStatus === 'extinguished') return;
      if (current.fireStatus !== 'extinguishing') throw new Error('请先提供灭火开始事件');
      this.incident({ fireStatus: 'extinguished', phase: 'extinguished', error: undefined });
      current.plan!.dispatches.forEach(d => this.traffic.setExternalWater(d.vehicleId, false));
      current.plan!.dispatches.forEach(d => this.traffic.signals.setEmergencyAccess(d.vehicleId, false));
      this.traffic.signals.setMode('normal');
      this.incident({ phase: 'traffic_restored' });
      void this.requestReturn(); return;
    }
    const dispatch = current.plan!.dispatches.find(d => d.vehicleId === event.vehicleId);
    if (!dispatch) throw new Error('该消防车未包含在已确认方案中');
    if (event.type === 'truck.route') {
      if (current.fireStatus === 'extinguishing') throw new Error('请先结束当前灭火作业，再更新消防车路径');
      if (current.fireStatus === 'extinguished') {
        this.traffic.returnExternalTruck(event.vehicleId, event.route);
        this.incident({ returningIds: [...new Set([...current.returningIds, event.vehicleId])], phase: 'returning' }); return;
      }
      this.traffic.applyExternalDispatch(dispatch, event.route);
      this.incident({ phase: 'fire_trucks_en_route' }); return;
    }
    if (event.type === 'truck.position') {
      this.traffic.updateExternalPosition(event.vehicleId, event.position, event.updatedAt);
      if (current.fireStatus !== 'extinguished' && current.phase === 'fire_trucks_dispatched') this.incident({ phase: 'fire_trucks_en_route' });
      return;
    }
    if (event.type === 'truck.return') {
      if (current.fireStatus !== 'extinguished') throw new Error('请先提供灭火完成事件');
      if (current.returningIds.includes(event.vehicleId)) return;
      this.traffic.returnExternalTruck(event.vehicleId, event.route);
      this.incident({ returningIds: [...current.returningIds, event.vehicleId], phase: 'returning' });
      this.checkCompleted(); return;
    }
    if (current.fireStatus === 'extinguished') return;
    const truck = this.traffic.trucks.find(t => t.id === event.vehicleId)!;
    if (truck.status !== 'arrived') throw new Error('消防车尚未沿批准路径抵达，不能提前开始作业');
    if (event.type === 'truck.arrived') {
      this.incident({ arrivedIds: [...new Set([...current.arrivedIds, event.vehicleId])],
        phase: current.fireStatus === 'extinguishing' ? 'extinguishing' : 'fire_trucks_arrived' }); return;
    }
    this.traffic.setExternalWater(event.vehicleId, true);
    this.incident({ phase: 'extinguishing', fireStatus: 'extinguishing', error: undefined });
  }
  cancel() {
    if (this.state.pending || this.state.incident?.phase !== 'awaiting_confirmation') return;
    this.incident({ phase: 'assessment_completed', cancelled: true, error: undefined });
  }
  reopen() { if (this.state.incident?.cancelled) this.incident({ cancelled: false, phase: 'awaiting_confirmation' }); }
  async confirm() {
    const incident = this.state.incident;
    if (!incident || incident.confirmed || this.state.pending || incident.phase !== 'awaiting_confirmation') return;
    if (!this.adapter) { this.incident({ error: '应急数据源未连接，请连接调度服务后重试。' }); return; }
    if (getTrafficControlService() !== this.traffic.signals) { this.incident({ error: '交通控制服务尚未初始化，请稍后重试。' }); return; }
    this.publish({ pending: true });
    try {
      this.requireObservation();
      const plan = incident.plan!;
      const routes = await this.request(signal => Promise.all(plan.dispatches.map(async dispatch => {
        const truck = this.traffic.trucks.find(t => t.id === dispatch.vehicleId)!;
        const planned = dispatch.route ?? await this.adapter!.resolveRoute?.(dispatch, { x: truck.pose.point[0], y: truck.pose.point[1] }, signal);
        if (!route(planned)) throw new Error('尚未提供消防车正式路径，请接入调度路径或 resolveRoute 接口。');
        this.traffic.validateExternalRoute(dispatch.vehicleId, planned, dispatch.targetPosition);
        return planned;
      })));
      this.requireObservation();
      await this.request(signal => this.adapter!.execute({ type: 'plan.confirm', commandId: `${incident.id}:${plan.id}:confirm`, incidentId: incident.id, plan }, signal));
      // Revalidate after async acknowledgement before mutating any truck.
      plan.dispatches.forEach((d, i) => this.traffic.validateExternalRoute(d.vehicleId, routes[i], d.targetPosition));
      if (plan.trafficLockdown) { this.traffic.signals.setMode('emergency_priority'); this.incident({ phase: 'traffic_lockdown' }); }
      plan.dispatches.forEach((d, i) => { this.traffic.signals.setEmergencyAccess(d.vehicleId, true); this.traffic.applyExternalDispatch(d, routes[i]); });
      this.incident({ confirmed: true, phase: 'fire_trucks_dispatched', error: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : '消防车派遣未完成，请重试';
      this.incident({ phase: 'awaiting_confirmation', error: message });
    } finally { this.publish({ pending: false }); }
  }
  private requireObservation(occurredAt = Infinity) {
    const incident = this.state.incident!;
    if (!incident.droneIds.length) throw new Error('请先派遣无人机并完成本次侦察');
    if (incident.droneIds.some(id => !incident.observedIds.includes(id))) throw new Error('请等待本次派遣的所有无人机完成侦察');
    if (incident.droneIds.some(id => occurredAt < this.assignments.get(id)!.observedAt!)) throw new Error('评估或方案事件早于本次侦察完成');
  }
  private fail(message: string, operation: string) {
    if (this.state.incident!.phase !== 'failed') this.retryPhase = this.state.incident!.phase;
    this.incident({ phase: 'failed', error: message, failedOperation: operation });
  }
  async retry() {
    const incident = this.state.incident;
    if (!incident || this.state.pending || !this.adapter) return;
    if (incident.failedOperation === 'confirm') { this.incident({ phase: 'awaiting_confirmation' }); await this.confirm(); return; }
    if (incident.fireStatus === 'extinguished') { await this.requestReturn(); return; }
    this.publish({ pending: true });
    try {
      await this.request(signal => this.adapter!.execute({ type: 'operation.retry', incidentId: incident.id,
        commandId: `${incident.id}:retry:${incident.failedOperation ?? 'operation'}`, operation: incident.failedOperation ?? 'operation' }, signal));
      this.incident({ phase: this.retryPhase, error: undefined });
    } catch (error) { this.incident({ error: error instanceof Error ? error.message : '重试失败' }); }
    finally { this.publish({ pending: false }); }
  }
  private async requestReturn() {
    if (this.returnRequested) return;
    const incident = this.state.incident!;
    if (!this.adapter) { this.fail('应急数据源未连接，请重新连接后发送返航请求。', 'return'); return; }
    this.returnRequested = true; this.publish({ pending: true });
    try {
      await this.request(signal => this.adapter!.execute({ type: 'responders.return', incidentId: incident.id, commandId: `${incident.id}:return`,
        vehicleIds: incident.plan!.dispatches.map(d => d.vehicleId), droneIds: incident.droneIds }, signal));
      this.incident({ phase: 'returning', error: undefined });
    } catch (error) { this.returnRequested = false; this.fail(error instanceof Error ? error.message : '返航请求失败', 'return'); }
    finally { this.publish({ pending: false }); }
  }
  private async request<T>(operation: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController(); this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('外部应急接口响应超时，请检查服务并重试。')), config.requestTimeoutMs);
    try {
      return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      })]);
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  private tick(seconds: number) {
    if (this.motion.size) {
      this.publish({ drones: this.state.drones.map(d => {
        const motion = this.motion.get(d.id);
        if (!motion) return d;
        let remaining = seconds * config.displaySpeedUnitsPerSecond;
        let p = d.position, heading = d.heading;
        while (remaining > 0 && motion.index < motion.path.length) {
          const target = motion.path[motion.index], length = Math.hypot(target.x - p.x, target.y - p.y);
          if (length < 1e-8) { motion.index++; continue; }
          heading = Math.atan2(target.y - p.y, target.x - p.x);
          const step = Math.min(remaining, length);
          p = { x: p.x + (target.x - p.x) * step / length, y: p.y + (target.y - p.y) * step / length };
          remaining -= step;
          if (step === length) motion.index++;
        }
        const finished = motion.index === motion.path.length;
        if (finished) this.motion.delete(d.id);
        return { ...d, position: p, heading, path: finished ? undefined : d.path };
      }) }, false);
      this.elapsed += seconds;
      if (this.elapsed >= .2 || !this.motion.size) { this.elapsed = 0; this.publish({}); }
    }
    this.checkCompleted();
  }
  private checkCompleted() {
    const incident = this.state.incident;
    if (!incident || incident.fireStatus !== 'extinguished' || incident.phase === 'completed') return;
    const trucks = incident.plan!.dispatches.map(d => this.traffic.trucks.find(t => t.id === d.vehicleId)!);
    if (trucks.some(t => t.status !== 'idle') || incident.returningIds.length !== trucks.length ||
      incident.droneIds.some(id => !['idle', 'charging'].includes(this.getDrone(id)!.status))) return;
    trucks.forEach(t => this.traffic.signals.setEmergencyAccess(t.id, false));
    this.completed.add(incident.id);
    this.incident({ phase: 'completed', error: undefined });
  }
}

let activeService: EmergencyService | undefined;
let configuredAdapter: EmergencyAdapter | undefined;
export const getEmergencyService = () => activeService;
export function connectEmergencyAdapter(adapter: EmergencyAdapter) {
  configuredAdapter = adapter;
  const disconnect = activeService?.connect(adapter);
  return () => { disconnect?.(); activeService?.disconnectAdapter(adapter); if (configuredAdapter === adapter) configuredAdapter = undefined; };
}
