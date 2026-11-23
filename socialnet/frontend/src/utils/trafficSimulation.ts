import { roads, traffic_routes } from '../../../city_scene/city_scene.json';
import { approaches, ARRIVAL_RADIUS, avenueLanes, distance, garage, originalLoop, pose,
  retreatPlans, routeTo, stationExit, stationJunction, streetLoop,
  type Approach, type Cursor, type Piece, type Point, type Pose, type RoadPlan } from './roadNetwork';

export type ResetMode = 'garage' | 'roads';
export type Severity = 1 | 2 | 3;
export type TruckStatus = 'idle' | 'en-route' | 'arrived' | 'unreachable' | 'returning' | 'return-waiting';
type Vehicle = {
  id: string; fire: boolean; cursor: Cursor; pose: Pose; speed: number;
  path: Piece[]; index: number; stop: number; status: TruckStatus; junction?: string;
  blockedFor: number; originalPath?: Piece[];
  bay?: Piece; reversing?: 'retreat' | 'parking' | 'yield'; yieldRoute?: Piece[];
};
type VehicleBody = Pick<Vehicle,'fire'|'pose'> & { lane?: Piece };
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

const trafficLoops=traffic_routes.map((route,i)=>{
  const lines=route.road_ids.map(id=>roads.find(r=>r.id===id)?.centerline.coordinates[0]);
  // The saved routes identify the city blocks; their coordinates used left-hand
  // offsets. Rebuild both directions from the actual road junctions instead.
  const corners:Point[]=lines.every(Boolean)
    ? [[lines[0]![0],lines[2]![1]],[lines[1]![0],lines[2]![1]],[lines[1]![0],lines[3]![1]],[lines[0]![0],lines[3]![1]]]
    : [...originalLoop];
  const clockwise=i<48?i%2===0:i<52;
  return {route,path:streetLoop(clockwise?corners.reverse():corners)};
});
const trafficLanes=new Set(trafficLoops.flatMap(loop=>loop.path));
export const carIds = traffic_routes.map(r=>r.id);
export const truckIds = garage.map((_,i)=>`EXT-FIRE-VEHICLE-0${i+1}`);

function cursorOn(path: Piece[], length: number) {
  for(let i=0;i<path.length;i++) {
    if(length<path[i].length)return {cursor:{piece:path[i],distance:length},index:i};
    length-=path[i].length;
  }
  return {cursor:{piece:path[0],distance:0},index:0};
}
function actor(id: string, fire: boolean, path: Piece[], speed: number, offset: number): Vehicle {
  const {cursor,index}=cursorOn(path,offset);
  return {id,fire,cursor,pose:pose(cursor),speed,path,index,stop:0,status:'idle',blockedFor:0};
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
    // The first lane may start partway through. A vehicle behind that cursor
    // can block backing up, but it cannot block the forward route.
    const next=bounds.get(p)!.find(d=>d>=offset);
    return next===undefined?p.length:next-.12;
  };
}

const stationary=(v:Vehicle)=>v.fire&&v.status!=='en-route'&&v.status!=='returning';
const reservesJunction = (vehicle: Vehicle, junction: string) => vehicle.junction === junction ||
  Boolean(vehicle.reversing && vehicle.path.some((p, i) => i >= vehicle.index && p.junction === junction));
const stationApproach: Cursor = {piece: stationExit, distance: 0};
const QUEUE_REPLAN_SECONDS = 3.5;
const REVERSE_SPEED = 1.2;
const DRIVEWAY_ENTRY = 1.05;

