import { roads, traffic_routes } from '../../../../city_scene/city_scene.json';
import type { CityPosition, FireSceneSeverity, FireTruckDispatch, FireTruckRoute, VehicleSceneSnapshot } from '../types';
import config from '../config/trafficControl.json';
import emergencyConfig from '../config/emergency.json';
import { TrafficSignalController } from './trafficSignalController';
import { PedestrianSimulation } from './pedestrianSimulation';
import { approaches, ARRIVAL_RADIUS, avenueLanes, distance, garage, originalLoop, pose,
  followsOnSameLane, garageEntries, inTankZone, isFireStationOnly, isGarageAccess, isParkingDeparture, isParkingEntry, isRightTurn, mockParkingPieces, oppositeLane, roadPieces, routeTo, routeToLane, streetLoop,
  type Approach, type Cursor, type Piece, type Point, type Pose, type RoadPlan } from './roadNetwork';

export type ResetMode = 'garage' | 'roads';
export type Severity = FireSceneSeverity;
export type TruckStatus = 'idle' | 'en-route' | 'arrived' | 'unreachable' | 'returning' | 'return-waiting';
type FleetHome = { home: Cursor; returnTo: Cursor; departureHold?: number };
const historicalHomes: FleetHome[] = garage.map((bay, index) => ({ home: { piece: bay, distance: 0 },
  returnTo: { piece: garageEntries[index], distance: garageEntries[index].length } }));
type Vehicle = {
  id: string; fire: boolean; cursor: Cursor; pose: Pose; speed: number;
  path: Piece[]; index: number; stop: number; status: TruckStatus; junction?: string;
  originalPath?: Piece[]; homePath?: Piece[]; waitingForSignal?: boolean;
  home?: FleetHome;
  external?: { target: Point; water: boolean };
  telemetry?: { updatedAt: number; ceiling: number };
  returnRetry?: number;
  fixedReturnRoute?: boolean;
  recallFrom?: Piece;
  reverseShift?: number;
  queueWait?: number;
};
type VehicleBody = Pick<Vehicle,'fire'|'pose'> & { lane?: Piece };
type ReturnApproach = { lane: Piece; junction: string };
type ReturnPriority = ReturnApproach & { vehicle: Vehicle; phase: 'green' | 'preparing' };
type ReturnExit = ReturnApproach & { truck: Vehicle; exit: Piece };
type ReturnReservations = { priorities: ReturnPriority[]; exits: ReturnExit[] };
const body = (fire: boolean) => fire ? [.84,.30] : [.65,.26]; // half length and half width, in metres
const GAP = .10;

export function conflicts(a: VehicleBody, b: VehicleBody, gap=GAP): boolean {
  const x=b.pose.point[0]-a.pose.point[0], y=b.pose.point[1]-a.pose.point[1];
  if(Math.abs(x)>1.9||Math.abs(y)>1.9)return false;
  const axes=(p: Pose):[Point,Point]=>[[Math.cos(p.angle),Math.sin(p.angle)],[-Math.sin(p.angle),Math.cos(p.angle)]];
  const aa=axes(a.pose), bb=axes(b.pose), u=body(a.fire), v=body(b.fire);
  const dot=(m:Point,n:Point)=>m[0]*n[0]+m[1]*n[1];
  return [...aa,...bb].every(axis=>Math.abs(axis[0]*x+axis[1]*y)<
    u[0]*Math.abs(dot(aa[0],axis))+u[1]*Math.abs(dot(aa[1],axis))+
    v[0]*Math.abs(dot(bb[0],axis))+v[1]*Math.abs(dot(bb[1],axis))+gap);
}

const localRoutes = traffic_routes.filter(r => !r.road_ids.every(id => roads.some(road => road.id === id)));
const outerRoutes = traffic_routes.filter(r => !localRoutes.includes(r));
const configuredRoutes = [
  // Keep one car per outer block, alternating direction between adjacent blocks.
  ...outerRoutes.filter((_, index) => index % 4 === 0 || index % 4 === 3),
  ...localRoutes.slice(0, config.vehicles.originalCars).filter((_, index) => index % 2 === 0),
];
const trafficLoops=configuredRoutes.map(route=>{
  const i = traffic_routes.indexOf(route);
  const lines=route.road_ids.map(id=>roads.find(r=>r.id===id)?.centerline.coordinates[0]);
  // The saved routes identify the city blocks; their coordinates used left-hand
  // offsets. Rebuild both directions from the actual road junctions instead.
  const corners:Point[]=lines.every(Boolean)
    ? [[lines[0]![0],lines[2]![1]],[lines[1]![0],lines[2]![1]],[lines[1]![0],lines[3]![1]],[lines[0]![0],lines[3]![1]]]
    : [...originalLoop];
  const clockwise=i<48?i%2===0:i<52;
  if (clockwise) corners.reverse();
  const path = streetLoop(corners);
  return {route,path:path.some(isFireStationOnly) ? streetLoop(corners.reverse()) : path};
});
const outsideLoops = trafficLoops.map(loop => loop.path).filter(path => path.every(lane => !inTankZone(lane)));
const FIRE_TRUCK_SPEED = 3.8;
const PARKING_SPEED = 1.2;
const REVERSE_SHIFT_SECONDS = .45;
const QUEUE_DETOUR_SECONDS = 3;
const RETURN_RETRY_SECONDS = 3;
const RETURN_PRIORITY_DISTANCE = 2.5;
const RETURN_EXIT_GREEN_WINDOWS = 2;
export const carIds = configuredRoutes.map(r=>r.id);
export const truckIds = emergencyConfig.trucks.map(truck => truck.id);

