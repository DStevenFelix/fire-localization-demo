import config from '../config/emergency.json';
import type { CityPosition, FireSceneStatus, SceneActorSnapshot } from '../types';
import { poiRegistry } from '../utils/poiRegistry';
import { truckIds } from '../utils/trafficSimulation';
import { deviceToCity, validateCalibration, type DeviceCalibration } from '../utils/deviceCoordinates';
import { toCity } from '../utils/mapCoordinates';
import { normalizeHardwareSignals, type HardwareSignals } from '../utils/liveTrafficSignals';

export type SourceMode = 'simulation' | 'physical';
export type Agent = 'opinion' | 'location' | 'dispatch';
export type Connection = 'waiting' | 'connecting' | 'online' | 'disconnected' | 'error';
type MediaStatus = 'idle' | 'connecting' | 'ready' | 'disconnected' | 'error' | 'reconnecting';
const truckStatuses = ['idle', 'dispatched', 'en-route', 'arrived', 'extinguishing', 'returning', 'return-waiting', 'unreachable'];
const droneStatuses = ['idle', 'dispatched', 'flying', 'observing', 'returning', 'charging'];

export const responders = [
  ...config.trucks.map((truck, index) => ({ id: truck.id, label: `消防车 ${index + 1}`,
    kind: 'fireTruck' as const, position: truck.standby, heading: 0 })),
  ...config.drones.map((drone, index) => ({ ...drone, label: `无人机 ${index + 1}`, kind: 'drone' as const })),
];

export const mediaSlots = [
  { id: 'air-video-1', label: '视频 1', kind: 'video' },
  { id: 'air-video-2', label: '视频 2', kind: 'video' },
  { id: 'air-video-3', label: '视频 3', kind: 'video' },
  { id: 'air-image-1', label: '图片 1', kind: 'image' },
  ...truckIds.map((deviceId, index) => ({ id: `ground-video-${index + 1}`, label: `视频 ${index + 1}`, kind: 'video' as const, deviceId })),
] as const;

type Slot = typeof mediaSlots[number];
type Media = {
  feedId: string; status: MediaStatus; deviceId?: string; url?: string; stream?: MediaStream;
};
export type Device = SceneActorSnapshot & {
  label: string; connection: Connection; locatedAt?: number; stale?: boolean; altitudeMeters?: number; accuracyMeters?: number;
  route?: readonly CityPosition[]; track: readonly CityPosition[];
  routePurpose?: RoutePurpose; routeClosed?: boolean; waterIncidentId?: string;
  task?: { id: string; incidentId: string; phase?: string; result?: string; sessionId?: string };
};
export type LogEntry = {
  id: string; time: number; source: string; type: string; object?: string; status: string; summary: string;
  sessionId?: string; incidentId?: string; taskId?: string; deviceId?: string;
};
type RoutePurpose = 'outbound' | 'reconnaissance' | 'return';
type CandidateReport = { candidatePoiId: string; rank?: number; deviceId: string; taskId: string; incidentId: string;
  stage: 'assigned' | 'arrived' | 'observed'; result?: string; eventId: string; occurredAt: number; sessionId?: string };
type AgentState = { phase: string; summary: string; sessionId?: string; incidentId?: string; taskId?: string; deviceId?: string; targetPoiId?: string;
  fireStatus?: FireSceneStatus; firePosition?: CityPosition; suppression?: 'failed' | 'interrupted' };
