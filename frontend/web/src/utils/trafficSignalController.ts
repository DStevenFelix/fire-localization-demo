import { fire_station_reserve, nodes, roads, original_map_placement } from '../../../../city_scene/city_scene.json';
import config from '../config/trafficControl.json';
import type { IntersectionSignalState, TrafficControlMode, TrafficControlService } from '../types';
import { distance, garage, lanes, pose, stationJunction, type Piece, type Point } from './roadNetwork';
import { crosswalkGeometry, junctionKey, originalRoadWidths } from './trafficSignalGeometry';

const roadWidths = new Map([...roads.map(r => [r.id, r.width] as const), ...originalRoadWidths]);
export const signalCrosswalks = crosswalkGeometry.map(c => c.original ? c :
  { ...c, junction: junctionKey(nodes.find(n => n.id === c.junction)!.center) });

export const approachId = (lane: Piece) => lane.road ? `${lane.from}>${lane.to}` : 'STATION_ACCESS';
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const heading = (lane: Piece): Point => { const angle = pose({ piece: lane, distance: 0 }).angle; return [Math.cos(angle), Math.sin(angle)]; };
const access = fire_station_reserve.access;
const drivewayHeading = [0, 1].map(axis => (access.road_connection[axis] - access.entrance[axis]) /
  distance(access.entrance as Point, access.road_connection as Point)) as Point;
function drivewayStopLine(lane: Piece) {
  const stop = distance(access.entrance as Point, access.road_connection as Point) - roadWidths.get(access.road_id)! / 2 - .15;
  const along = lane.points.map(p => dot([p[0] - access.entrance[0], p[1] - access.entrance[1]], drivewayHeading));
  const index = along.findIndex(n => n >= stop - 1e-8);
  return lane.cumulative[index - 1] + (stop - along[index - 1]) / (along[index] - along[index - 1]) *
    (lane.cumulative[index] - lane.cumulative[index - 1]);
}

export function crossingPathsConflict(a: Point[], b: Point[]) {
  const cross = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const sides = [cross(a[0], a[1], b[0]), cross(a[0], a[1], b[1]), cross(b[0], b[1], a[0]), cross(b[0], b[1], a[1])];
  if (sides.every(n => Math.abs(n) < 1e-8)) {
    const axis = Math.abs(a[1][0] - a[0][0]) > Math.abs(a[1][1] - a[0][1]) ? 0 : 1;
    return Math.min(Math.max(a[0][axis], a[1][axis]), Math.max(b[0][axis], b[1][axis])) -
      Math.max(Math.min(a[0][axis], a[1][axis]), Math.min(b[0][axis], b[1][axis])) > 1e-8;
  }
  if (a.some(p => b.some(q => distance(p, q) < 1e-8))) return false;
  return sides[0] * sides[1] <= 0 && sides[2] * sides[3] <= 0;
}

const incoming = new Map<string, Piece[]>();
lanes.forEach(lane => incoming.set(lane.to!, [...(incoming.get(lane.to!) ?? []), lane]));
const stationEntry = garage.reduce((best, lane) => distance(lane.points[0], access.entrance as Point) <
  distance(best.points[0], access.entrance as Point) ? lane : best);
incoming.set(stationJunction, [...incoming.get(stationJunction)!, stationEntry]);