function occupiedJunction({piece, distance}: Cursor) {
  return garage.includes(piece) && distance <= DRIVEWAY_ENTRY ? undefined : piece.junction;
}
export class TrafficSimulation {
  readonly cars: Vehicle[]=[];
  trucks: Vehicle[]=[];
  private goal: Point|null=null;
  private severity: Severity=1;
  private priority=0;
  private garageOrder: Vehicle[]=[];
  constructor(private random=Math.random) {
    this.reset('garage');
    for(const {route,path} of trafficLoops) {
      const length=path.reduce((n,p)=>n+p.length,0), count=Math.ceil(length/.5);
      for(let i=0;i<count;i++) {
        const car=actor(route.id,false,path,route.speed,((route.phase+i/count)%1)*length);
        if(car.cursor.piece.road&&this.all.every(other=>!conflicts(car,other))) {this.cars.push(car); break;}
      }
    }
  }
  get all() {return [...this.cars,...this.trucks];}
  reset(mode: ResetMode) {
    this.trucks=[];
    const eligible=avenueLanes.filter(p=>p.length>2.1), length=eligible.reduce((n,p)=>n+p.length-1.9,0);
    for(let i=0;i<garage.length;i++) {
      const parked=actor(truckIds[i],true,[garage[i]],3.8,0);
      parked.bay=garage[i];
      if(mode==='garage') {this.trucks.push(parked); continue;}
      const initial=this.random()*length;
      for(let attempt=0;attempt<Math.ceil(length/.25);attempt++) {
        let s=(initial+attempt*.271)%length;
        const lane=eligible.find(p=>{if(s<p.length-1.9)return true; s-=p.length-1.9;return false;})!;
        const truck=actor(truckIds[i],true,[lane],3.8,.95+s);
        truck.bay=parked.bay;
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
  private dispatch() {
    const target=this.goal;
    if(!target) {
      this.garageOrder=[];
      for(const truck of this.trucks)this.sendHome(truck);
      return;
    }
    const ranked=this.trucks.map(truck=>({truck,routes:approaches(truck.cursor,target)}));
    ranked.sort((a,b)=>(a.truck.status==='arrived'?0:a.routes[0]?.cost??Infinity)-
      (b.truck.status==='arrived'?0:b.routes[0]?.cost??Infinity));
    const selected=ranked.slice(0,this.severity);
    this.garageOrder=selected.map(x=>x.truck);
    const occupied:VehicleBody[]=[...ranked.slice(this.severity).map(x=>x.truck),
      ...selected.filter(x=>x.truck.status==='arrived').map(x=>x.truck)].map(t=>({...t,lane:t.cursor.piece}));
    for(const {truck,routes} of selected) {
      if(truck.status==='arrived')continue;
      truck.reversing=undefined;
      truck.junction=occupiedJunction(truck.cursor);
      // Stage the first truck farther along its final lane. Following trucks
      // get separate stops behind it or on another approach within five metres.
      const candidates=occupied.length?approaches(truck.cursor,target,passable(occupied)):routes;
      if(this.assign(truck,candidates,occupied))occupied.push(this.staging(truck));
      else truck.status='unreachable';
    }
    for(const {truck} of ranked.slice(this.severity))this.sendHome(truck);
  }
  private sendHome(truck: Vehicle) {
    if (truck.status === 'returning' || truck.status === 'return-waiting') return;
    truck.junction = occupiedJunction(truck.cursor);
    this.planReturn(truck, this.all);
  }

  private setReturnPath(truck: Vehicle, plan: RoadPlan, reversing?: Vehicle['reversing']) {
    truck.path = plan.pieces;
    truck.index = 0;
    truck.stop = plan.stop;
    truck.status = 'returning';
    truck.reversing = reversing;
    truck.blockedFor = 0;
  }

  private planReturn(truck: Vehicle, vehicles: Vehicle[], skip?: Piece) {
    const bay = truck.bay!;
    const start = truck.cursor;
    if (start.piece === bay && start.distance === 0) {
      truck.status = 'idle';
      truck.junction = undefined;
      truck.reversing = undefined;
      return;
    }

    if (start.piece === bay || (start.piece === stationExit && start.distance < 1.5)) {
      const pieces = start.piece === bay ? [bay] : [stationExit, bay];
      if (this.beginReverse(truck, {pieces, stop: 0}, vehicles, 'parking')) return;
    } else {
      const stationaryTrucks = vehicles.filter(other => other !== truck && stationary(other));
      const limit = passable(stationaryTrucks);
      const usable = (p: Piece, s: number) => p === skip ? -1 : limit(p, s);
      const plan = routeTo(start, stationApproach, usable);
      if (plan) {
        this.setReturnPath(truck, plan);
        return;
      }

      // Forward exits are blocked. Reverse to an upstream turn only if the
      // whole backing path is clear and that turn leads to a route home.
      let hasReverseExit = false;
      for (const retreat of retreatPlans(start)) {
        const incoming = retreat.pieces.at(-1)!;
        const forward = routeTo({piece: incoming, distance: retreat.stop}, stationApproach, usable);
        if (!forward) continue;
        hasReverseExit = true;
        if (this.beginReverse(truck, retreat, vehicles, 'retreat')) return;
      }
      if (skip) {
        const original = routeTo(start, stationApproach, limit);
        if (original) {
          this.setReturnPath(truck, original);
          return;
        }
      }
      if (hasReverseExit) this.clearRearTraffic(truck, vehicles);
    }

    truck.status = 'return-waiting';
    truck.reversing = undefined;
    truck.blockedFor = 0;
  }

  private beginReverse(vehicle: Vehicle, plan: RoadPlan, vehicles: Vehicle[], reason: NonNullable<Vehicle['reversing']>) {
    const junctions = plan.pieces.flatMap(p => p.junction ? [p.junction] : []);
    const others = vehicles.filter(v => v !== vehicle);
    if (junctions.some(junction => others.some(v => reservesJunction(v, junction)))) return false;
    for (const [index, p] of plan.pieces.entries()) {
      const from = index === 0 ? vehicle.cursor.distance : p.length;
      const to = index === plan.pieces.length - 1 ? plan.stop : 0;
      const samples = Math.max(1, Math.ceil((from - to) / .12));
      for (let i = 0; i <= samples; i++) {
        const position = pose({piece: p, distance: from + (to - from) * i / samples});
        if (others.some(other => conflicts({fire: vehicle.fire, pose: position}, other))) return false;
      }
    }
    if (vehicle.fire) {
      this.setReturnPath(vehicle, plan, reason);
    } else {
      vehicle.path = plan.pieces;
      vehicle.index = 0;
      vehicle.stop = plan.stop;
      vehicle.reversing = reason;
    }
    vehicle.junction = junctions[0];
    return true;
  }

  private advanceReverse(vehicle: Vehicle, dt: number, vehicles: Vehicle[]) {
    let index = vehicle.index;
    let p = vehicle.cursor.piece;
    let d = vehicle.cursor.distance - REVERSE_SPEED * dt;
    while (d < 0 && index < vehicle.path.length - 1) {
      p = vehicle.path[++index];
      d += p.length;
    }
    const final = index === vehicle.path.length - 1;
    if (final) d = Math.max(vehicle.stop, d);
    const cursor = {piece: p, distance: d};
    const nextPose = pose(cursor);
    if (vehicles.some(v => v !== vehicle && conflicts({fire: vehicle.fire, pose: nextPose}, v))) return;
    vehicle.cursor = cursor;
    vehicle.pose = nextPose;
    vehicle.index = index;
    if (final && d === vehicle.stop) {
      vehicle.junction = undefined;
      vehicle.reversing = undefined;
      if (vehicle.fire) {
        this.planReturn(vehicle, vehicles);
      } else {
        vehicle.path = vehicle.yieldRoute!;
        vehicle.yieldRoute = undefined;
        vehicle.index = 0;
      }
    }
  }

  private clearRearTraffic(truck: Vehicle, vehicles: Vehicle[]) {
    const lane = truck.cursor.piece;
    if (!lane.road) return;
    const queue = vehicles.filter(v => v !== truck && v.cursor.piece === lane && v.cursor.distance < truck.cursor.distance);
    // Back out the last car first. Moving a car in the middle would just move
    // the queue into another collision. Active fire trucks stay where they are.
    const tail = queue.sort((a, b) => a.cursor.distance - b.cursor.distance)[0];
    if (!tail || tail.fire || tail.reversing || tail.speed <= 0) return;

    const loop = tail.originalPath ?? tail.path;
    for (const retreat of retreatPlans(tail.cursor)) {
      const incoming = retreat.pieces.at(-1)!;
      const detour = this.detourToLoop(incoming, lane, loop);
      if (!detour || !this.beginReverse(tail, retreat, vehicles, 'yield')) continue;
      tail.originalPath = loop;
      tail.yieldRoute = detour;
      return;
    }
  }
  private staging(truck:Vehicle):VehicleBody {
    const lane=truck.path.at(-1)!;
    return {fire:true,lane,pose:pose({piece:lane,distance:truck.stop})};
  }
  private assign(truck:Vehicle,routes:Approach[],occupied:VehicleBody[]) {
    const crowded=(route:Approach)=>{
      const lane=route.pieces.at(-1)!;
      return truck.cursor.piece!==lane&&trafficLanes.has(lane)&&occupied.filter(t=>t.lane===lane).length>=2;
    };
    // Leave room for an ordinary car that may already be on a staging lane.
    // Keep the same lane as a fallback when no other approach is reachable.
    for(const route of [...routes.filter(r=>!crowded(r)),...routes.filter(crowded)]) {
      const p=route.pieces.at(-1)!;
      const lower=Math.max(route.entry,p===truck.cursor.piece?truck.cursor.distance:Math.min(p.length,.85));
      const options=[...Array.from({length:Math.max(0,Math.floor((route.end-lower)/.12)+1)},(_,i)=>route.end-i*.12),lower];
      const stop=options.find(d=>d<=route.end+1e-6&&occupied.every(v=>!conflicts({fire:true,pose:pose({piece:p,distance:d})},v,.17)));
      if(stop===undefined)continue;
      truck.path=route.pieces;truck.index=0;truck.stop=stop;truck.blockedFor=0;
      truck.status=truck.cursor.piece===p&&Math.abs(truck.cursor.distance-stop)<1e-6?'arrived':'en-route';
      return true;
    }
    return false;
  }
  private bypassQueue(truck:Vehicle) {
    const incoming=truck.cursor.piece, next=truck.path[truck.index+1];
    if(!this.goal||!incoming.road||incoming.next.length<2||!next||
      incoming.length-truck.cursor.distance>1.35||distance(truck.pose.point,this.goal)>11)return;
    // A queue can form after dispatch. Replan only at a junction where there
    // is another legal exit; never pass a car by crossing the centre line.
    const occupied=this.trucks.filter(t=>t!==truck).map(t=>t.status==='en-route'?this.staging(t):{...t,lane:t.cursor.piece});
    const limit=passable(occupied);
    const alternatives=approaches(truck.cursor,this.goal,(p,s)=>p===next?0:limit(p,s));
    if(this.assign(truck,alternatives,occupied))truck.junction=undefined;
  }
  private next(vehicle:Vehicle,index:number) {
    if(vehicle.path[index+1]||vehicle.fire)return vehicle.path[index+1];
    const loop=vehicle.originalPath;
    return loop?loop[(loop.indexOf(vehicle.path[index])+1)%loop.length]:vehicle.path[0];
  }
  private orderStops(truck:Vehicle) {
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
  private detourToLoop(incoming: Piece, blocked: Piece, loop: Piece[], skip?: Piece) {
    const seen=new Set([incoming,blocked]);
    const queue=incoming.next.filter(p=>p!==skip).map(p=>[p]);
    for(let i=0;i<queue.length;i++) {
      const path=queue[i], end=path.at(-1)!;
      if(seen.has(end))continue;
      seen.add(end);
      if(end.road&&loop.includes(end)) {
        return [incoming,...path];
      }
      for(const next of end.next)if(!seen.has(next))queue.push([...path,next]);
    }
  }
  private divert(car:Vehicle, blocked:Piece, incoming:Piece) {
    const loop=car.originalPath??car.path;
    const detour=this.detourToLoop(incoming,blocked,loop,this.next(car,car.index));
    if (!detour) return false;
    car.originalPath=loop;car.path=detour;car.index=0;
    return true;
  }
  private advance(vehicle: Vehicle, step: number, others: Vehicle[]) {
    let {piece:p,distance:d}=vehicle.cursor;
    const inGarage=vehicle.fire&&garage.includes(p);
    if(inGarage&&this.garageOrder.find(t=>t.status==='en-route'&&garage.includes(t.cursor.piece))!==vehicle)return;
    let index=vehicle.index, junction=vehicle.junction;
    const final=vehicle.fire&&index===vehicle.path.length-1;
    const limit=final?vehicle.stop:p.length;
    const upcoming=this.next(vehicle,index);
    const approach=p.junction&&(!inGarage||d+step>DRIVEWAY_ENTRY)?p.junction:
      upcoming?.junction&&d+step+body(vehicle.fire)[0]+.29>=limit?upcoming.junction:undefined;
    if(approach&&approach!==junction) {
      if(others.some(v=>v!==vehicle&&reservesJunction(v,approach)))return;
      const turn=p.junction===approach?p:upcoming!;
      const exit=turn.next[0];
      // An active truck anywhere on an exit lane can trap a queue back into
      // this junction, even if the lane looks clear immediately at its start.
      const blockedExit = !vehicle.fire && p.road && exit && others.some(v=>stationary(v)&&
        (v.cursor.piece===exit || v.cursor.piece===turn));
      if (blockedExit && this.divert(vehicle, exit, p)) return;
      if(exit&&others.some(v=>v!==vehicle&&v.cursor.piece===exit&&v.cursor.distance<2.25))return;
      junction=approach;
    }
    d+=step;
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
    if(others.some(v=>v!==vehicle&&conflicts({fire:vehicle.fire,pose:nextPose},v)))return;
    if(!endOfReturn&&junction&&p.junction!==junction&&vehicle.cursor.piece.junction===junction)junction=undefined;
    if(vehicle.originalPath&&vehicle.index===vehicle.path.length-1&&upcoming===p&&vehicle.cursor.piece!==p) {
      vehicle.path=vehicle.originalPath;vehicle.originalPath=undefined;
    }
    vehicle.cursor=cursor;vehicle.pose=nextPose;vehicle.index=index;vehicle.junction=junction;
    if(vehicle.status === 'en-route') {
      this.orderStops(vehicle);
      if(index===vehicle.path.length-1&&d>=vehicle.stop-1e-6)vehicle.status='arrived';
    } else if (endOfReturn && d >= vehicle.stop) {
      this.planReturn(vehicle, others);
    }
  }
  tick(seconds: number) {
    const all=this.all;
    // Small steps keep even fast responders from skipping over a stopped car.
    while(seconds>1e-6) {
      const dt=Math.min(seconds,.022);
      for(let i=0;i<all.length;i++) {
        const v=all[(this.priority+i)%all.length];
        if (v.status === 'return-waiting') {
          v.blockedFor += dt;
          if (v.blockedFor >= 1) this.planReturn(v, all);
        } else if (v.reversing) {
          this.advanceReverse(v, dt, all);
        } else if(!v.fire||v.status==='en-route'||v.status==='returning') {
          const before=v.cursor;
          this.advance(v,v.speed*dt,all);
          if(v.status==='en-route') {
            v.blockedFor=before===v.cursor?v.blockedFor+dt:0;
            if(v.blockedFor>.8&&v.cursor.piece.road&&v.index===v.path.length-1&&this.goal&&distance(v.pose.point,this.goal)<=ARRIVAL_RADIUS) {
              v.status='arrived';v.junction=undefined;
            } else if(v.blockedFor>QUEUE_REPLAN_SECONDS) {
              v.blockedFor=0;this.bypassQueue(v);
            }
          } else if (v.status === 'returning' && !v.reversing) {
            v.blockedFor = before === v.cursor ? v.blockedFor + dt : 0;
            if (v.blockedFor >= QUEUE_REPLAN_SECONDS) {
              const {piece: lane, distance: offset} = v.cursor;
              const skip = lane.next.length > 1 && lane.length - offset <= 1.35 ? this.next(v, v.index) : undefined;
              this.planReturn(v, all, skip);
            }
          }
        }
      }
      this.priority=(this.priority+1)%all.length;
      seconds-=dt;
    }
  }
}
