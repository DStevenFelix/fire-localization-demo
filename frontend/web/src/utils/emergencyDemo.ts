import config from '../config/emergency.json';
import type { Candidate, CityPosition, EmergencyAdapter, EmergencyCommand, EmergencyEvent, EmergencyIncident, EmergencyPlan, FireSceneSeverity } from '../types';
import type { DashboardInput, DashboardMessage } from '../services/dashboardInput';
import { severityLabels, type EmergencyService } from './emergency';
import { toCity } from './mapCoordinates';
import { poiRegistry } from './poiRegistry';

type DemoEvent<T = EmergencyEvent> = T extends EmergencyEvent ? Omit<T, 'incidentId' | 'messageId' | 'occurredAt'> : never;
type WorkbenchEvent<T = DashboardMessage> = T extends DashboardMessage ? Pick<T, 'eventType' | 'payload'> : never;
export type DemoNotice = { id: number; target: CityPosition; severity: FireSceneSeverity };
export type SimulatedObservation = (candidatePoiId: string) => { confirmedFirePoiId?: string; result: string };

function tankPosition(poiId: string): CityPosition {
  const poi = poiRegistry.get(poiId);
  if (poi?.type !== 'Tank') throw new Error(`无法将 ${poiId} 作为储罐侦察目标`);
  const { x_m, y_m } = toCity({ x_m: poi.center[0], y_m: poi.center[1] }, poi.coordinate_system);
  return { x: x_m, y: y_m };
}

export class EmergencyDemo implements EmergencyAdapter {
  readonly source = '模拟演示';
  private receive?: (event: unknown) => void;
  private sequence = 0;
  private mission?: { id: string; sessionId: string; targetPoiId: string; target: CityPosition };
  private patrol?: {
    id: string; sessionId: string; index: number; dwell: number; observe: SimulatedObservation;
    stops: { rank: number; poiId: string; deviceId: string; target: CityPosition }[];
    confirmed?: string;
  };
  private severity: FireSceneSeverity = 2;
  private dispatchCount?: number;
  private spraying = new Set<string>();

  constructor(private readonly service: EmergencyService, private readonly notify: (notice: DemoNotice) => void,
    private readonly dashboard?: DashboardInput) {}

  readonly simulatedFleet = {
    apply: (plan: EmergencyPlan) => {
      const target = plan.dispatches[0].targetPosition;
      this.service.traffic.applySimulatedFleet([target.x, target.y], plan.dispatches.map(d => d.vehicleId));
    },
    isHome: () => this.service.traffic.trucks.every(truck => truck.status === 'idle'),
  };

  subscribe(receive: (event: unknown) => void) {
    this.receive = receive;
    const unwatch = this.service.traffic.subscribe(seconds => this.advance(seconds), 'update');
    return () => { unwatch(); this.receive = undefined; };
  }

  owns(incident: EmergencyIncident | null) { return !!incident && incident.id === this.mission?.id; }
  hasStarted(sessionId: string | undefined) { return !!sessionId && this.patrol?.sessionId === sessionId; }
  getSeverity() { return this.severity; }

  start(sessionId: string, candidates: readonly Pick<Candidate, 'rank' | 'poi_id'>[], observe: SimulatedObservation, dispatchCount?: number) {
    if (!this.receive || this.hasStarted(sessionId)) return;
    const previous = this.service.getSnapshot().incident;
    if (previous && previous.phase !== 'completed') throw new Error('当前还有应急任务正在处置');
    const ranked = candidates.filter(({ rank, poi_id }) => rank >= 1 && rank <= 3 && poiRegistry.get(poi_id)?.type === 'Tank')
      .sort((a, b) => a.rank - b.rank);
    const unique = ranked.filter((candidate, index) => ranked.findIndex(item => item.poi_id === candidate.poi_id) === index);
    const drones = this.service.getSnapshot().drones;
    if (!unique.length) throw new Error('当前没有可执行侦察的储罐候选');
    const stops = unique.map(({ rank, poi_id }, index) => ({
      rank, poiId: poi_id, target: tankPosition(poi_id), deviceId: drones[index % drones.length].id,
    }));
    this.dispatchCount = dispatchCount;
    this.mission = undefined;
    this.patrol = { id: `demo:${sessionId}`, sessionId, index: 0, dwell: 0, observe, stops };
    this.spraying.clear();
    this.report({ eventType: 'agent.event', payload: { agent: 'dispatch', type: '模拟侦查', phase: '无人机巡查候选',
      summary: '按候选排名逐点侦查，等待现场反馈' } });
    for (const drone of drones) {
      const assignments = stops.filter(stop => stop.deviceId === drone.id);
      for (const stop of assignments) this.candidateReport(stop, 'assigned');
      if (!assignments.length) continue;
      this.report({ eventType: 'device.route', payload: { deviceId: drone.id, taskId: this.patrolTask(drone.id),
        coordinateSystem: 'CITY90x75', purpose: 'reconnaissance', route: [drone.position, ...assignments.map(stop => stop.target)] } });
    }
    this.flyToStop(stops[0]);
  }