export const intersections = [...incoming].flatMap(([id, approaches]) => {
  const point = id.split(',').map(Number) as Point;
  const crosswalks = signalCrosswalks.filter(c => c.junction === id);
  // 车道端点按统一城市坐标合并；度数 2 的连接边界和折点没有交叉冲突。
  if (approaches.length < 3 && crosswalks.length === 0) return [];
  const entries = approaches.map(lane => {
    const h: Point = lane.road ? heading(lane) : drivewayHeading;
    const start = lane.points[0];
    const stopLine = lane.road ? Math.max(0, Math.min(lane.length - .12, ...crosswalks.flatMap(c => {
      const a = c.points[0], b = c.points[1];
      if (Math.abs(dot(h, [(b[0] - a[0]) / distance(a, b), (b[1] - a[1]) / distance(a, b)])) > .15) return [];
      const along = dot([(a[0] + b[0]) / 2 - start[0], (a[1] + b[1]) / 2 - start[1]], h);
      return along > 0 && along < lane.length + .1 ? [along - c.halfWidth - .15] : [];
    }))) : drivewayStopLine(lane);
    const at = pose({ piece: lane, distance: stopLine }).point;
    const curb = lane.road ? roadWidths.get(lane.road)! / 2 - Math.abs(dot([at[0] - point[0], at[1] - point[1]], [h[1], -h[0]])) + .25 : .55;
    return { id: approachId(lane), lane, heading: h, stopLine,
      lamp: [at[0] + h[1] * curb, at[1] - h[0] * curb] as Point };
  });
  const groups: { id: string; kind: 'vehicle' | 'pedestrian'; members: string[]; duration: number }[] = [];
  entries.forEach(entry => {
    if (groups.some(g => g.members.includes(entry.id))) return;
    const compatible = entries.filter(other => Math.abs(dot(entry.heading, other.heading)) > .999);
    groups.push({ id: `vehicle:${groups.length}`, kind: 'vehicle', members: compatible.map(e => e.id), duration: config.timing.vehicleGreen });
  });
  crosswalks.forEach(crossing => {
    const compatible = groups.find(g => g.kind === 'pedestrian' && g.members.every(id =>
      !crossingPathsConflict(crossing.points, crosswalks.find(c => c.id === id)!.points)));
    if (compatible) { compatible.members.push(crossing.id); return; }
    groups.push({ id: `pedestrian:${groups.length}`, kind: 'pedestrian', members: [crossing.id], duration: config.timing.pedestrianGreen });
  });
  const main = groups.filter(g => g.kind === 'vehicle').sort((a, b) => b.members.length - a.members.length)[0];
  const original = point[0] >= original_map_placement.extent[0] && point[0] <= original_map_placement.extent[2] &&
    point[1] >= original_map_placement.extent[1] && point[1] <= original_map_placement.extent[3];
  return [{ id, point, entries, crosswalks, groups, mainGroup: main.id,
    kind: id === stationJunction ? 'station_access' : approaches.length === 4 ? 'crossroad' : approaches.length === 3 ? 't_junction' : 'crossing',
    region: id === stationJunction ? 'station' : original ? 'original' : 'extension' }];
});

const topology = new Map(intersections.map(i => [i.id, i]));
const controlledLanes = new Map(intersections.flatMap(i => i.entries.map(e => [e.lane, { intersection: i, entry: e }] as const)));
// 三个车位共用一个真实出口。驶出轨迹的弧长不同，停止线落在同一个道路边缘。
garage.forEach(lane => {
  const shared = controlledLanes.get(stationEntry)!;
  controlledLanes.set(lane, { intersection: shared.intersection, entry: { ...shared.entry, lane, stopLine: drivewayStopLine(lane) } });
});
const controlledCrossings = new Map(intersections.flatMap(i => i.crosswalks.map(c => [c.id, { intersection: i, crossing: c }] as const)));
type Occupant = { kind: 'vehicle' | 'pedestrian'; crossing?: string };

function geometricExitClearance(lane: Piece, id: string, halfLength: number) {
  const h = heading(lane), start = lane.points[0];
  return Math.max(halfLength + .3, ...(topology.get(id)?.crosswalks ?? []).map(c =>
    dot([(c.points[0][0] + c.points[1][0]) / 2 - start[0], (c.points[0][1] + c.points[1][1]) / 2 - start[1]], h) + c.halfWidth + halfLength + .15));
}
// 消防站相邻短路段容不下整车排队，按停止线与清空区的重叠关系合并通行占用。
// 灯具和入口阶段仍属于各自路口；进入这类复合路口的车辆一次完成清空，避免尾部互锁。
const clearanceZones = new Map(intersections.map(i => [i.id, new Set([i.id])]));
lanes.filter(lane => topology.has(lane.from!) && topology.has(lane.to!) &&
  controlledLanes.get(lane)!.entry.stopLine - .84 < geometricExitClearance(lane, lane.from!, .84)).forEach(lane => {
  const merged = new Set([...clearanceZones.get(lane.from!)!, ...clearanceZones.get(lane.to!)!]);
  merged.forEach(id => clearanceZones.set(id, merged));
});

// 清空区内采用同一阶段表，防止两端行人阶段错开后持续占用整个短连接区。
const signalPrograms = [...new Set(clearanceZones.values())].map(zone => {
  const phases: { kind: 'vehicle' | 'pedestrian'; duration: number; heading: Point;
    crossings: typeof signalCrosswalks; groups: Map<string, number> }[] = [];
  zone.forEach(id => topology.get(id)!.groups.forEach((group, index) => {
    const intersection = topology.get(id)!;
    const h = intersection.entries.find(e => group.members.includes(e.id))?.heading ?? [0, 0] as Point;
    const crossings = intersection.crosswalks.filter(c => group.members.includes(c.id));
    const compatible = phases.find(phase => phase.kind === group.kind && !phase.groups.has(id) &&
      (group.kind === 'vehicle' ? Math.abs(dot(phase.heading, h)) > .999 :
        phase.crossings.every(a => crossings.every(b => !crossingPathsConflict(a.points, b.points)))));
    if (compatible) { compatible.groups.set(id, index); compatible.crossings.push(...crossings); return; }
    phases.push({ kind: group.kind, duration: group.duration, heading: h, crossings, groups: new Map([[id, index]]) });
  }));
  return { ids: [...zone], phases };
});