function cursorOn(path: Piece[], length: number) {
  for(let i=0;i<path.length;i++) {
    if(length<path[i].length)return {cursor:{piece:path[i],distance:length},index:i};
    length-=path[i].length;
  }
  return {cursor:{piece:path[0],distance:0},index:0};
}
function actor(id: string, fire: boolean, path: Piece[], speed: number, offset: number): Vehicle {
  const {cursor,index}=cursorOn(path,offset);
  return {id,fire,cursor,pose:pose(cursor),speed,path,index,stop:0,status:'idle'};
}

// Check parked truck footprints against a lane or turn, including the swing of a
// turning truck. Cache the samples for each dispatch pass.
function passable(stopped: VehicleBody[]) {
  const bounds=new Map<Piece,number[]>();
  return (p:Piece,offset:number)=>{
    if(!bounds.has(p)) {
      const nearby=stopped.filter(t=>p.points.some(q=>distance(q,t.pose.point)<p.length+2));
      const blocked:number[]=[];
      if(nearby.length)for(let d=0;d<p.length+.12;d+=.12) {
        const s=Math.min(d,p.length), q=pose({piece:p,distance:s});
        if(nearby.some(t=>conflicts({fire:true,pose:q},t)))blocked.push(s);
      }
      bounds.set(p,blocked);
    }
    // The first lane may start partway through; ignore vehicles behind the cursor.
    const next=bounds.get(p)!.find(d=>d>=offset);
    return next===undefined?p.length:next-.12;
  };
}

const DRIVEWAY_ENTRY = 1.05;

