import { edges, roads, fire_station_reserve as station, original_map_placement } from '../../../city_scene/city_scene.json';
import { edges as originalEdges, nodes as originalNodes } from '../../../fire_poi/fire_sandbox_spatial_model.json';

export type Point = [number, number];
export type Pose = { point: Point; angle: number };
export type Piece = {
  points: Point[]; cumulative: number[]; length: number; next: Piece[];
  road?: string; from?: string; to?: string; junction?: string;
};
export type Cursor = { piece: Piece; distance: number };
export const distance = (a: Point, b: Point) => Math.hypot(a[0]-b[0], a[1]-b[1]);
const add = (a: Point, b: Point, scale = 1): Point => [a[0]+b[0]*scale, a[1]+b[1]*scale];
const unit = (a: Point, b: Point): Point => [(b[0]-a[0])/distance(a,b),(b[1]-a[1])/distance(a,b)];
const dot = (a: Point, b: Point) => a[0]*b[0]+a[1]*b[1];
const key = (p: Point) => p.map(n=>n.toFixed(6)).join(',');
const CITY_OFFSET = original_map_placement.offset as Point;
export const originalLoop = ['J03','J04','J02','J01'].map(id=>add(originalNodes.find(n=>n.id===id)!.center as Point,CITY_OFFSET));
export function piece(points: Point[], info: Partial<Piece> = {}): Piece {
  const unique = points.filter((p,i)=>i===0||distance(p,points[i-1])>1e-6);
  const cumulative = [0];
  unique.slice(1).forEach((p,i)=>cumulative.push(cumulative[i]+distance(unique[i],p)));
  return { points: unique, cumulative, length: cumulative.at(-1)!, next: [], ...info };
}
export function pose({piece:p,distance:s}: Cursor): Pose {
  const i = p.cumulative.findIndex((end,i)=>i>0&&end>s+1e-7);
  const j=i<0?p.points.length-1:i, a=p.points[j-1], b=p.points[j];
  const heading=unit(a,b);
  return {point:add(a,heading,Math.max(0,Math.min(s,p.length)-p.cumulative[j-1])), angle:Math.atan2(heading[1],heading[0])};
}
function bend(a: Point, control: Point, b: Point): Point[] {
  return Array.from({length:17},(_,i)=>{
    const t=i/16, u=1-t;
    return [u*u*a[0]+2*u*t*control[0]+t*t*b[0],u*u*a[1]+2*u*t*control[1]+t*t*b[1]];
  });
}

