import config from '../config/emergency.json';
import type { CityPosition, EmergencyAdapter, EmergencyCommand, EmergencyEvent, EmergencyIncident, EmergencyPlan, FireSceneSeverity } from '../types';
import { severityLabels, type EmergencyService } from './emergency';
import { toCity } from './mapCoordinates';
import { poiRegistry } from './poiRegistry';

type DemoEvent<T = EmergencyEvent> = T extends EmergencyEvent ? Omit<T, 'incidentId' | 'messageId' | 'occurredAt'> : never;
export type DemoNotice = { id: number; target: CityPosition; severity: FireSceneSeverity };

export class EmergencyDemo implements EmergencyAdapter {
  readonly source = '模拟演示';
  private receive?: (event: unknown) => void;
  private sequence = 0;
  private mission?: { id: string; sessionId: string; targetPoiId: string; target: CityPosition };
  private severity: FireSceneSeverity = 2;
  private spraying = new Set<string>();

  constructor(private readonly service: EmergencyService, private readonly notify: (notice: DemoNotice) => void) {}

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
  hasStarted(sessionId: string | undefined) { return !!sessionId && this.mission?.sessionId === sessionId; }
  getSeverity() { return this.severity; }

  start(sessionId: string, targetPoiId: string) {
    if (!this.receive || this.hasStarted(sessionId)) return;
    const previous = this.service.getSnapshot().incident;
    if (previous && previous.phase !== 'completed') throw new Error('当前还有应急任务正在处置');
    const poi = poiRegistry.get(targetPoiId);
    if (poi?.type !== 'Tank') throw new Error('无法将该预测位置作为储罐侦察目标');
    const coordinate = toCity({ x_m: poi.center[0], y_m: poi.center[1] }, poi.coordinate_system);
    this.mission = { id: `demo:${sessionId}`, sessionId, targetPoiId, target: { x: coordinate.x_m, y: coordinate.y_m } };
    this.spraying.clear();
    this.emit({ type: 'fire.detected', targetPoiId });
    this.service.getSnapshot().drones.forEach((drone, index) => {
      const { x, y } = this.mission!.target;
      this.emit({ type: 'drone.update', drone: { ...drone, status: 'flying', altitude: 110 + 15 * index,
        targetPoiId, updatedAt: drone.updatedAt + 1,
        path: [drone.position, { x: x + (index === 0 ? -.8 : .8), y }] } });
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
    if (active) this.showNotice();
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
    const vehicles = this.service.traffic.closestTruckIds([target.x, target.y], severity);
    return { id: `${id}:plan:${this.sequence}`, targetPoiId, trafficLockdown: false,
      summary: `按${severityLabels[severity]}调派 ${vehicles.length} 辆消防车。`,
      dispatches: vehicles.map(vehicleId => ({ vehicleId, targetPoiId, targetPosition: target, status: 'dispatched' })) };
  }

  private showNotice() {
    this.notify({ id: ++this.sequence, target: this.mission!.target, severity: this.severity });
  }

  private advance(seconds: number) {
    const { incident, drones, pending } = this.service.getSnapshot();
    if (!seconds || !incident || !this.owns(incident) || pending || ['completed', 'failed'].includes(incident.phase)) return;
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