export type DashboardSnapshot = {
  devices: Readonly<Record<string, Device>>;
  media: Readonly<Record<string, Media>>;
  agents: Readonly<Partial<Record<Agent, AgentState>>>;
  connections: Readonly<Record<string, Connection>>;
  signals: HardwareSignals;
  log: readonly LogEntry[];
  reconnaissance: readonly CandidateReport[];
  rejected?: string;
};
type MessageOptions = {
  sourceMode: SourceMode; eventId: string; occurredAt: number | string;
  sessionId?: string; incidentId?: string;
};
type DashboardEvent =
  | { eventType: 'source.connection'; payload: { sourceId: string; state: Connection } }
  | { eventType: 'device.connection'; payload: { deviceId: string; state: Connection } }
  | { eventType: 'device.telemetry'; payload: { deviceId: string; kind: Device['kind']; position: CityPosition;
      coordinateSystem: string; calibrationVersion?: string; headingRadians: number; status?: string;
      altitudeMeters?: number; accuracyMeters?: number; renderAltitude?: number; waterTarget?: CityPosition; taskId?: string } }
  | { eventType: 'device.task'; payload: { deviceId: string; taskId: string; phase: string; result?: string; status?: string;
      routeComplete?: boolean; waterTarget?: CityPosition } }
  | { eventType: 'device.route'; payload: { deviceId: string; taskId: string; route: readonly CityPosition[];
      coordinateSystem: string; calibrationVersion?: string; purpose?: RoutePurpose } }
  | { eventType: 'recon.candidate'; payload: Pick<CandidateReport, 'deviceId' | 'taskId' | 'rank' | 'candidatePoiId' | 'stage' | 'result'> }
  | { eventType: 'recon.confirmed'; payload: { confirmedFirePoiId?: string; position?: CityPosition; coordinateSystem?: string;
      calibrationVersion?: string; result: string; deviceId?: string; taskId?: string } }
  | { eventType: 'agent.event'; payload: { agent: Agent; type: string; phase: string; summary: string; object?: string; taskId?: string; deviceId?: string;
      targetPoiId?: string; fireStatus?: FireSceneStatus; suppression?: 'failed' | 'interrupted' } }
  | { eventType: 'media.feed'; payload: Media & { slotId: Slot['id']; kind: Slot['kind'] } }
  | { eventType: 'traffic.snapshot'; payload: { devices: unknown } };
export type DashboardMessage = MessageOptions & DashboardEvent;
export type InputOptions = {
  idMap?: Readonly<Record<string, string>>;
  calibrations?: readonly DeviceCalibration[];
};
export type InputResult = { accepted: true; duplicate?: true } | { accepted: false; error: string };
const maxAge = 30_000;
export const trackingTimeoutMs = 10_000;
export const agentNames = { opinion: '舆情监测', location: '火情定位', dispatch: '调度' } as const;
export const connectionLabels: Record<Connection, string> = { waiting: '待连接', connecting: '连接中', online: '在线', disconnected: '已断联', error: '连接异常' };
export const deviceStatusLabels: Readonly<Record<string, string>> = {
  idle: '待命', dispatched: '已派遣', 'en-route': '前往火场', arrived: '已抵达', extinguishing: '灭火中',
  returning: '返回中', 'return-waiting': '等待返回', unreachable: '路径不可达', flying: '飞行中', observing: '侦察中', charging: '停靠充电',
};
const candidateStages = ['assigned', 'arrived', 'observed'] as const;
export const candidateStageLabels = { assigned: '已分配', arrived: '已到达 · 侦查中', observed: '已回传' };

export function visibleDeviceRoute(device: Device) {
  return !device.stale && !device.routeClosed && device.routePurpose !== 'return' &&
    device.status !== 'returning' && device.status !== 'return-waiting' &&
    device.connection !== 'disconnected' && device.connection !== 'error' ? device.route : undefined;
}

function closesRoute(status: string, purpose?: RoutePurpose) {
  return ['arrived', 'extinguishing', 'returning', 'return-waiting', 'unreachable', 'charging', 'idle'].includes(status) ||
    (status === 'observing' && purpose !== 'reconnaissance');
}

function tankPoint(id: string) {
  const poi = poiRegistry.get(id)!;
  const city = toCity({ x_m: poi.center[0], y_m: poi.center[1] }, poi.coordinate_system);
  return { x: city.x_m, y: city.y_m };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new RangeError(`缺少或无效字段 ${field}`);
  return value;
}
function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`数值无效 ${field}`);
  return value;
}
function coordinates(value: unknown): CityPosition {
  if (!record(value)) throw new RangeError('坐标格式无效');
  return { x: finite(value.x, 'x'), y: finite(value.y, 'y') };
}
function timestamp(value: unknown) {
  const time = typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : finite(value, 'occurredAt');
  if (!Number.isFinite(time) || time <= 0 || time > Date.now() + 5_000) throw new RangeError('事件时间戳无效');
  return time;
}
function mediaUrl(value: unknown) {
  try {
    const url = new URL(requiredText(value, 'url'), window.location.href);
    if (['https:', 'http:', 'blob:'].includes(url.protocol)) return url.href;
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
  }
  throw new RangeError('媒体源需要 HTTP、HTTPS 或 Blob URL');
}

export class DashboardInput {
  private snapshot: DashboardSnapshot = {
    devices: Object.fromEntries(responders.map(device => [device.id, { ...device, status: 'idle', connection: 'waiting', track: [] }])),
    media: {}, agents: {}, connections: {}, signals: {}, log: [], reconnaissance: [],
  };
  private listeners = new Set<() => void>();
  private events = new Map<string, { time: number; sessionId?: string }>();
  private latest = new Map<string, number>();
  private retiredTasks = new Set<string>();
  private options;
  private sessionId?: string;
  private batching = false;
  private changed = false;