// The original and extension share their eight boundary coordinates. Joining by position
// joins those roads without inserting any shortcuts through plots or pedestrian paths.
const arterial = new Set(['R-01','R-02','R-03','R-04']);
const extension = new Map(roads.map(r=>[r.id,r]));
const access = station.access.road_connection as Point;
type Axis = { a: Point; b: Point; road: string; twoWay: boolean; halfWidth: number; offset: number };
const axes: Axis[] = [...edges.filter(e=>e.vehicle_allowed).flatMap(e=>{
  const [a,b]=e.geometry.coordinates as Point[], halfWidth=extension.get(e.road_id)!.width/2;
  const split=e.road_id===station.access.road_id&&a[0]<access[0]&&access[0]<b[0];
  return (split?[[a,access],[access,b]]:[[a,b]]).map(([a,b])=>({a,b,road:e.road_id,twoWay:e.bidirectional,halfWidth,offset:halfWidth/2}));
}), ...originalEdges.filter(e=>e.vehicle_allowed&&e.road_id!=='R-07').map(e=>{
  const [a,b]=e.geometry.coordinates.map(p=>add(p as Point,CITY_OFFSET));
  const offset=arterial.has(e.road_id)?.8:.35;
  return {a,b,road:e.road_id,twoWay:e.bidirectional,halfWidth:offset*2,offset};
})];
const touching = new Map<string, Axis[]>();
for(const edge of axes) for(const p of [edge.a,edge.b]) {
  const id=key(p); if(!touching.has(id))touching.set(id,[]); touching.get(id)!.push(edge);
}
const outgoing = new Map<string, Piece[]>();
const laneHeading = new Map<Piece, Point>();
function lane(a: Point, b: Point, edge: Axis): Piece {
  const h=unit(a,b), right:Point=[h[1],-h[0]];
  const trim=(p: Point)=>Math.min(distance(a,b)*.43,Math.max(0,...touching.get(key(p))!
    .filter(e=>Math.abs(dot(unit(e.a,e.b),h))<.1).map(e=>e.halfWidth+.07),key(p)===key(access)?1.8:0));
  const lo=add(add(a,h,trim(a)),right,edge.offset), hi=add(add(b,h,-trim(b)),right,edge.offset);
  const result=piece([lo,hi],{road:edge.road,from:key(a),to:key(b)});
  if(!outgoing.has(result.from!))outgoing.set(result.from!,[]);
  outgoing.get(result.from!)!.push(result); laneHeading.set(result,h);
  return result;
}
export const lanes = axes.flatMap(e=>[lane(e.a,e.b,e),...(e.twoWay?[lane(e.b,e.a,e)]:[])]);
for(const from of lanes) for(const to of outgoing.get(from.to!)??[]) {
  const a=from.points.at(-1)!, b=to.points[0], h=laneHeading.get(from)!, k=laneHeading.get(to)!;
  const turn=dot(h,k);
  if(turn<-.9)continue; // no mid-road U turns, including at parking resets
  if(distance(a,b)<1e-6) { from.next.push(to); continue; }
  // The turn is tangent to both lane centre lines and lies within their junction.
  const control=add(a,h,dot([b[0]-a[0],b[1]-a[1]],h));
  const connector=piece(turn>.9?[a,b]:bend(a,control,b),{junction:from.to});
  connector.next.push(to); from.next.push(connector);
}
export const avenueLanes = lanes.filter(l=>arterial.has(l.road!)||roads.slice(0,12).some(r=>r.id===l.road));

export const stationExit = outgoing.get(key(access))!.find(p=>laneHeading.get(p)![0]>0)!;
export const stationJunction = key(access);
export const garage = station.parking_spaces.map((bay)=>{
  const start=bay.center as Point, entry=station.access.entrance as Point;
  const side=Math.sign(start[0]-entry[0]), apronY=entry[1]+.12;
  // Clear the nose of a truck parked in the middle bay before joining the driveway.
  const merge: Point = [entry[0], entry[1] + .55];
  const lineEnd: Point=[entry[0],entry[1]+.65], join=stationExit.points[0];
  const apron:Point[]=side===0?[]:[
    ...bend([start[0],apronY-.32],[start[0],apronY],[start[0]-side*.44,apronY]),
    ...bend([entry[0]+side*.55,apronY],[entry[0],apronY],merge),
  ];
  const path=piece([start,...apron,side===0?entry:merge,lineEnd,...bend(lineEnd,[entry[0],join[1]],join).slice(1)],{junction:key(access)});
  path.next.push(stationExit);
  return path;
});

const preceding = new Map<Piece, Piece[]>();
for (const lane of lanes) {
  for (const next of lane.next) {
    preceding.set(next, [...(preceding.get(next) ?? []), lane]);
    if (next.junction) {
      const exit = next.next[0];
      preceding.set(exit, [...(preceding.get(exit) ?? []), next]);
    }
  }
}

export type RoadPlan = { pieces: Piece[]; stop: number };
type RoadLimit = (piece: Piece, offset: number) => number;

