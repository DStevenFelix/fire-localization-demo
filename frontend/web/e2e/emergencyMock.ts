// Test-only algorithm source. Never imported by src or the production entry.
import config from '../src/config/emergency.json';
import type { EmergencyAdapter, EmergencyCommand, EmergencyEvent, EmergencyPlan, FireSceneSeverity } from '../src/types';
import type { EmergencyService } from '../src/utils/emergency';
import { poiRegistry } from '../src/utils/poiRegistry';
import { roadPieces } from '../src/utils/roadNetwork';
import { TrafficSimulation } from '../src/utils/trafficSimulation';

type Payload<T> = T extends EmergencyEvent ? Omit<T, 'messageId' | 'incidentId' | 'occurredAt'> : never;
export function createEmergencyMock(service: EmergencyService, incidentId = 'TEST-INCIDENT-01') {
  let sequence = 0;
  let receive: (event: unknown) => void = () => {};
  const commands: EmergencyCommand[] = [];
  const phases: string[] = ['idle'];
  const emit = (event: Payload<EmergencyEvent>) => {
    const message = { ...event, messageId: `${incidentId}:${++sequence}`, incidentId, occurredAt: sequence };
    return service.receive(message);
  };
  const adapter: EmergencyAdapter = {
    source: '隔离 Mock · 应急演练',
    subscribe(listener) {
      receive = listener;
      const unwatch = service.subscribe(() => {
        const phase = service.getSnapshot().incident?.phase ?? 'idle';
        if (phases.at(-1) !== phase) phases.push(phase);
      });
      return () => { unwatch(); receive = () => {}; };
    },
    async execute(command) {
      commands.push(command);
      if (command.type !== 'responders.return') return;
      command.vehicleIds.forEach(vehicleId => emit({ type: 'truck.return', vehicleId }));
      command.droneIds.forEach(id => {
        const current = service.getDrone(id)!;
        emit({ type: 'drone.return', drone: { ...current, status: 'returning', updatedAt: current.updatedAt + 1,
          path: [current.position, config.drones.find(d => d.id === id)!.position] } });
      });
    },
  };
  function begin(targetPoiId = 'T-SW-01') {
    const poi = poiRegistry.get(targetPoiId)!;
    emit({ type: 'fire.detected', targetPoiId: poi.id });
    service.getSnapshot().drones.forEach((d, i) => emit({ type: 'drone.update', drone: { ...d,
      status: 'flying', updatedAt: d.updatedAt + 1, altitude: 110 + i * 15, targetPoiId: poi.id,
      path: [d.position, { x: poi.center[0] + 30 - .8 + i * 1.6, y: poi.center[1] + 25 }] } }));
  }
  function prepare(count = 2, severity: FireSceneSeverity = 2, includeFlight = true): EmergencyPlan {
    if (includeFlight) {
      begin(service.getSnapshot().incident?.targetPoiId);
      service.getSnapshot().drones.forEach(d => {
        emit({ type: 'drone.update', drone: { ...d, position: d.path!.at(-1)!, path: undefined, status: 'observing', updatedAt: d.updatedAt + 1 } });
        emit({ type: 'drone.observed', droneId: d.id });
      });
    }
    const poi = poiRegistry.get(service.getSnapshot().incident?.targetPoiId ?? 'T-SW-01')!, goal: [number, number] = [poi.center[0] + 30, poi.center[1] + 25];
    // Fixture planner uses the old algorithm in a separate simulator; it cannot dispatch the app's fleet.
    const planner = new TrafficSimulation();
    planner.pedestrians.actors.forEach(actor => {
      const crossing = actor.route.segments[actor.index].crosswalk;
      if (crossing) planner.signals.release(planner.signals.getCrosswalkControl(crossing)!.intersection.id, actor.id);
    });
    planner.cars.forEach((car, i) => {
      const actual = service.traffic.cars[i];
      Object.assign(car, actual, { cursor: { ...actual.cursor }, pose: { point: [...actual.pose.point], angle: actual.pose.angle } });
      if (car.junction) planner.signals.occupy(car.junction, car.id, 'vehicle');
    });
    planner.pedestrians.actors.forEach((actor, i) => {
      const actual = service.traffic.pedestrians.actors[i];
      Object.assign(actor, actual, { point: [...actual.point] });
      const segment = actor.route.segments[actor.index];
      if (segment.crosswalk && actor.distance > 1e-8) planner.signals.occupy(planner.signals.getCrosswalkControl(segment.crosswalk)!.intersection.id, actor.id, 'pedestrian', segment.crosswalk);
    });
    planner.signals.setMode('emergency_priority'); planner.setIncident(goal, count as FireSceneSeverity);
    const ids = new Map([...roadPieces].map(([id, piece]) => [piece, id]));
    const selected = planner.trucks.filter(t => t.status === 'en-route' || t.status === 'arrived').sort((a, b) =>
      a.path.slice(0, -1).reduce((sum, p) => sum + p.length, a.stop) - b.path.slice(0, -1).reduce((sum, p) => sum + p.length, b.stop));
    const journeys = new Map(selected.map(t => [t.id, [t.cursor.piece]]));
    for (let time = 0; time < 300 && !selected.every(t => t.status === 'arrived'); time += .022) {
      planner.tick(.022);
      selected.forEach(t => { const journey = journeys.get(t.id)!; if (journey.at(-1) !== t.cursor.piece) journey.push(t.cursor.piece); });
    }
    if (!selected.every(t => t.status === 'arrived')) throw new Error('测试算法未生成抵达火场的完整路径');
    // A fixed external plan gives the front parking position departure priority.
    selected.sort((a, b) => a.cursor.piece === b.cursor.piece ? b.cursor.distance - a.cursor.distance : 0);
    const plan: EmergencyPlan = { id: `TEST-PLAN-${sequence}`, targetPoiId: poi.id, trafficLockdown: true,
      summary: '侦察确认储罐火情，调派指定消防力量前往处置。',
      dispatches: selected.map(t => ({
        vehicleId: t.id, targetPoiId: poi.id, targetPosition: { x: goal[0], y: goal[1] }, status: 'dispatched',
        route: { pieceIds: journeys.get(t.id)!.map(p => ids.get(p)!), stop: t.cursor.distance },
      })) };
    emit({ type: 'fire.assessed', assessment: { targetPoiId: poi.id, severity, status: 'completed', result: '储罐顶部可见明火，已完成空中侦察。', source: '测试外部数据源' } });
    emit({ type: 'plan.proposed', plan });
    return plan;
  }
  function dockDrones() {
    service.getSnapshot().drones.forEach(d => emit({ type: 'drone.return', drone: { ...d, path: undefined,
      position: config.drones.find(home => home.id === d.id)!.position, altitude: 0, status: 'charging', updatedAt: d.updatedAt + 1 } }));
  }
  return { adapter, emit, begin, prepare, commands, phases, dockDrones, raw: (event: unknown) => receive(event) };
}