function occupiedJunction({piece, distance}: Cursor) {
  return isParkingDeparture(piece) && distance <= DRIVEWAY_ENTRY ? undefined : piece.junction;
}
export class TrafficSimulation {
  readonly cars: Vehicle[]=[];
  trucks: Vehicle[]=[];
  private goal: Point|null=null;
  private severity: Severity=1;
  private simulatedFleet: ReadonlySet<string> | null = null;
  private simulatedWater = new Set<string>();
  tankZoneClosed = false;
  private priority=0;
  private garageOrder: Vehicle[]=[];
  readonly pedestrians: PedestrianSimulation;
  private listeners = new Set<(seconds: number) => void>();
  private updates = new Set<(seconds: number) => void>();
  private vehicleOccupancies = new Map<string, string>();
  private returnQueue = new Map<Vehicle, ReturnApproach & { greenWindows: number; green: boolean }>();
  constructor(private random=Math.random, readonly signals = new TrafficSignalController(), pedestriansEnabled = config.pedestriansEnabled, readonly truckHomes: readonly FleetHome[] = historicalHomes) {
    this.pedestrians = new PedestrianSimulation(signals, pedestriansEnabled);
    if (config.vehicles.emergencyFleetAuthorized) truckIds.forEach(id => signals.setEmergencyAccess(id, true));
    this.reset('garage');
    for(const {route,path} of trafficLoops) {
      const length=path.reduce((n,p)=>n+p.length,0), count=Math.ceil(length/.5);
      for(let i=0;i<count;i++) {
        const car=actor(route.id,false,path,route.speed,((route.phase+i/count)%1)*length);
        if(car.cursor.piece.road && car.cursor.distance <= signals.stopDistance(car.cursor.piece, body(false)[0]) &&
          car.cursor.distance >= signals.exitClearance(car.cursor.piece, car.cursor.piece.from!, body(false)[0]) &&
          this.all.every(other=>!conflicts(car,other))) {this.cars.push(car); break;}
      }
    }
  }
  subscribe(listener: (seconds: number) => void, phase: 'update' | 'draw' = 'draw') {
    const subscribers = phase === 'update' ? this.updates : this.listeners;
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  }
  get all() {return [...this.cars,...this.trucks];}
  get sceneSnapshot(): readonly VehicleSceneSnapshot[] {
    return this.trucks.map(vehicle => {
      const waterTarget = this.waterTarget(vehicle);
      const working = waterTarget && (vehicle.external || this.simulatedFleet);
      return { id: vehicle.id, kind: 'fireTruck',
        position: { x: vehicle.pose.point[0], y: vehicle.pose.point[1] },
        heading: vehicle.pose.angle, status: working ? 'extinguishing' : vehicle.status, waterTarget };
    });
  }
  waterTarget(vehicle: Vehicle): CityPosition | undefined {
    if (vehicle.status !== 'arrived') return;
    const target = vehicle.external
      ? (vehicle.external.water ? vehicle.external.target : null)
      : (!this.simulatedFleet || this.simulatedWater.has(vehicle.id) ? this.goal : null);
    if (target) return { x: target[0], y: target[1] };
  }
  validateExternalRoute(vehicleId: string, route: FireTruckRoute, target?: CityPosition) {
    const truck = this.trucks.find(t => t.id === vehicleId);
    const pieces = route.pieceIds.map(id => roadPieces.get(id) ?? (truck?.home?.departureHold ? mockParkingPieces.get(id) : undefined));
    if (!truck || !pieces.length || pieces.some(p => !p) || pieces[0] !== truck.cursor.piece ||
      pieces.some((p, i) => i > 0 && !pieces[i - 1]!.next.includes(p!)) ||
      !Number.isFinite(route.stop) || route.stop < 0 || route.stop > pieces.at(-1)!.length ||
      (pieces.length === 1 && route.stop < truck.cursor.distance)) throw new Error('消防车路径必须从当前位置沿现有有向车道连续连接');
    if (target && distance(pose({ piece: pieces.at(-1)!, distance: route.stop }).point, [target.x, target.y]) > ARRIVAL_RADIUS)
      throw new Error('消防车路径终点未抵达方案指定的火场范围');
    return pieces as Piece[];
  }
  applyExternalDispatch(dispatch: FireTruckDispatch, route: FireTruckRoute) {
    const pieces = this.validateExternalRoute(dispatch.vehicleId, route, dispatch.targetPosition);
    const truck = this.trucks.find(t => t.id === dispatch.vehicleId)!;
    truck.path = pieces; truck.index = 0; truck.stop = route.stop;
    truck.status = pieces.length === 1 && Math.abs(truck.cursor.distance - route.stop) < 1e-6 ? 'arrived' : 'en-route';
    truck.external = { target: [dispatch.targetPosition.x, dispatch.targetPosition.y], water: false };
    truck.telemetry = undefined;
    this.garageOrder = [...this.garageOrder.filter(t => t !== truck && t.external), truck];
  }
  updateExternalPosition(id: string, position: CityPosition, updatedAt: number) {
    const truck = this.trucks.find(t => t.id === id);
    if (!truck || (!truck.external && truck.status !== 'returning')) throw new Error('消防车尚未接收已确认的调度路径');
    if (updatedAt <= (truck.telemetry?.updatedAt ?? -1)) return;
    // Telemetry limits progress on the approved route; movement still uses collision and signal checks.
    const samples = truck.path.flatMap((p, index) => p.points.slice(1).flatMap((b, i) => {
      const a = p.points[i], dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((position.x - a[0]) * dx + (position.y - a[1]) * dy) / (dx * dx + dy * dy)));
      const offset = p.cumulative[i] + Math.hypot(dx, dy) * t;
      return index < truck.index || (index === truck.index && offset < truck.cursor.distance - .05) ? [] :
        [{ index, offset, error: Math.hypot(a[0] + dx * t - position.x, a[1] + dy * t - position.y) }];
    })).sort((a, b) => a.error - b.error);
    if (!samples.length || samples[0].error > .08) throw new Error('消防车位置更新偏离已批准路径或早于当前进度');
    truck.telemetry = { updatedAt, ceiling: truck.path.slice(0, samples[0].index).reduce((sum, p) => sum + p.length, 0) + samples[0].offset };
  }
  setExternalWater(id: string, active: boolean) {
    const truck = this.trucks.find(t => t.id === id);
    if (this.simulatedFleet?.has(id) && truck && !truck.external) {
      if (active && truck.status !== 'arrived') throw new Error('消防车尚未抵达批准的停车点');
      if (active) this.simulatedWater.add(id);
      else this.simulatedWater.delete(id);
      return;
    }
    if (!truck?.external || (active && truck.status !== 'arrived')) throw new Error('消防车尚未抵达批准的停车点');
    truck.external.water = active;
  }
  returnExternalTruck(id: string, route?: FireTruckRoute) {
    const truck = this.trucks.find(t => t.id === id);
    if (!truck) throw new Error('未知消防车');
    if (route) {
      const pieces = this.validateExternalRoute(id, route);
      truck.external = undefined;
      this.setReturnPath(truck, { pieces, stop: route.stop }, true);
      return;
    }
    truck.external = undefined;
    this.sendHome(truck);
  }
  reset(mode: ResetMode) {
    this.trucks.forEach(t => { if (t.junction) this.signals.release(t.junction, t.id); });
    this.returnQueue.clear();
    this.trucks=[];
    const eligible=avenueLanes.filter(p=>p.length>2.1), length=eligible.reduce((n,p)=>n+p.length-1.9,0);
    for(let i=0;i<this.truckHomes.length;i++) {
      const home = this.truckHomes[i];
      const parked=actor(truckIds[i],true,[home.home.piece],FIRE_TRUCK_SPEED,home.home.distance);
      parked.home=home;
      if(mode==='garage') {this.trucks.push(parked); continue;}
      const initial=this.random()*length;
      for(let attempt=0;attempt<Math.ceil(length/.25);attempt++) {
        let s=(initial+attempt*.271)%length;
        const lane=eligible.find(p=>{if(s<p.length-1.9)return true; s-=p.length-1.9;return false;})!;
        const truck=actor(truckIds[i],true,[lane],FIRE_TRUCK_SPEED,.95+s);
        truck.home=home;
        if(this.all.every(other=>!conflicts(truck,other))) {this.trucks.push(truck);break;}
      }
    }
    this.dispatch();
  }
  setIncident(goal: Point|null,severity: Severity) {
    const changed=goal?.[0]!==this.goal?.[0]||goal?.[1]!==this.goal?.[1];
    if(!changed&&severity===this.severity)return;
    this.goal=goal;this.severity=severity;
    if(changed) for(const truck of this.trucks)if(truck.status==='arrived')truck.status='idle';
    this.dispatch();
  }
  closestTruckIds(target: Point, count: number) {
    return this.chooseResponders(this.rankTrucks(target).map(({ truck }) => truck), count).map(truck => truck.id);
  }
  applySimulatedFleet(goal: Point | null, ids: readonly string[] = []) {
    this.simulatedFleet = goal ? new Set(ids) : null;
    this.simulatedWater = new Set([...this.simulatedWater].filter(id => this.simulatedFleet?.has(id)));
    this.goal = goal;
    this.dispatch();
  }
  private rankTrucks(target: Point) {
    return this.trucks.map(truck => ({ truck, routes: approaches(truck.cursor, target) }))
      .sort((a, b) => (a.truck.status === 'arrived' ? 0 : a.routes[0]?.cost ?? Infinity) -
        (b.truck.status === 'arrived' ? 0 : b.routes[0]?.cost ?? Infinity));
  }
  private chooseResponders(ranked: Vehicle[], count: number) {
    const first = ranked.slice(0, count);
    if (count >= ranked.length || ranked.filter(truck => truck.status === 'arrived').length <= count) return first;
    const ready = ranked.filter(truck => truck.status === 'arrived');
    const candidates = ready.reduce<Vehicle[][]>((sets, truck) => [...sets, ...sets.filter(set => set.length < count).map(set => [...set, truck])], [[]])
      .filter(set => set.length === count);
    // Prefer nearby responders whose arrival positions let the others leave.
    let best = first;
    let mostAbleToLeave = -1;
    for (const selected of candidates) {
      const parked = selected.filter(truck => truck.status === 'arrived');
      const canLeave = ranked.filter(truck => !selected.includes(truck) &&
        (truck.cursor.piece === truck.home!.home.piece && truck.cursor.distance === truck.home!.home.distance || !!this.returnPlan(truck, parked))).length;
      if (canLeave > mostAbleToLeave) {
        mostAbleToLeave = canLeave;
        best = selected;
      }
      if (canLeave === ranked.length - count) break;
    }
    return best;
  }
  private dispatch() {
    const target=this.goal;
    this.trucks.forEach(truck => { truck.recallFrom = undefined; });
    if(!target) {
      this.garageOrder=[];
      for(const truck of this.trucks)this.sendHome(truck);
      return;
    }
    const ranked=this.rankTrucks(target);
    const selectedIds = this.simulatedFleet ?? new Set(this.chooseResponders(ranked.map(({ truck }) => truck), this.severity).map(truck => truck.id));
    const selected=ranked.filter(({truck})=>selectedIds.has(truck.id));
    const unselected=ranked.filter(entry=>!selected.includes(entry));
    for (const { truck } of unselected) {
      if (truck.status === 'arrived') truck.status = 'return-waiting';
    }
    this.garageOrder=selected.map(x=>x.truck);
    const occupied:VehicleBody[]=selected.filter(x=>x.truck.status==='arrived').map(({truck})=>({...truck,lane:truck.cursor.piece}));
    for(const {truck,routes} of selected) {
      if(truck.status==='arrived'||(truck.status==='returning'&&isGarageAccess(truck.cursor.piece)))continue;
      truck.junction ??= occupiedJunction(truck.cursor);
      // Each responder needs a distinct stopping point within five metres.
      const candidates=occupied.length ? approaches(truck.cursor,target,passable(occupied)) : routes;
      if(this.assign(truck,candidates,occupied))occupied.push(this.staging(truck));
      // Continue along the forward return path until another legal approach opens.
      else if (truck.status === 'returning' || truck.status === 'return-waiting') truck.recallFrom = truck.cursor.piece;
      else truck.status='unreachable';
    }
    for(const {truck} of unselected)this.sendHome(truck);
  }
  private sendHome(truck: Vehicle) {
    if (truck.status !== 'returning') this.planReturn(truck);
  }

  private setReturnPath(truck: Vehicle, plan: RoadPlan, fixed = false) {
    truck.telemetry = undefined;
    truck.path = plan.pieces;
    truck.index = 0;
    truck.stop = plan.stop;
    truck.status = 'returning';
    truck.returnRetry = 0;
    truck.fixedReturnRoute = fixed;
  }

  private park(truck: Vehicle) {
    if (truck.junction) this.signals.release(truck.junction, truck.id);
    truck.cursor = { ...truck.home!.home };
    truck.path = [truck.cursor.piece];
    truck.index = 0;
    truck.stop = truck.cursor.distance;
    truck.status = 'idle';
    truck.junction = undefined;
    truck.waitingForSignal = false;
    truck.telemetry = undefined;
    truck.returnRetry = 0;
    truck.fixedReturnRoute = false;
  }

  private returnPlan(truck: Vehicle, parked: readonly Vehicle[]) {
    return routeTo(truck.cursor, truck.home!.returnTo, parked.length ? passable([...parked]) : undefined);
  }

  private planReturn(truck: Vehicle) {
    const home = truck.home!.home;
    if (truck.cursor.piece === home.piece && truck.cursor.distance === home.distance) {
      this.park(truck);
      return;
    }
    const plan = this.returnPlan(truck, this.trucks.filter(other => other !== truck && other.status === 'arrived'));
    if (plan) this.setReturnPath(truck, plan);
    else { truck.status = 'return-waiting'; truck.returnRetry = 0; }
  }
  private staging(truck:Vehicle):VehicleBody {
    const lane=truck.path.at(-1)!;
    return {fire:true,lane,pose:pose({piece:lane,distance:truck.stop})};
  }
  private assign(truck:Vehicle,routes:Approach[],occupied:VehicleBody[]) {
    let best: { route: Approach; stop: number; cost: number } | undefined;
    for(const route of routes) {
      if (best && route.cost >= best.cost) break;
      const p=route.pieces.at(-1)!;
      // 停车点须清空入口斑马线与路口，避免已抵达车辆堵住后续消防车及普通车。
      const lower=Math.max(route.entry,p===truck.cursor.piece?truck.cursor.distance:Math.min(p.length,.85),
        p.from ? this.signals.exitClearance(p,p.from,body(true)[0]) : 0);
      if (lower > route.end + 1e-6) continue;
      const options=[...Array.from({length:Math.max(0,Math.floor((route.end-lower)/.12)+1)},(_,i)=>lower+i*.12),route.end];
      const stop=options.find(d=>d<=route.end+1e-6&&occupied.every(v=>!conflicts({fire:true,pose:pose({piece:p,distance:d})},v,.17)));
      if(stop===undefined)continue;
      const cost = route.cost + stop - route.entry;
      if (!best || cost < best.cost) best = { route, stop, cost };
    }
    if (!best) return false;
    truck.path = best.route.pieces;
    truck.index = 0;
    truck.stop = best.stop;
    truck.status = truck.cursor.piece === truck.path.at(-1) && Math.abs(truck.cursor.distance - truck.stop) < 1e-6 ? 'arrived' : 'en-route';
    return true;
  }

  private retryRecall(truck: Vehicle) {
    if (!truck.recallFrom || !this.goal || !truck.cursor.piece.road || truck.cursor.piece === truck.recallFrom) return;
    truck.recallFrom = truck.cursor.piece;
    const occupied = this.trucks.flatMap(other => {
      if (other === truck) return [];
      if (other.status === 'en-route') return [this.staging(other)];
      if (other.status === 'arrived') return [other];
      return [];
    });
    if (this.assign(truck, approaches(truck.cursor, this.goal, passable(occupied)), occupied)) truck.recallFrom = undefined;
  }

  private next(vehicle:Vehicle,index:number) {
    if(vehicle.path[index+1]||vehicle.fire)return vehicle.path[index+1];
    const loop=vehicle.originalPath;
    return loop?loop[(loop.indexOf(vehicle.path[index])+1)%loop.length]:vehicle.path[0];
  }
  private orderStops(truck:Vehicle) {
    if (truck.external) return;
    const lane=truck.cursor.piece;
    if(truck.index!==truck.path.length-1||!lane.road)return;
    for(const other of this.trucks) {
      if(other===truck||other.status!=='en-route'||other.path.at(-1)!==lane||other.stop<=truck.stop)continue;
      if(other.cursor.piece===lane&&other.cursor.distance>=truck.cursor.distance)continue;
      // Traffic can change the arrival order. The front truck must take the
      // front spot, even when another truck originally had the shorter route.
      [truck.stop,other.stop]=[other.stop,truck.stop];
    }
  }
  setTankZoneClosed(closed: boolean) {
    if (closed === this.tankZoneClosed) return;
    this.tankZoneClosed = closed;
    for (const car of this.cars) {
      if (closed && (inTankZone(car.cursor.piece) || car.path.some(inTankZone))) {
        car.homePath = car.originalPath ?? car.path;
        const plan = this.carDetour(car.cursor, outsideLoops);
        if (plan) this.applyCarDetour(car, plan);
      } else if (!closed && car.homePath) {
        const plan = this.carDetour(car.cursor, [car.homePath]);
        if (plan) this.applyCarDetour(car, plan);
        car.homePath = undefined;
      }
    }
    this.listeners.forEach(listener => listener(0));
  }

  private carDetour(start: Cursor, loops: Piece[][], avoid: readonly Piece[] = [], skip?: Piece) {
    const pieces = routeToLane(start, lane => !!lane.road && (!skip || lane !== start.piece) && !avoid.includes(lane) &&
      loops.some(loop => loop.includes(lane)), (from, to) => !avoid.includes(to) && !isGarageAccess(to) && !isFireStationOnly(to) &&
      !(from === start.piece && to === skip) &&
      (!this.tankZoneClosed || inTankZone(from) || !inTankZone(to)));
    if (pieces) return { pieces, loop: loops.find(loop => loop.includes(pieces.at(-1)!))! };
  }

  private applyCarDetour(car: Vehicle, { pieces, loop }: { pieces: Piece[]; loop: Piece[] }) {
    const end = pieces.at(-1)!;
    car.originalPath = pieces.length === 1 ? undefined : loop;
    car.path = pieces.length === 1 ? loop : pieces;
    car.index = pieces.length === 1 ? loop.indexOf(end) : 0;
  }

  private divertAtJunction(car: Vehicle, upcoming: Piece, blocked: Piece[]) {
    const loop = car.originalPath ?? car.path;
    const preferred = this.tankZoneClosed && loop.some(inTankZone) ? outsideLoops : [loop];
    const route = this.carDetour(car.cursor, preferred, blocked, upcoming) ?? this.carDetour(car.cursor, outsideLoops, blocked, upcoming);
    if (route && route.pieces.length > 1) {
      this.applyCarDetour(car, route);
      return true;
    }
    return false;
  }

  private tryUTurn(car: Vehicle, parked: readonly Piece[]) {
    const incoming = car.cursor.piece, opposite = oppositeLane(incoming);
    if (!opposite || isFireStationOnly(opposite) || (this.tankZoneClosed && !inTankZone(incoming) && inTankZone(opposite))) return false;
    const start = car.pose.point;
    const first = opposite.points[0], last = opposite.points.at(-1)!;
    const offset = ((start[0] - first[0]) * (last[0] - first[0]) + (start[1] - first[1]) * (last[1] - first[1])) / opposite.length;
    const halfLength = body(false)[0];
    if (offset < halfLength || offset > opposite.length - halfLength) return false;
    const cursor = { piece: opposite, distance: offset };
    const end = pose(cursor);
    for (let i = 1; i <= 16; i++) {
      const t = i / 16;
      const candidate: VehicleBody = { fire: false, pose: {
        point: [start[0] + (end.point[0] - start[0]) * t, start[1] + (end.point[1] - start[1]) * t],
        angle: car.pose.angle + Math.PI * t,
      } };
      if (this.all.some(other => other !== car && conflicts(candidate, other, 0))) return false;
    }
    const loop = car.originalPath ?? car.path;
    const preferred = this.tankZoneClosed && loop.some(inTankZone) ? outsideLoops : [loop];
    const route = this.carDetour(cursor, preferred, parked) ?? this.carDetour(cursor, outsideLoops, parked);
    if (!route) return false;
    if (car.junction) this.signals.release(car.junction, car.id);
    car.junction = undefined;
    car.cursor = cursor;
    car.pose = end;
    this.applyCarDetour(car, route);
    return true;
  }

  private prepareCar(car: Vehicle) {
    const lane = car.cursor.piece;
    const next = this.next(car, car.index);
    const parked = this.trucks.filter(truck => truck.status === 'arrived');
    const blocked = parked.map(truck => truck.cursor.piece);
    const closedExit = this.tankZoneClosed && !inTankZone(lane) && next && inTankZone(next);
    const blockedExit = next && (blocked.includes(next) || next.next.some(exit => blocked.includes(exit)));
    if (lane.road && !car.junction && next && (closedExit || blockedExit)) {
      if (this.divertAtJunction(car, next, blocked)) return false;
      if (closedExit) return false;
    }
    const fireAhead = parked.some(truck => truck.cursor.piece === lane &&
      truck.cursor.distance > car.cursor.distance && truck.cursor.distance - car.cursor.distance < 1.65);
    if (fireAhead) return this.tryUTurn(car, blocked);
    return true;
  }

  private queuedAtFork(vehicle: Vehicle) {
    const { piece: lane, distance: offset } = vehicle.cursor;
    return lane.road && !vehicle.junction && lane.next.length > 1 &&
      offset >= this.signals.stopDistance(lane, body(vehicle.fire)[0]) - .15;
  }

  private relieveCarQueue(car: Vehicle, dt: number, moved: boolean) {
    if (moved || !this.queuedAtFork(car)) { car.queueWait = 0; return; }
    if (!this.signals.isVehicleGreen(car.cursor.piece)) return;
    car.queueWait = (car.queueWait ?? 0) + dt;
    if (car.queueWait < QUEUE_DETOUR_SECONDS) return;
    car.queueWait = 0;
    const next = this.next(car, car.index);
    if (!next) return;
    const blocked = this.all.filter(vehicle => vehicle !== car &&
      (vehicle.status === 'arrived' || vehicle.cursor.distance < 2.25)).map(vehicle => vehicle.cursor.piece);
    this.divertAtJunction(car, next, blocked);
  }
  private junctionExit(vehicle: Vehicle, junction: string) {
    const lane = vehicle.cursor.piece;
    let exitIndex = vehicle.index + (lane.junction ? 0 : 1);
    let exit = lane.junction ? lane : this.next(vehicle, vehicle.index);
    // Find the first lane outside the entire clearance zone, including short links.
    for (let remaining = vehicle.path.length + 1; exit && remaining > 0; remaining--) {
      if (!exit.junction && !(exit.to && this.signals.sharesClearanceZone(junction, exit.to))) break;
      exit = this.next(vehicle, exitIndex % vehicle.path.length);
      exitIndex++;
    }
    return exit;
  }

  private exitBlocked(vehicle: Vehicle, exit: Piece | undefined, junction: string, others: Vehicle[]) {
    if (!exit) return false;
    const halfLength = body(vehicle.fire)[0];
    return others.some(other => other !== vehicle && other.cursor.piece === exit &&
      other.cursor.distance < this.signals.exitClearance(exit, exit.from ?? junction, halfLength) +
        halfLength + body(other.fire)[0] + GAP);
  }

  private reserveReturnGreen(others: Vehicle[]) {
    const reservations: ReturnReservations = { priorities: [], exits: [] };
    if (this.signals.getMode() !== 'normal') {
      this.returnQueue.clear();
      return reservations;
    }
    for (const truck of this.trucks) {
      const { piece: lane, distance } = truck.cursor;
      const control = truck.status === 'returning' && !truck.telemetry && this.signals.getLaneControl(lane);
      if (!control) { this.returnQueue.delete(truck); continue; }
      const junction = control.intersection.id;
      const stopLine = this.signals.stopDistance(lane, body(true)[0]);
      const waiting = distance <= stopLine + 1e-6 && distance >= stopLine - RETURN_PRIORITY_DISTANCE &&
        (!truck.junction || !this.signals.sharesClearanceZone(truck.junction, junction)) &&
        (truck.index < truck.path.length - 1 || truck.stop > stopLine);
      const queued = this.returnQueue.get(truck);
      if (!waiting || queued?.lane !== lane) this.returnQueue.delete(truck);
      if (waiting && queued?.lane !== lane) this.returnQueue.set(truck, { lane, junction, greenWindows: 0, green: false });
    }

    const { priorities, exits } = reservations;
    const reserve = (request: ReturnPriority) => {
      const index = priorities.findIndex(other => this.signals.sharesClearanceZone(request.junction, other.junction));
      if (index === -1) { priorities.push(request); return; }
      const current = priorities[index];
      if ((request.phase === 'green' && current.phase === 'preparing') || (request.lane === current.lane &&
          request.vehicle.cursor.distance > current.vehicle.cursor.distance)) priorities[index] = request;
    };
    for (const [truck, approach] of this.returnQueue) {
      const { lane, junction } = approach;
      const phase = this.signals.returnPriorityPhase(lane);
      const green = phase === 'green';
      if (green && !approach.green) approach.greenWindows++;
      approach.green = green;
      const exit = this.junctionExit(truck, junction);
      // Once two greens have been offered, reserve the outlet only in the truck's own window.
      const holdExit = exit?.road && (phase || approach.greenWindows < RETURN_EXIT_GREEN_WINDOWS);
      if (exit && holdExit) exits.push({ truck, lane, junction, exit });
      if (!phase && !holdExit) continue;

      if (!this.exitBlocked(truck, exit, junction, others)) {
        if (phase) reserve({ vehicle: truck, lane, junction, phase });
        continue;
      }
      // A full outlet has to drain through its next signal before the truck can enter.
      if (exit && holdExit) {
        const control = this.signals.getLaneControl(exit);
        const outletPhase = this.signals.returnPriorityPhase(exit);
        if (!control || !outletPhase || this.signals.sharesClearanceZone(junction, control.intersection.id)) continue;
        let head: Vehicle | undefined;
        for (const vehicle of others) {
          if (vehicle.cursor.piece === exit && (!head || vehicle.cursor.distance > head.cursor.distance)) head = vehicle;
        }
        if (!head || head.fire || head.speed <= 0) continue;
        const stop = this.signals.stopDistance(exit, body(false)[0]);
        const downstream = control.intersection.id;
        if (head.cursor.distance >= stop - RETURN_PRIORITY_DISTANCE && head.cursor.distance <= stop + 1e-6 &&
            !this.exitBlocked(head, this.junctionExit(head, downstream), downstream, others)) {
          reserve({ vehicle: head, lane: exit, junction: downstream, phase: outletPhase });
        }
      }
    }
    return reservations;
  }

  private mustYieldAtEntry(vehicle: Vehicle, junction: string, priorities: ReturnPriority[]) {
    return priorities.some(({ vehicle: first, lane, junction: reserved }) => first !== vehicle &&
      this.signals.sharesClearanceZone(reserved, junction) &&
      // A vehicle already ahead on the same lane has to clear it first.
      (vehicle.cursor.piece !== lane || vehicle.cursor.distance <= first.cursor.distance));
  }

  private advance(vehicle: Vehicle, step: number, others: Vehicle[], ignoreSignal: boolean, reservations: ReturnReservations) {
    if (vehicle.telemetry) {
      const progress = vehicle.path.slice(0, vehicle.index).reduce((sum, p) => sum + p.length, 0) + vehicle.cursor.distance;
      step = Math.min(step, Math.max(0, vehicle.telemetry.ceiling - progress));
      if (step <= 1e-8) return;
    }
    let {piece:p,distance:d}=vehicle.cursor;
    const inGarage=vehicle.fire&&isParkingDeparture(p);
    if (inGarage && vehicle.status === 'en-route' && this.garageOrder.find(truck => truck.status === 'en-route' && isParkingDeparture(truck.cursor.piece)) !== vehicle) {
      // Separate stalls may advance within their straight section. The shared aisle admits one departure at a time.
      step = Math.min(step, (vehicle.home!.departureHold ?? 0) - d);
      if (step <= 0) return;
    }
    let index=vehicle.index, junction=vehicle.junction;
    const final=vehicle.fire&&index===vehicle.path.length-1;
    const limit=final?vehicle.stop:p.length;
    const upcoming=this.next(vehicle,index);
    vehicle.waitingForSignal = false;
    const control = this.signals.getLaneControl(p);
    const clearing = control && junction && this.signals.sharesClearanceZone(junction, control.intersection.id);
    if (control && !clearing && (!final || vehicle.stop > this.signals.stopDistance(p, body(vehicle.fire)[0]))) {
      const stop = this.signals.stopDistance(p, body(vehicle.fire)[0]);
      if (d + step > stop) {
        // 进入停止线后保留通行承诺；切红时已经进入的对象继续清空，不在路中冻结。
        const bypassSignal = ignoreSignal || (this.signals.getMode() !== 'emergency_lockdown' && isRightTurn(p, upcoming));
        const allowed = vehicle.fire ? bypassSignal || this.signals.isVehicleGreen(p, upcoming) :
          this.signals.canEnterVehicle(p, vehicle.id, false, bypassSignal, upcoming);
        const atEntry = d <= stop + 1e-6;
        const waitForSignal = atEntry && !allowed;
        const yieldToReturn = atEntry && allowed && !ignoreSignal && this.mustYieldAtEntry(vehicle, control.intersection.id, reservations.priorities);
        if (waitForSignal || yieldToReturn) {
          step = Math.max(0, stop - d);
          vehicle.waitingForSignal = waitForSignal && !bypassSignal;
          if (step <= 1e-8) return yieldToReturn ? 'yield' : undefined;
        } else {
          if (vehicle.fire && this.signals.hasPedestrianInZone(control.intersection.id)) return;
          const exit = this.junctionExit(vehicle, control.intersection.id);
          const departingStation = inGarage && ignoreSignal;
          if (others.some(v => {
            if (v === vehicle || !v.junction || !this.signals.sharesClearanceZone(v.junction, control.intersection.id)) return false;
            if (!departingStation || v.fire) return true;
            const lane = v.cursor.piece;
            // The opposite lane starts beyond the driveway merge and leads away from it.
            if (lane !== upcoming && lane.road && lane.road === upcoming?.road && lane.from === control.intersection.id) return false;
            const { from, to } = (lane.road ? lane : lane.next[0]) ?? lane;
            // An ordinary car already leaving the shared zone via a different physical
            // junction no longer crosses this departure. Keep protecting shared links and turns on this route.
            return !exit?.from || !from || !to || from === exit.from ||
              !this.signals.sharesClearanceZone(control.intersection.id, from) || this.signals.sharesClearanceZone(control.intersection.id, to);
          })) return;
          // Keep the receiving lane open between green phases while its remaining traffic drains.
          if (atEntry && !vehicle.fire && !ignoreSignal && exit && reservations.exits.some(request => request.exit === exit &&
            this.signals.sharesClearanceZone(request.junction, control.intersection.id) &&
            (p !== request.lane || d <= request.truck.cursor.distance))) return;
          // 先确认下游容得下整辆车，再进入路口，保留原有避碰和让行机制。
          if (this.exitBlocked(vehicle, exit, control.intersection.id, others)) return;
          junction = control.intersection.id;
        }
      }
    }
    const approach=p.junction&&(!inGarage||(!control&&d+step>DRIVEWAY_ENTRY))?p.junction:
      upcoming?.junction&&d+step+body(vehicle.fire)[0]+.29>=limit?upcoming.junction:undefined;
    if(approach&&(!junction||!this.signals.sharesClearanceZone(junction,approach))&&!control) {
      if (!ignoreSignal && this.mustYieldAtEntry(vehicle, approach, reservations.priorities)) return 'yield';
      if (!vehicle.fire && this.signals.isOccupied(approach, vehicle.id)) return;
      if(others.some(v=>v!==vehicle&&v.junction&&this.signals.sharesClearanceZone(v.junction,approach)))return;
      const turn=p.junction===approach?p:upcoming!;
      const exit=turn.next[0];
      if(exit&&others.some(v=>v!==vehicle&&v.cursor.piece===exit&&v.cursor.distance<2.25))return;
      junction=approach;
    }
    const shiftToReverse = vehicle.fire && d < limit && d + step >= limit && upcoming && isParkingEntry(upcoming);
    d = shiftToReverse ? limit : d + step;
    if(d>limit) {
      if(final)d=limit;
      else if(upcoming) {
        d-=limit;p=upcoming;
        if(index===vehicle.path.length-1&&vehicle.originalPath) {
          index=vehicle.originalPath.indexOf(upcoming);
        } else index=(index+1)%vehicle.path.length;
      }
      else return;
    }
    const endOfReturn = vehicle.status === 'returning' && index === vehicle.path.length - 1;
    if (endOfReturn) d = Math.min(d, vehicle.stop);
    const cursor={piece:p,distance:d}, nextPose=pose(cursor);
    if (vehicle.fire && isParkingEntry(p)) nextPose.angle += Math.PI;
    if(others.some(v=>v!==vehicle&&conflicts({fire:vehicle.fire,pose:nextPose},v)))return;
    if (junction && p.road && p.from && this.signals.sharesClearanceZone(junction, p.from)) {
      if (d >= this.signals.exitClearance(p, p.from, body(vehicle.fire)[0]) || (endOfReturn && d >= vehicle.stop)) {
        this.signals.release(junction, vehicle.id); junction = undefined;
      }
    }
    if(vehicle.originalPath&&vehicle.index===vehicle.path.length-1&&upcoming===p&&vehicle.cursor.piece!==p) {
      vehicle.path=vehicle.originalPath;vehicle.originalPath=undefined;
    }
    vehicle.cursor=cursor;vehicle.pose=nextPose;vehicle.index=index;vehicle.junction=junction;
    if (shiftToReverse) vehicle.reverseShift = REVERSE_SHIFT_SECONDS;
    if (junction) this.signals.occupy(junction, vehicle.id, 'vehicle');
    if(vehicle.status === 'en-route') {
      this.orderStops(vehicle);
      if(index===vehicle.path.length-1&&d>=vehicle.stop-1e-6)vehicle.status='arrived';
    } else if (endOfReturn && d >= vehicle.stop) {
      if (p === vehicle.home!.returnTo.piece && Math.abs(d - vehicle.home!.returnTo.distance) < 1e-6) {
        this.park(vehicle);
        if (this.goal && (this.simulatedFleet?.has(vehicle.id) ?? true)) this.dispatch();
      }
      else this.planReturn(vehicle);
    }
  }
  tick(seconds: number) {
    const elapsed = seconds;
    const all=this.all;
    // Small steps keep even fast responders from skipping over a stopped car.
    while(seconds>1e-6) {
      const dt=Math.min(seconds,.022);
      this.signals.advance(dt);
      this.pedestrians.tick(dt);
      const returnReservations = this.reserveReturnGreen(all);
      const respondersOnRoad = this.trucks.some(truck => truck.status === 'en-route' || truck.status === 'returning' || truck.status === 'arrived');
      for (let i = 0; i < all.length; i++) {
        const vehicle = all[(this.priority + i) % all.length];
        if (vehicle.fire) {
          if (vehicle.reverseShift && vehicle.reverseShift > 0) {
            vehicle.reverseShift = Math.max(0, vehicle.reverseShift - dt);
            continue;
          }
          const before = vehicle.cursor;
          if (vehicle.status === 'en-route' || vehicle.status === 'returning') {
            const speed = isGarageAccess(vehicle.cursor.piece) ? PARKING_SPEED : vehicle.speed;
            this.advance(vehicle, speed * dt, all, vehicle.status === 'en-route', returnReservations);
          }
          if (vehicle.status === 'returning' && before.piece !== vehicle.cursor.piece) this.retryRecall(vehicle);
          if (vehicle.status === 'return-waiting' || (vehicle.status === 'returning' && !vehicle.fixedReturnRoute &&
            !vehicle.telemetry && !vehicle.waitingForSignal && before === vehicle.cursor)) {
            vehicle.returnRetry = (vehicle.returnRetry ?? 0) + dt;
            if (vehicle.returnRetry >= RETURN_RETRY_SECONDS) this.planReturn(vehicle);
          } else vehicle.returnRetry = 0;
          continue;
        }
        const before = vehicle.cursor;
        let yielded = false;
        if (this.prepareCar(vehicle)) {
          const yielding = this.trucks.some(truck => truck.status === 'en-route' && followsOnSameLane(vehicle.cursor, truck.cursor));
          const evacuating = this.tankZoneClosed && inTankZone(vehicle.cursor.piece);
          yielded = this.advance(vehicle, (yielding || evacuating ? FIRE_TRUCK_SPEED : vehicle.speed) * dt, all, yielding, returnReservations) === 'yield';
        }
        if (respondersOnRoad) this.relieveCarQueue(vehicle, dt, yielded || before !== vehicle.cursor);
      }
      all.forEach(vehicle => {
        const previous = this.vehicleOccupancies.get(vehicle.id);
        if (previous && previous !== vehicle.junction) this.signals.release(previous, vehicle.id);
        if (vehicle.junction) {
          this.signals.occupy(vehicle.junction, vehicle.id, 'vehicle');
          this.vehicleOccupancies.set(vehicle.id, vehicle.junction);
        } else this.vehicleOccupancies.delete(vehicle.id);
      });
      this.priority=(this.priority+1)%all.length;
      seconds-=dt;
    }
    // Advance shared actor state before any display subscriber reads this frame.
    this.updates.forEach(listener => listener(elapsed));
    this.listeners.forEach(listener => listener(elapsed));
  }
}