  private patrolTask(deviceId: string) { return `${this.patrol!.id}:${deviceId}:patrol`; }

  private report(event: WorkbenchEvent) {
    const incidentId = this.patrol!.id;
    const result = this.dashboard?.consume({ ...event, sourceMode: 'simulation', incidentId, occurredAt: Date.now(),
      eventId: `${incidentId}:workbench:${++this.sequence}` });
    if (result?.accepted === false) throw new Error(result.error);
  }

  private candidateReport(stop: NonNullable<typeof this.patrol>['stops'][number], stage: 'assigned' | 'arrived' | 'observed', result?: string) {
    this.report({ eventType: 'recon.candidate', payload: { deviceId: stop.deviceId, candidatePoiId: stop.poiId,
      rank: stop.rank, taskId: this.patrolTask(stop.deviceId), stage, result } });
  }

  private flyToStop(stop: NonNullable<typeof this.patrol>['stops'][number]) {
    const drone = this.service.getDrone(stop.deviceId)!;
    this.service.updateSimulatedRecon({ ...drone, status: 'flying', altitude: drone.id === config.drones[0].id ? 110 : 125,
      updatedAt: drone.updatedAt + 1, path: [drone.position, stop.target] });
  }

  private advancePatrol(seconds: number) {
    const patrol = this.patrol;
    const stop = patrol?.stops[patrol.index];
    if (!patrol || !stop) return;
    const drone = this.service.getDrone(stop.deviceId)!;
    if (drone.path) return;
    if (patrol.dwell === 0) this.candidateReport(stop, 'arrived');
    patrol.dwell += seconds;
    if (patrol.dwell < config.reconDwellSeconds) return;
    const observation = patrol.observe(stop.poiId);
    this.candidateReport(stop, 'observed', observation.result);
    if (observation.confirmedFirePoiId) patrol.confirmed = observation.confirmedFirePoiId;
    patrol.dwell = 0;
    const next = patrol.stops[++patrol.index];
    const remaining = patrol.stops.slice(patrol.index).filter(assignment => assignment.deviceId === drone.id);
    if (remaining.length) {
      this.report({ eventType: 'device.route', payload: { deviceId: drone.id, taskId: this.patrolTask(drone.id), coordinateSystem: 'CITY90x75',
        purpose: 'reconnaissance', route: [drone.position, ...remaining.map(assignment => assignment.target)] } });
    } else {
      this.report({ eventType: 'device.task', payload: { deviceId: drone.id, taskId: this.patrolTask(drone.id),
        status: 'observing', phase: '已完成分配的候选侦查', routeComplete: true } });
      this.service.updateSimulatedRecon({ ...drone, status: 'observing' });
    }
    if (next) { this.flyToStop(next); return; }
    if (!patrol.confirmed) {
      this.report({ eventType: 'agent.event', payload: { agent: 'dispatch', type: '模拟侦查',
        phase: '火点尚未确认', summary: '候选巡查已完成，等待补充侦查反馈' } });
      return;
    }
    const target = tankPosition(patrol.confirmed);
    this.mission = { id: patrol.id, sessionId: patrol.sessionId, targetPoiId: patrol.confirmed, target };
    this.report({ eventType: 'recon.confirmed', payload: { confirmedFirePoiId: patrol.confirmed, result: '模拟现场回传确认火点，转入火场监控' } });
    this.emit({ type: 'fire.detected', targetPoiId: patrol.confirmed });
    this.service.getSnapshot().drones.filter(d => patrol.stops.some(assignment => assignment.deviceId === d.id)).forEach((d, index) => {
      this.emit({ type: 'drone.update', drone: { ...d, status: 'flying', targetPoiId: patrol.confirmed, updatedAt: d.updatedAt + 1,
        path: [d.position, { x: target.x + .8 * index, y: target.y }] } });
    });
  }

  applySettings(severity: FireSceneSeverity) {
    if (severity === this.severity) return;
    const { incident, pending } = this.service.getSnapshot();
    if (pending) throw new Error('调度方案正在执行，请稍后确认');
    const active = incident && this.owns(incident) && incident.fireStatus !== 'extinguished';
    if (active && incident.confirmed) {
      const plan = this.plan(severity);
      this.emit({ type: 'plan.revised', plan, assessment: this.assessment(severity) });
      this.spraying = new Set([...this.spraying].filter(id => plan.dispatches.some(d => d.vehicleId === id)));
    }
    this.severity = severity;
    if (active && incident.observedIds.length > 0) this.showNotice();
  }