  constructor(readonly mode: SourceMode, options?: InputOptions) {
    this.options = this.prepareOptions(options);
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  batch(update: () => void) {
    if (this.batching) { update(); return; }
    this.batching = true;
    try { update(); }
    finally {
      this.batching = false;
      if (this.changed) {
        this.changed = false;
        this.listeners.forEach(listener => listener());
      }
    }
  }
  prepareOptions(options?: InputOptions) {
    const idMap = { ...options?.idMap };
    const mappedIds = Object.values(idMap);
    if (mappedIds.some(id => !Object.hasOwn(this.snapshot.devices, id)) || new Set(mappedIds).size !== mappedIds.length ||
      Object.keys(idMap).some(id => Object.hasOwn(this.snapshot.devices, id) && idMap[id] !== id))
      throw new RangeError('设备 ID 映射必须指向不同的既有设备');
    const calibrations = new Map<string, DeviceCalibration>();
    for (const calibration of options?.calibrations ?? []) {
      validateCalibration(calibration);
      if (calibrations.has(calibration.sourceCoordinateSystem)) throw new RangeError('设备坐标系标定重复');
      calibrations.set(calibration.sourceCoordinateSystem, structuredClone(calibration));
    }
    return { idMap, calibrations };
  }
  configure(options: InputOptions) {
    this.options = this.prepareOptions(options);
  }
  setSession(id: string | undefined) {
    if (id === this.sessionId) return;
    this.sessionId = id;
    const physical = this.mode === 'physical';
    for (const [key, event] of this.events) if (!physical || event.sessionId !== undefined) this.events.delete(key);
    for (const agent of Object.keys(agentNames) as Agent[]) {
      if (!physical || agent !== 'dispatch' || this.snapshot.agents[agent]?.sessionId !== undefined) this.latest.delete(`agent:${agent}`);
    }
    const dispatch = this.snapshot.agents.dispatch;
    const keepDispatch = physical && dispatch && !dispatch.sessionId;
    this.publish({ reconnaissance: physical ? this.snapshot.reconnaissance.filter(report => !report.sessionId) : [],
      log: physical ? this.snapshot.log.filter(entry => !entry.sessionId) : [], agents: keepDispatch ? { dispatch } : {}, devices: Object.fromEntries(Object.values(this.snapshot.devices).map(device => {
      if (physical && !device.task?.sessionId) return [device.id, device];
      for (const channel of ['mission', 'task', 'route']) this.latest.delete(`${channel}:${device.id}`);
      return [device.id, { ...device, task: undefined, route: undefined, routeClosed: undefined, track: physical ? device.track : device.locatedAt ? [device.position] : [] }];
    })) });
  }
  reportError(error: string) {
    this.publish({ rejected: error });
    return { accepted: false, error } as const;
  }
  private publish(patch: Partial<DashboardSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.batching) this.changed = true;
    else this.listeners.forEach(listener => listener());
  }
  private device(id: unknown, idMap: Readonly<Record<string, string>>) {
    const external = requiredText(id, 'deviceId');
    const internal = Object.hasOwn(idMap, external) ? idMap[external] : external;
    if (!Object.hasOwn(this.snapshot.devices, internal)) throw new RangeError(`未知设备 ${external}`);
    return this.snapshot.devices[internal];
  }
  private city(point: unknown, payload: Record<string, unknown>, calibrations: ReadonlyMap<string, DeviceCalibration>) {
    return deviceToCity(coordinates(point), requiredText(payload.coordinateSystem, 'coordinateSystem'),
      calibrations, payload.calibrationVersion === undefined ? undefined : requiredText(payload.calibrationVersion, 'calibrationVersion'));
  }
  private ordered(key: string, time: number) {
    if (time < (this.latest.get(key) ?? -Infinity)) throw new RangeError('收到逆序设备或来源消息');
    return key;
  }
  consume(input: unknown, context?: { external?: boolean; mapping?: ReturnType<DashboardInput['prepareOptions']>; report?: boolean }): InputResult {
    const options = context?.mapping ?? this.options;
    const report = context?.report !== false;
    try {
      if (!record(input) || input.sourceMode !== this.mode || !record(input.payload)) throw new RangeError('消息来源模式或数据格式无效');
      const sessionId = input.sessionId === undefined ? undefined : requiredText(input.sessionId, 'sessionId');
      if (sessionId !== undefined && sessionId !== this.sessionId) throw new RangeError('消息不属于当前会话');
      const id = requiredText(input.eventId, 'eventId');
      if (this.events.has(id)) return { accepted: true, duplicate: true };
      const time = timestamp(input.occurredAt);
      const type = requiredText(input.eventType, 'eventType');
      const incidentId = input.incidentId === undefined ? undefined : requiredText(input.incidentId, 'incidentId');
      const payload = input.payload;
      const taskId = payload.taskId === undefined ? undefined : requiredText(payload.taskId, 'taskId');
      if (taskId && !incidentId) throw new RangeError('任务关联缺少 incidentId');
      if (type !== 'agent.event' && Date.now() - time > maxAge) throw new RangeError('消息已过期');
      let patch: Partial<DashboardSnapshot>;
      let log: Omit<LogEntry, 'id' | 'time' | 'type'> | undefined;
      let orderKey: string | undefined;
      switch (type) {
        case 'source.connection':
        case 'device.connection': {
          const state = requiredText(payload.state, 'state') as Connection;
          if (!Object.hasOwn(connectionLabels, state)) throw new RangeError('连接状态无效');
          const device = type === 'device.connection' ? this.device(payload.deviceId, options.idMap) : undefined;
          const source = device?.id ?? requiredText(payload.sourceId, 'sourceId');
          orderKey = this.ordered(`${type}:${source}`, time);
          if (device && time < (device.locatedAt ?? -Infinity)) throw new RangeError('收到早于最新遥测的连接状态');
          patch = device ? { devices: { ...this.snapshot.devices, [source]: { ...device, connection: state,
            routeClosed: device.routeClosed || state === 'disconnected' || state === 'error',
            waterTarget: state === 'online' ? device.waterTarget : undefined } } } :
            { connections: { ...this.snapshot.connections, [source]: state } };
          log = { source, deviceId: device?.id, status: connectionLabels[state], summary: device?.label ?? source };
          break;
        }
        case 'device.telemetry': {
          const device = this.device(payload.deviceId, options.idMap);
          orderKey = this.ordered(`telemetry:${device.id}`, time);
          if (payload.kind !== device.kind) throw new RangeError('设备类型与设备编号不符');
          const reportedStatus = payload.status === undefined ? undefined : this.deviceStatus(device, payload.status);
          const statusKey = `status:${device.id}`;
          const matchingTask = !device.task || !taskId || (device.task.id === taskId && device.task.incidentId === incidentId && device.task.sessionId === sessionId);
          const updateStatus = reportedStatus !== undefined && matchingTask && time >= (this.latest.get(statusKey) ?? -Infinity);
          const status = updateStatus ? reportedStatus : device.status;
          const position = this.city(payload.position, payload, options.calibrations);
          const heading = finite(payload.headingRadians, 'headingRadians');
          const altitudeMeters = payload.altitudeMeters === undefined ? undefined : finite(payload.altitudeMeters, 'altitudeMeters');
          const accuracyMeters = payload.accuracyMeters === undefined ? undefined : finite(payload.accuracyMeters, 'accuracyMeters');
          const altitude = payload.renderAltitude === undefined ? undefined : finite(payload.renderAltitude, 'renderAltitude');
          if ((altitudeMeters !== undefined && device.kind !== 'drone') ||
            (altitude !== undefined && (this.mode !== 'simulation' || device.kind !== 'drone')) ||
            [altitudeMeters, accuracyMeters, altitude].some(value => value !== undefined && value < 0))
            throw new RangeError('高度或定位精度无效');
          const waterTarget = payload.waterTarget === undefined ? device.waterTarget :
            deviceToCity(coordinates(payload.waterTarget), 'CITY90x75', options.calibrations);
          const latest = device.track.at(-1);
          const track = latest?.x === position.x && latest.y === position.y ? device.track : [...device.track, position].slice(-500);
          // A delayed fix can update position without undoing a later explicit disconnect.
          const connection = time <= (this.latest.get(`device.connection:${device.id}`) ?? -Infinity) ? device.connection : 'online';
          const stale = Date.now() - time >= trackingTimeoutMs;
          const dispatch = this.snapshot.agents.dispatch;
          const waterIncidentId = incidentId ?? device.waterIncidentId ?? device.task?.incidentId;
          const stopped = !!waterIncidentId && dispatch?.incidentId === waterIncidentId &&
            (dispatch.fireStatus === 'extinguished' || dispatch.suppression !== undefined);
          patch = { devices: { ...this.snapshot.devices, [device.id]: { ...device, position, heading, status, altitude, altitudeMeters,
            accuracyMeters, waterIncidentId,
            waterTarget: matchingTask && !stopped && !stale && connection === 'online' && status === 'extinguishing' ? waterTarget : undefined,
            routeClosed: device.routeClosed || (!!device.task && (stale || (updateStatus && closesRoute(status, device.routePurpose)))),
            track, locatedAt: time, stale, connection } } };
          if (updateStatus) this.latest.set(statusKey, time);
          if (status !== device.status || !device.locatedAt) log = { source: device.id, deviceId: device.id,
            status: updateStatus ? deviceStatusLabels[status] : '已定位', summary: device.locatedAt ? '设备状态更新' : '收到首个有效定位', object: taskId };
          break;
        }
        case 'device.task':
        case 'device.route': {
          const device = this.device(payload.deviceId, options.idMap);
          if (!incidentId || !taskId) throw new RangeError('任务或路径缺少 incidentId 或 taskId');
          const current = device.task;
          const previous = current?.id === taskId && current.incidentId === incidentId && current.sessionId === sessionId ? current : undefined;
          const identity = JSON.stringify([device.id, sessionId, incidentId, taskId]);
          const missionKey = `mission:${device.id}`;
          const taskKey = `task:${device.id}`;
          const routeKey = `route:${device.id}`;
          const statusKey = `status:${device.id}`;
          const missionTime = this.latest.get(missionKey) ?? -Infinity;
          if (!previous && (this.retiredTasks.has(identity) || (current && time < missionTime))) throw new RangeError('收到旧任务的设备消息');
          const taskUpdate = type === 'device.task';
          const channel = taskUpdate ? taskKey : routeKey;
          orderKey = previous ? this.ordered(channel, time) : channel;
          const phase = taskUpdate ? requiredText(payload.phase, 'phase') : previous?.phase;
          const result = taskUpdate && payload.result !== undefined ? requiredText(payload.result, 'result') : phase === previous?.phase ? previous?.result : undefined;
          const reportedStatus = taskUpdate && payload.status !== undefined ? this.deviceStatus(device, payload.status) : undefined;
          const updateStatus = reportedStatus !== undefined && time >= (this.latest.get(statusKey) ?? -Infinity);
          const status = updateStatus ? reportedStatus : device.status;
          let route = previous ? device.route : undefined;
          let purpose = previous ? device.routePurpose : undefined;
          if (!taskUpdate) {
            if (!Array.isArray(payload.route) || payload.route.length === 1) throw new RangeError('规划路径须为空或至少包含两个航点');
            route = payload.route.map(point => this.city(point, payload, options.calibrations));
            if (payload.purpose !== undefined && !['outbound', 'reconnaissance', 'return'].includes(String(payload.purpose)))
              throw new RangeError('规划路径用途无效');
            purpose = (payload.purpose ?? 'outbound') as RoutePurpose;
          }
          if (payload.routeComplete !== undefined && typeof payload.routeComplete !== 'boolean') throw new RangeError('路线完成标志无效');
          const routeClosed = (previous && device.routeClosed) || payload.routeComplete === true || purpose === 'return' ||
            (updateStatus && closesRoute(status, purpose)) || device.connection === 'disconnected' || device.connection === 'error' || device.stale;
          const explicitWater = payload.waterTarget === undefined ? undefined :
            deviceToCity(coordinates(payload.waterTarget), 'CITY90x75', options.calibrations);
          const dispatch = this.snapshot.agents.dispatch;
          const sameFire = dispatch?.incidentId === incidentId && dispatch.sessionId === sessionId;
          const started = taskUpdate && status === 'extinguishing' && (updateStatus || explicitWater !== undefined);
          const activateWater = started && (sameFire ?
            dispatch.fireStatus !== 'extinguished' && (!dispatch.suppression || time >= (this.latest.get('agent:dispatch') ?? -Infinity)) &&
              (explicitWater ?? dispatch.firePosition) : explicitWater);
          const waterTarget = activateWater || (previous && status === 'extinguishing' ? device.waterTarget : undefined);
          if (!previous && current) this.retiredTasks.add(JSON.stringify([device.id, current.sessionId, current.incidentId, current.id]));
          if (!previous) this.latest.delete(taskUpdate ? routeKey : taskKey);
          this.latest.set(missionKey, Math.max(missionTime, time));
          if (updateStatus) this.latest.set(statusKey, time);
          patch = { devices: { ...this.snapshot.devices, [device.id]: { ...device, route, routePurpose: purpose, routeClosed, status,
            waterTarget, waterIncidentId: waterTarget ? incidentId : undefined,
            task: { id: taskId, incidentId, phase, sessionId, result } } } };
          if (activateWater && (!dispatch || sameFire)) {
            const agentTime = this.latest.get('agent:dispatch') ?? -Infinity;
            patch.agents = { ...this.snapshot.agents, dispatch: {
              phase: phase!, summary: result ?? '设备已上报作业开始', incidentId, sessionId, taskId, deviceId: device.id,
              ...dispatch, firePosition: dispatch?.firePosition ?? activateWater, fireStatus: 'extinguishing', suppression: undefined,
            } };
            this.latest.set('agent:dispatch', Math.max(agentTime, time));
          }
          log = { source: device.id, deviceId: device.id, object: taskId, status: taskUpdate ? phase! : purpose === 'return' ? '返程规划' : '规划路径',
            summary: taskUpdate ? (payload.result === undefined ? '任务状态更新' : result!) : route?.length ? '路线更新' : '路线已撤除' };
          break;
        }
        case 'recon.candidate': {
          const device = this.device(payload.deviceId, options.idMap);
          const candidatePoiId = requiredText(payload.candidatePoiId, 'candidatePoiId');
          if (device.kind !== 'drone' || !incidentId || !taskId || poiRegistry.get(candidatePoiId)?.type !== 'Tank')
            throw new RangeError('侦查反馈缺少有效无人机、任务或候选编号');
          const stage = candidateStages.find(value => value === payload.stage);
          if (!stage) throw new RangeError('候选侦查阶段无效');
          const rank = payload.rank === undefined ? undefined : finite(payload.rank, 'rank');
          if (rank !== undefined && ![1, 2, 3].includes(rank)) throw new RangeError('候选排名无效');
          const result = stage === 'observed' || payload.result !== undefined ? requiredText(payload.result, 'result') : undefined;
          const previous = this.snapshot.reconnaissance.find(report => report.incidentId === incidentId && report.sessionId === sessionId &&
            report.taskId === taskId && report.deviceId === device.id && report.candidatePoiId === candidatePoiId);
          if (previous && (time < previous.occurredAt || candidateStages.indexOf(stage) < candidateStages.indexOf(previous.stage)))
            throw new RangeError('收到逆序的候选侦查反馈');
          patch = { reconnaissance: [...this.snapshot.reconnaissance.filter(report => report !== previous), {
            candidatePoiId, rank: rank ?? previous?.rank, deviceId: device.id, taskId, incidentId, stage, result, eventId: id, occurredAt: time, sessionId,
          }] };
          log = { source: device.id, deviceId: device.id, object: candidatePoiId, status: candidateStageLabels[stage], summary: result ?? '候选侦查进度' };
          break;
        }
        case 'recon.confirmed': {
          if (!incidentId) throw new RangeError('火点确认缺少 incidentId');
          const targetPoiId = payload.confirmedFirePoiId === undefined ? undefined : requiredText(payload.confirmedFirePoiId, 'confirmedFirePoiId');
          if (targetPoiId && poiRegistry.get(targetPoiId)?.type !== 'Tank') throw new RangeError('确认火点编号无效');
          const firePosition = payload.position !== undefined ? this.city(payload.position, payload, options.calibrations) :
            targetPoiId ? tankPoint(targetPoiId) : undefined;
          if (!firePosition) throw new RangeError('火点确认缺少位置');
          const deviceId = payload.deviceId === undefined ? undefined : this.device(payload.deviceId, options.idMap).id;
          const summary = requiredText(payload.result, 'result');
          const phase = '火点已确认';
          const current = this.snapshot.agents.dispatch;
          const old = time < (this.latest.get('agent:dispatch') ?? -Infinity);
          orderKey = old ? undefined : 'agent:dispatch';
          const sameIncident = current?.incidentId === incidentId && current.sessionId === sessionId;
          const fireStatus = sameIncident && current.fireStatus && current.fireStatus !== 'normal' ? current.fireStatus : 'burning';
          patch = old ? (sameIncident && !current.firePosition ? { agents: { ...this.snapshot.agents, dispatch: { ...current,
            targetPoiId, firePosition, fireStatus } } } : {}) :
            { agents: { ...this.snapshot.agents, dispatch: { phase, summary, sessionId, incidentId, taskId, deviceId,
              targetPoiId, firePosition, fireStatus, suppression: sameIncident ? current.suppression : undefined } } };
          log = { source: agentNames.dispatch, status: phase, summary, deviceId, object: targetPoiId };
          break;
        }
        case 'agent.event': {
          const agent = requiredText(payload.agent, 'agent') as Agent;
          if (!Object.hasOwn(agentNames, agent)) throw new RangeError('未知 Agent');
          if (context?.external && this.mode === 'physical' && agent !== 'dispatch') throw new RangeError('舆情和火情定位使用现有 Bridge 输入');
          const phase = requiredText(payload.phase, 'phase');
          const summary = requiredText(payload.summary, 'summary');
          const deviceId = payload.deviceId === undefined ? undefined : this.device(payload.deviceId, options.idMap).id;
          const object = payload.object === undefined ? taskId ?? incidentId : requiredText(payload.object, 'object');
          const currentAgent = this.snapshot.agents[agent];
          const previous = incidentId && currentAgent?.incidentId === incidentId && currentAgent.sessionId === sessionId ? currentAgent : undefined;
          const targetPoiId = payload.targetPoiId === undefined ? previous?.targetPoiId : requiredText(payload.targetPoiId, 'targetPoiId');
          if (targetPoiId !== undefined && (agent !== 'dispatch' || poiRegistry.get(targetPoiId)?.type !== 'Tank'))
            throw new RangeError('调度火情目标无效');
          const suppression = payload.suppression === undefined ? undefined : requiredText(payload.suppression, 'suppression') as AgentState['suppression'];
          const firePosition = targetPoiId ? targetPoiId === previous?.targetPoiId ? previous.firePosition ?? tankPoint(targetPoiId) : tankPoint(targetPoiId) : previous?.firePosition;
          const fireStatus = payload.fireStatus === undefined ? (suppression && previous?.fireStatus === 'extinguishing' ? 'burning' :
            targetPoiId === previous?.targetPoiId ? previous?.fireStatus : undefined) : requiredText(payload.fireStatus, 'fireStatus') as FireSceneStatus;
          if (fireStatus !== undefined && ((!targetPoiId && !firePosition) || !['normal', 'burning', 'extinguishing', 'extinguished'].includes(fireStatus)) ||
            suppression !== undefined && (agent !== 'dispatch' || !incidentId || !['failed', 'interrupted'].includes(suppression) ||
              fireStatus === 'extinguished' || fireStatus === 'extinguishing'))
            throw new RangeError('调度火情状态或目标无效');
          const key = `agent:${agent}`;
          // Late historical events belong in the timeline, while the panel keeps its latest state.
          const current = time >= (this.latest.get(key) ?? -Infinity);
          orderKey = current ? key : undefined;
          const activeSuppression = suppression ?? (payload.fireStatus !== undefined ? undefined : previous?.suppression);
          patch = current ? { agents: { ...this.snapshot.agents, [agent]: { phase, summary, sessionId, incidentId, taskId, deviceId, targetPoiId,
            firePosition, fireStatus, suppression: activeSuppression } } } : {};
          if (current && agent === 'dispatch' && incidentId && (fireStatus === 'extinguished' || suppression)) {
            patch.devices = Object.fromEntries(Object.values(this.snapshot.devices).map(device =>
              [device.id, device.waterIncidentId === incidentId ? { ...device, waterTarget: undefined } : device]));
          }
          log = { source: agentNames[agent], status: phase, summary: `${requiredText(payload.type, 'type')} · ${summary}`, object, deviceId };
          break;
        }
        case 'media.feed': {
          const slot = mediaSlots.find(slot => slot.id === payload.slotId);
          if (!slot || slot.kind !== payload.kind) throw new RangeError('媒体窗口与媒体类型不匹配');
          orderKey = this.ordered(`media:${slot.id}`, time);
          const previous = this.snapshot.media[slot.id];
          const feedId = requiredText(payload.feedId, 'feedId');
          const same = previous?.feedId === feedId;
          const status = requiredText(payload.status, 'status') as MediaStatus;
          if (!['idle', 'connecting', 'ready', 'disconnected', 'error', 'reconnecting'].includes(status)) throw new RangeError('媒体状态无效');
          if (previous && !same && (status === 'disconnected' || status === 'error' || status === 'idle'))
            throw new RangeError('收到非当前媒体源的结束状态');
          const declaredDevice = payload.deviceId === undefined ? undefined : this.device(payload.deviceId, options.idMap).id;
          const deviceId = 'deviceId' in slot ? slot.deviceId : declaredDevice ?? (same ? previous.deviceId : undefined);
          if (declaredDevice && declaredDevice !== deviceId || deviceId && !('deviceId' in slot) && this.snapshot.devices[deviceId].kind !== 'drone')
            throw new RangeError('媒体源与设备归属不匹配');
          const url = payload.url === undefined ? (same ? previous.url : undefined) : mediaUrl(payload.url);
          const stream = payload.stream === undefined ? (same && payload.url === undefined ? previous.stream : undefined) : payload.stream;
          if (stream !== undefined && (slot.kind !== 'video' || typeof MediaStream === 'undefined' || !(stream instanceof MediaStream)))
            throw new RangeError('媒体流句柄无效');
          if (status === 'ready' && !url && !stream) throw new RangeError('媒体就绪消息缺少可播放源');
          patch = { media: { ...this.snapshot.media, [slot.id]: { feedId, status, url: stream ? undefined : url, stream, deviceId } } };
          break;
        }
        case 'traffic.snapshot': {
          orderKey = this.ordered(type, time);
          patch = { signals: normalizeHardwareSignals(payload.devices, this.snapshot.signals) };
          break;
        }
        default: throw new RangeError(`未知消息类型 ${type}`);
      }
      if (orderKey) this.latest.set(orderKey, time);
      if (this.events.size >= 20_000) {
        for (const [event, entry] of this.events) if (entry.time < Date.now() - maxAge && !event.startsWith('bridge:')) this.events.delete(event);
        if (this.events.size >= 20_000) this.events.delete(this.events.keys().next().value!);
      }
      this.events.set(id, { time, sessionId });
      if (log) patch.log = [...this.snapshot.log, { ...log, id, time, type, sessionId, incidentId, taskId }].sort((a, b) => b.time - a.time).slice(0, 500);
      this.publish(report ? { ...patch, rejected: undefined } : patch);
      return { accepted: true };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return report ? this.reportError(error.message) : { accepted: false, error: error.message };
    }
  }
  private deviceStatus(device: Device, value: unknown) {
    const status = requiredText(value, 'status');
    if (!(device.kind === 'drone' ? droneStatuses : truckStatuses).includes(status)) throw new RangeError('设备运行状态无效');
    return status;
  }
  disconnectSignals() {
    this.publish({ signals: normalizeHardwareSignals({}, this.snapshot.signals) });
  }
  expirePositions(now = Date.now()) {
    const stale = Object.values(this.snapshot.devices).filter(device => !device.stale && device.locatedAt && now - device.locatedAt >= trackingTimeoutMs);
    if (stale.length) this.publish({ devices: { ...this.snapshot.devices,
      ...Object.fromEntries(stale.map(device => [device.id, { ...device, stale: true, routeClosed: !!device.task, waterTarget: undefined }])) } });
    if (now - (this.latest.get('traffic.snapshot') ?? now) >= trackingTimeoutMs && Object.values(this.snapshot.signals).some(signal => signal.connected)) this.disconnectSignals();
  }
}