// Retrace actual lane connectors in reverse. End far enough inside an incoming
// lane to take another forward turn without changing heading in place.
export function retreatPlans(start: Cursor): RoadPlan[] {
  const plans: RoadPlan[] = [];
  const queue = [[start.piece]];
  for (const pieces of queue) {
    const current = pieces.at(-1)!;
    for (const previous of preceding.get(current) ?? []) {
      if (pieces.includes(previous)) continue;
      const path = [...pieces, previous];
      if (current.junction && previous.next.length > 1 && previous.length >= 2) {
        plans.push({pieces: path, stop: previous.length - 1.8});
      } else {
        queue.push(path);
      }
    }
  }
  return plans;
}

// Follow one straight road between two junctions (including any intermediate
// graph nodes), choosing the connector into the next road at each corner.
export function streetLoop(corners: Point[]): Piece[] {
  const result: Piece[]=[];
  for(let i=0;i<corners.length;i++) {
    const a=corners[i], b=corners[(i+1)%corners.length], h=unit(a,b), end=key(b);
    const matching=(l: Piece)=>dot(laneHeading.get(l)!,h)>.999;
    let current=outgoing.get(key(a))?.find(matching);
    if(!current)throw new Error(`No vehicle lane from ${a} toward ${b}`);
    while(true) {
      result.push(current);
      if(current.to===end)break;
      const step:Piece|undefined=current.next.find(n=>matching(n.road?n:n.next[0]));
      if(!step)throw new Error(`No lane continuing from ${current.to} toward ${b}`);
      if(!step.road)result.push(step);
      current=step.road?step:step.next[0];
    }
    const k=unit(b,corners[(i+2)%corners.length]);
    const turn=current.next.find(n=>!n.road&&dot(laneHeading.get(n.next[0])!,k)>.999);
    if(turn)result.push(turn);
  }
  return result;
}

export const ARRIVAL_RADIUS = 5;
export type Approach = { pieces: Piece[]; entry: number; end: number; cost: number };
function* reachablePieces(start: Cursor, limit: RoadLimit) {
  const visited = new Set<Piece>();
  const queue=[{pieces:[start.piece], cost:0, offset:start.distance}];
  while(queue.length) {
    queue.sort((a,b)=>b.cost-a.cost);
    const {pieces,cost,offset}=queue.pop()!, last=pieces.at(-1)!;
    if(visited.has(last))continue;
    // A later loop can reach the beginning of the initial lane from upstream.
    if (offset === 0) visited.add(last);
    const reachable=limit(last,offset);
    yield {pieces,cost,offset,last,reachable};
    if(reachable<last.length)continue;
    for(const next of last.next) if(!visited.has(next))queue.push({pieces:[...pieces,next],cost:cost+last.length-offset,offset:0});
  }
}

export function routeTo(start: Cursor, goal: Cursor, limit: RoadLimit): RoadPlan | undefined {
  for (const {pieces, last, offset, reachable} of reachablePieces(start, limit)) {
    if (last === goal.piece && offset <= goal.distance && reachable >= goal.distance) {
      return {pieces, stop: goal.distance};
    }
  }
}

export function approaches(start: Cursor, goal: Point, limit: RoadLimit=p=>p.length): Approach[] {
  const found: Approach[]=[];
  for (const {pieces,cost,offset,last,reachable} of reachablePieces(start, limit)) {
    if(last.road) {
      const a=last.points[0], h=laneHeading.get(last)!;
      const delta:Point=[goal[0]-a[0],goal[1]-a[1]], along=dot(delta,h);
      const half=Math.sqrt((ARRIVAL_RADIUS-.06)**2-Math.max(0,dot(delta,delta)-along*along));
      const entry=Math.max(offset,along-half), end=Math.min(last.length-.98,along+half,reachable);
      if(entry<=end)found.push({pieces,entry,end,cost:cost+entry-offset});
      else if(offset>last.length-.98&&distance(pose({piece:last,distance:offset}).point,goal)<=ARRIVAL_RADIUS) {
        found.push({pieces,entry:offset,end:offset,cost});
      }
    }
  }
  return found.sort((a,b)=>a.cost-b.cost);
}