export class TrafficSignalController implements TrafficControlService {
  private mode: TrafficControlMode = 'normal';
  private listeners = new Set<() => void>();
  private authorized = new Set<string>();
  private runtime = new Map(intersections.map(i => [i.id, { group: 0, phase: 'all_red' as IntersectionSignalState['phase'] }]));
  private programs = signalPrograms.map(program => ({ ...program, index: 0, elapsed: 0, active: false, priority: undefined as number | undefined }));
  private programByIntersection = new Map(this.programs.flatMap(program => program.ids.map(id => [id, program] as const)));
  private priorityApproaches: readonly Piece[] = [];
  private occupants = new Map(intersections.map(i => [i.id, new Map<string, Occupant>()]));
  private states = new Map<string, IntersectionSignalState>();

  constructor() { this.publish(); }
  getMode() { return this.mode; }
  setMode(mode: TrafficControlMode) {
    if (!['normal', 'emergency_lockdown', 'emergency_priority'].includes(mode)) throw new Error('未知交通控制模式');
    if (mode === this.mode) return;
    const selective = mode === 'emergency_priority' || this.mode === 'emergency_priority' && mode === 'normal';
    this.mode = mode;
    this.priorityApproaches = [];
    this.programs.forEach(program => {
      if (selective && program.priority === undefined) return;
      program.index = 0; program.elapsed = 0; program.active = false; program.priority = undefined;
      program.ids.forEach(id => { this.runtime.get(id)!.phase = 'all_red'; });
    });
    this.publish();
  }
  setPriorityApproaches(approaches: readonly Piece[]) { this.priorityApproaches = approaches; }
  getIntersectionState(id: string) { return this.states.get(id); }
  getAllSignalStates() { return [...this.states.values()]; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setEmergencyAccess(id: string, authorized: boolean) { if (authorized) this.authorized.add(id); else this.authorized.delete(id); }
  hasEmergencyAccess(id: string) { return this.authorized.has(id); }
  getLaneControl(lane: Piece) { return controlledLanes.get(lane); }
  sharesClearanceZone(a: string, b: string) { return clearanceZones.get(a)?.has(b) ?? a === b; }
  stopDistance(lane: Piece, halfLength: number) { return Math.max(0, (controlledLanes.get(lane)?.entry.stopLine ?? lane.length) - halfLength); }
  exitClearance(lane: Piece, id: string, halfLength: number) {
    if (lane.to !== id && clearanceZones.get(id)?.has(lane.to!)) return Infinity;
    return geometricExitClearance(lane, id, halfLength);
  }
  occupy(id: string, actorId: string, kind: Occupant['kind'], crossing?: string) {
    (kind === 'vehicle' ? clearanceZones.get(id) ?? [id] : [id]).forEach(key => this.occupants.get(key)?.set(actorId, { kind, crossing }));
  }
  release(id: string, actorId: string) { (clearanceZones.get(id) ?? [id]).forEach(key => this.occupants.get(key)?.delete(actorId)); }
  isOccupied(id: string, except?: string) { return [...(this.occupants.get(id)?.keys() ?? [])].some(actor => actor !== except); }
  hasPedestrianInZone(id: string) {
    return [...(clearanceZones.get(id) ?? [id])].some(key =>
      [...(this.occupants.get(key)?.values() ?? [])].some(occupant => occupant.kind === 'pedestrian'));
  }
  isVehicleGreen(lane: Piece) {
    const control = controlledLanes.get(lane);
    return !control || this.states.get(control.intersection.id)!.vehicles[control.entry.id] === 'green';
  }
  returnPriorityPhase(lane: Piece): 'green' | 'preparing' | undefined {
    const control = controlledLanes.get(lane);
    if (this.mode !== 'normal' || !control) return;
    if (this.isVehicleGreen(lane)) return 'green';

    const { intersection, entry } = control;
    const { index, elapsed, active, phases } = this.programByIntersection.get(intersection.id)!;
    if (active && elapsed < phases[index].duration - config.timing.allRed) return;
    const next = phases[active ? (index + 1) % phases.length : index];
    const group = next.groups.get(intersection.id);
    if (group !== undefined && intersection.groups[group].members.includes(entry.id)) return 'preparing';
  }
  canEnterVehicle(lane: Piece, actorId: string, fire: boolean, ignoreSignal = false) {
    const control = controlledLanes.get(lane);
    if (!control) return true;
    const zone = [...clearanceZones.get(control.intersection.id)!];
    if (zone.some(id => this.isOccupied(id, actorId))) return false;
    if (this.occupants.get(control.intersection.id)!.get(actorId)?.kind === 'vehicle') return true;
    return ignoreSignal || (fire && this.authorized.has(actorId) && this.mode !== 'emergency_priority') ||
      (zone.every(id => this.states.get(id)!.phase !== 'pedestrian') && this.isVehicleGreen(lane));
  }
  canEnterPedestrian(crosswalkId: string) {
    const control = controlledCrossings.get(crosswalkId);
    if (!control) return false;
    if (this.states.get(control.intersection.id)!.pedestrians[crosswalkId] !== 'green') return false;
    return [...this.occupants.get(control.intersection.id)!.values()].every(occupant => occupant.kind === 'pedestrian' &&
      (occupant.crossing === crosswalkId || !crossingPathsConflict(control.crossing.points, controlledCrossings.get(occupant.crossing!)!.crossing.points)));
  }
  getCrosswalkControl(id: string) { return controlledCrossings.get(id); }
  advance(seconds: number) {
    if (this.mode === 'emergency_lockdown') return;
    let changed = false;
    this.programs.forEach(program => {
      const request = this.mode === 'emergency_priority' ? this.priorityApproaches.map(lane => controlledLanes.get(lane))
        .find(control => control && program.ids.includes(control.intersection.id)) : undefined;
      const requestedGroup = request?.intersection.groups.findIndex(group => group.members.includes(request.entry.id));
      const priority = request ? program.phases.findIndex(phase => phase.groups.get(request.intersection.id) === requestedGroup) : undefined;
      if (priority !== program.priority) {
        program.priority = priority; program.active = false; program.elapsed = 0;
        program.ids.forEach(id => { this.runtime.get(id)!.phase = 'all_red'; });
        changed = true;
      }
      program.elapsed += seconds;
      if (priority !== undefined && program.active) return;
      if (program.active && program.elapsed + 1e-8 < program.phases[program.index].duration) return;
      if (!program.active && (program.elapsed + 1e-8 < config.timing.allRed || program.ids.some(id => this.isOccupied(id)))) return;
      if (priority !== undefined) program.index = priority;
      if (priority === undefined && program.active) program.index = (program.index + 1) % program.phases.length;
      program.active = !program.active;
      program.elapsed = 0;
      program.ids.forEach(id => {
        const state = this.runtime.get(id)!, index = program.phases[program.index].groups.get(id);
        state.group = index ?? 0;
        state.phase = program.active && index !== undefined ? topology.get(id)!.groups[index].kind : 'all_red';
      });
      changed = true;
    });
    if (changed) this.publish();
  }
  private publish() {
    intersections.forEach(intersection => {
      const state = this.runtime.get(intersection.id)!;
      const group = state.phase === 'all_red' ? undefined : intersection.groups[state.group];
      this.states.set(intersection.id, Object.freeze({ intersectionId: intersection.id, phase: state.phase, groupId: group?.id ?? null,
        emergencyPriority: this.programs.some(program => program.priority !== undefined && program.ids.includes(intersection.id)),
        vehicles: Object.freeze(Object.fromEntries(intersection.entries.map(e => [e.id, group?.kind === 'vehicle' && group.members.includes(e.id) ? 'green' as const : 'red' as const]))),
        pedestrians: Object.freeze(Object.fromEntries(intersection.crosswalks.map(c => [c.id, group?.kind === 'pedestrian' && group.members.includes(c.id) ? 'green' as const : 'red' as const]))),
      }));
    });
    this.listeners.forEach(listener => listener());
  }
}

// 由 App 挂载当前实例；外部应急模块使用这个入口获取正在驱动车辆、行人和灯具的同一个服务。
let activeService: TrafficControlService | undefined;
export const getTrafficControlService = () => activeService;
export function connectTrafficControl(service: TrafficControlService) {
  activeService = service;
  return () => { if (activeService === service) activeService = undefined; };
}
export const signalCoverage = {
  intersections: intersections.length,
  original: intersections.filter(i => i.region === 'original').length,
  extension: intersections.filter(i => i.region === 'extension').length,
  station: intersections.filter(i => i.region === 'station').length,
  crosswalks: signalCrosswalks.length,
  boundaryJoins: [...new Set(lanes.flatMap(l => [l.from!, l.to!]))].filter(id => {
    const p = id.split(',').map(Number), e = original_map_placement.extent;
    return ((p[0] === e[0] || p[0] === e[2]) && p[1] > e[1] && p[1] < e[3]) ||
      ((p[1] === e[1] || p[1] === e[3]) && p[0] > e[0] && p[0] < e[2]);
  }),
  compoundZones: [...new Set(clearanceZones.values())].filter(zone => zone.size > 1).map(zone => [...zone]),
};