  canConfirmExtinction() {
    const { incident, pending } = this.service.getSnapshot();
    return !!this.receive && !pending && this.owns(incident) && incident?.fireStatus === 'extinguishing';
  }

  confirmExtinction() {
    if (this.canConfirmExtinction()) this.emit({ type: 'fire.extinguished' });
  }

  async execute(command: EmergencyCommand, signal: AbortSignal) {
    signal.throwIfAborted();
    if (command.incidentId !== this.mission?.id) throw new Error('命令不属于当前演示任务');
    if (command.type !== 'responders.return') return;
    this.service.traffic.applySimulatedFleet(null);
    command.vehicleIds.forEach(vehicleId => this.emit({ type: 'truck.return', vehicleId }));
    command.droneIds.forEach(id => {
      const drone = this.service.getDrone(id)!;
      const home = config.drones.find(d => d.id === id)!;
      this.emit({ type: 'drone.return', drone: { ...drone, status: 'returning',
        path: [drone.position, home.position], updatedAt: drone.updatedAt + 1 } });
    });
  }

  private emit(event: DemoEvent) {
    const incidentId = this.mission!.id;
    const occurredAt = ++this.sequence;
    this.receive?.({ ...event, messageId: `${incidentId}:${occurredAt}`, incidentId, occurredAt });
    const error = this.service.getSnapshot().inputError;
    if (error) throw new Error(error);
  }

  private assessment(severity: FireSceneSeverity) {
    return { targetPoiId: this.mission!.targetPoiId, status: 'completed' as const, severity, source: this.source,
      result: `无人机已完成模拟侦察，火情等级为${severityLabels[severity]}。` };
  }

  private plan(severity: FireSceneSeverity): EmergencyPlan {
    const { id, targetPoiId, target } = this.mission!;
    const vehicles = this.service.traffic.closestTruckIds([target.x, target.y], this.dispatchCount ?? severity);
    return { id: `${id}:plan:${this.sequence}`, targetPoiId, trafficLockdown: false,
      summary: this.dispatchCount === undefined ? `模拟演练 · ${severityLabels[severity]}预设 · ${vehicles.length} 辆消防车。` :
        `模拟演练配置 · ${vehicles.length} 辆消防车。`,
      dispatches: vehicles.map(vehicleId => ({ vehicleId, targetPoiId, targetPosition: target, status: 'dispatched' })) };
  }

  private showNotice() {
    this.notify({ id: ++this.sequence, target: this.mission!.target, severity: this.severity });
  }

  private advance(seconds: number) {
    const { incident, drones, pending } = this.service.getSnapshot();
    if (!seconds) return;
    if (!this.mission) { this.advancePatrol(seconds); return; }
    if (!incident || !this.owns(incident) || pending || ['completed', 'failed'].includes(incident.phase)) return;
    if (incident.fireStatus === 'extinguished') {
      for (const drone of drones) {
        if (drone.status !== 'returning' || drone.path) continue;
        const home = config.drones.find(d => d.id === drone.id)!;
        this.emit({ type: 'drone.return', drone: { ...home, status: 'charging', updatedAt: drone.updatedAt + 1 } });
      }
      return;
    }
    if (!incident.assessment) {
      let first = incident.observedIds.length === 0;
      for (const drone of drones) {
        if (drone.status !== 'flying' || drone.path) continue;
        this.emit({ type: 'drone.observed', droneId: drone.id });
        if (first) { this.showNotice(); first = false; }
      }
      const observed = this.service.getSnapshot().incident!.observedIds;
      if (incident.droneIds.length && incident.droneIds.every(id => observed.includes(id))) {
        this.emit({ type: 'fire.assessed', assessment: this.assessment(this.severity) });
        this.emit({ type: 'plan.proposed', plan: this.plan(this.severity) });
        void this.service.confirm();
      }
      return;
    }
    if (!incident.confirmed) return;
    const ids = incident.plan!.dispatches.map(d => d.vehicleId);
    for (const id of ids) {
      if (this.spraying.has(id) || this.service.traffic.trucks.find(t => t.id === id)?.status !== 'arrived') continue;
      this.emit({ type: 'truck.arrived', vehicleId: id });
      this.emit({ type: 'truck.extinguishing', vehicleId: id });
      this.spraying.add(id);
    }
  }
}