let activeDashboard: { input: DashboardInput; subscriptions: Set<() => void> } | undefined;
export function registerDashboard(input: DashboardInput) {
  const workspace = { input, subscriptions: new Set<() => void>() };
  activeDashboard = workspace;
  return () => {
    if (activeDashboard === workspace) activeDashboard = undefined;
    workspace.subscriptions.forEach(disconnect => disconnect());
  };
}

// The integration owns transport and schema mapping. An inactive subscription cannot enter a new workspace.
export function connectDashboardSource(
  subscribe: (receive: (raw: unknown) => InputResult) => () => void,
  adapt: (raw: unknown) => unknown,
  options?: InputOptions,
  mode: SourceMode = 'physical',
) {
  const workspace = activeDashboard;
  if (!workspace || workspace.input.mode !== mode) throw new Error('当前工作台未启用该消息来源');
  const { input, subscriptions } = workspace;
  let active = true;
  let disconnect: () => void;
  try {
    const context = { external: true, mapping: options ? input.prepareOptions(options) : undefined };
    disconnect = subscribe(raw => {
      if (!active || activeDashboard !== workspace) return { accepted: false, error: '联动来源已切换或断开' };
      let mapped: unknown;
      try {
        mapped = adapt(raw);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return input.reportError(error.message);
      }
      return input.consume(mapped, context);
    });
  } catch (error) {
    active = false;
    if (!(error instanceof RangeError)) throw error;
    input.reportError(error.message);
    return () => {};
  }
  const close = () => {
    if (!active) return;
    active = false;
    subscriptions.delete(close);
    disconnect();
  };
  if (activeDashboard !== workspace) {
    close();
    return close;
  }
  subscriptions.add(close);
  return close;
}
