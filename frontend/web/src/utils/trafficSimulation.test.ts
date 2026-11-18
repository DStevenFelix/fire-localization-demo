import { expect, test } from 'vitest';
import { fire_station_reserve } from '../../../../city_scene/city_scene.json';
import { pois } from '../../../../fire_poi/fire_sandbox_spatial_model.json';
import { approaches, avenueLanes, distance, garage, pose, roadPieces, stationExit, type Point } from './roadNetwork';
import { conflicts, TrafficSimulation } from './trafficSimulation';

const tanks=pois.filter(p=>p.id.startsWith('T-')).map(p=>({id:p.id,point:[p.center[0]+30,p.center[1]+25] as Point}));
const sw=tanks.find(p=>p.id==='T-SW-01')!.point;
const westFireLane=avenueLanes.find(p=>p.road==='R-03' && p.points[0][1]>30 && p.points[0][1]<32 && p.points[1][1]>36)!;
const advance=(sim:TrafficSimulation, until:()=>boolean, seconds=100)=>{
  for(let i=0;i<seconds*20&&!until();i++)sim.tick(.05);
};

test('parks in all three marked stalls and returns deselected trucks to their own stalls',()=>{
  const sim=new TrafficSimulation();
  expect(sim.trucks.map(t=>t.pose.point)).toEqual(fire_station_reserve.parking_spaces.map(b=>b.center));
  expect(sim.cars).toHaveLength(53);
  sim.setIncident(sw,3);
  expect(sim.trucks.map(t=>t.status)).toEqual(['en-route','en-route','en-route']);
  sim.tick(.7);
  const nearest=[...sim.trucks].sort((a,b)=>approaches(a.cursor,sw)[0].cost-approaches(b.cursor,sw)[0].cost)[0];
  sim.setIncident(sw,1);
  expect(sim.trucks.filter(t=>t.status==='en-route')).toEqual([nearest]);
  const returning=sim.trucks.filter(t=>t!==nearest);
  advance(sim,()=>nearest.status==='arrived'&&returning.every(t=>t.status==='idle'));
  expect(nearest.status).toBe('arrived');
  expect(distance(nearest.pose.point,sw)).toBeLessThanOrEqual(5);
  for(const truck of returning)expect(truck.pose.point).toEqual(garage[sim.trucks.indexOf(truck)].points[0]);
  sim.setIncident(sw,2);
  expect(sim.trucks.filter(t=>t.status==='en-route')).toHaveLength(1);
  expect(sim.trucks.filter(t=>t.status==='idle')).toHaveLength(1);
});

test('backs out to an upstream turn when an active truck blocks the way home, waiting if reversing is unsafe',()=>{
  const sim = new TrafficSimulation();
  const lane = westFireLane;
  const [front, rear] = sim.trucks;
  const [traffic] = sim.cars.splice(0);
  sim.setIncident(sw, 2);
  for (const [vehicle, offset] of [[front, 4.8], [rear, 2.55], [traffic, .35]] as const) {
    vehicle.cursor = {piece: lane, distance: offset};
    vehicle.pose = pose(vehicle.cursor);
    vehicle.path = [lane];
    vehicle.index = 0;
    vehicle.junction = undefined;
  }
  front.status = rear.status = 'arrived';
  traffic.speed = 0;
  sim.cars.push(traffic);
  sim.setIncident(sw, 1);
  const frontPose = front.pose;
  const rearStart = rear.cursor;
  expect(rear.status).toBe('return-waiting');
  sim.tick(1.2);
  expect(rear.cursor).toEqual(rearStart);

  sim.cars.pop();
  advance(sim,()=>rear.reversing==='retreat',3);
  expect(rear.reversing).toBe('retreat');
  sim.tick(.4);
  expect(rear.cursor.distance).toBeLessThan(rearStart.distance);
  expect(rear.pose.angle).toBeCloseTo(frontPose.angle);
  advance(sim,()=>rear.status==='idle');
  expect(rear.pose.point).toEqual(garage[1].points[0]);
  expect(front.pose).toEqual(frontPose);
  expect(front.status).toBe('arrived');
});

test('a canceled truck drives forward when only the space behind it is blocked',()=>{
  const sim = new TrafficSimulation();
  sim.cars.splice(0);
  sim.setIncident(sw, 2);
  const [active, returning] = sim.trucks;
  // Positions captured from the traffic run matching the screenshot.
  for (const [truck, offset] of [[active, 1.499], [returning, 3.285]] as const) {
    truck.cursor = {piece: westFireLane, distance: offset};
    truck.pose = pose(truck.cursor);
    truck.status = 'arrived';
    truck.junction = undefined;
  }
  const activePose = active.pose;
  sim.setIncident(sw, 1);
  sim.tick(.2);
  expect(returning.cursor.piece).toBe(westFireLane);
  expect(returning.cursor.distance).toBeGreaterThan(3.285);
  expect(returning.reversing).toBeUndefined();
  advance(sim,()=>returning.status==='idle');
  expect(returning.pose.point).toEqual(garage[1].points[0]);
  expect(active.pose).toEqual(activePose);
});

test('a queued ordinary car can give way from the rear when the upstream turn is clear',()=>{
  const sim = new TrafficSimulation();
  const lane = westFireLane;
  const traffic = sim.cars.find(car => car.path.includes(lane))!;
  sim.cars.splice(0, sim.cars.length, traffic);
  sim.setIncident(sw, 2);
  const [front, returning] = sim.trucks;
  for (const [vehicle, offset] of [[front, 4.8], [returning, 2.9], [traffic, 1.28]] as const) {
    vehicle.cursor = {piece: lane, distance: offset};
    vehicle.pose = pose(vehicle.cursor);
    vehicle.junction = undefined;
  }
  traffic.index = traffic.path.indexOf(lane);
  front.status = returning.status = 'arrived';
  const frontPose = front.pose;
  sim.setIncident(sw, 1);
  expect(returning.status).toBe('return-waiting');
  expect(traffic.reversing).toBe('yield');
  advance(sim,()=>returning.reversing==='retreat',25);
  expect(returning.reversing).toBe('retreat');
  advance(sim,()=>returning.status==='idle');
  expect(returning.pose.point).toEqual(garage[1].points[0]);
  expect(front.pose).toEqual(frontPose);
});

test.each([0, 2])('side bay %i can be entered with the middle bay occupied', bay=>{
  const sim = new TrafficSimulation();
  sim.cars.splice(0);
  sim.setIncident(sw, 3);
  const truck = sim.trucks[bay];
  truck.cursor = {piece: stationExit, distance: 0};
  truck.pose = pose(truck.cursor);
  sim.setIncident(null, 3);
  advance(sim,()=>truck.status==='idle',12);
  expect(truck.pose.point).toEqual(garage[bay].points[0]);
  expect(sim.trucks[1].pose.point).toEqual(garage[1].points[0]);
});

test.each(tanks)('three trucks can reach $id on directed roads without overlapping other traffic',({point})=>{
  const sim=new TrafficSimulation();
  sim.setIncident(point,3);
  advance(sim,()=>sim.trucks.every(t=>t.status==='arrived'),80);
  expect(sim.trucks.map(t=>t.status)).toEqual(['arrived','arrived','arrived']);
  for(const truck of sim.trucks)expect(distance(truck.pose.point,point)).toBeLessThanOrEqual(5);
  const vehicles=sim.all;
  expect(vehicles.every((v,i)=>vehicles.slice(i+1).every(o=>!conflicts(v,o,0)))).toBe(true);
});

test('road reset uses clear, forward-only avenue positions and redispatches during a fire',()=>{
  const sim=new TrafficSimulation(()=>.59);
  sim.setIncident(sw,2);
  sim.tick(.8);
  sim.reset('roads');
  expect(sim.trucks).toHaveLength(3);
  expect(sim.trucks.every(t=>avenueLanes.includes(t.cursor.piece))).toBe(true);
  expect(sim.trucks.filter(t=>t.status==='en-route')).toHaveLength(2);
  expect(sim.trucks.every(t=>sim.all.every(o=>t===o||!conflicts(t,o)))).toBe(true);
  advance(sim,()=>sim.trucks.filter(t=>t.status==='arrived').length===2,110);
  expect(sim.trucks.filter(t=>t.status==='arrived')).toHaveLength(2);
});

test('all unassigned trucks return to their own bays after a road reset with no incident',()=>{
  const sim = new TrafficSimulation(()=>.59);
  sim.cars.splice(0);
  sim.reset('roads');
  expect(sim.trucks.every(truck=>avenueLanes.includes(truck.cursor.piece))).toBe(true);
  advance(sim,()=>sim.trucks.every(truck=>truck.status==='idle'),100);
  expect(sim.trucks.map(truck=>truck.status)).toEqual(['idle','idle','idle']);
  expect(sim.trucks.map(truck=>truck.pose.point)).toEqual(garage.map(bay=>bay.points[0]));
});

test('cars use the right side in both directions and stop behind a stopped car',()=>{
  // 原有长路段在底图过街点细分，仍以双向同一道路验证跟车与避碰。
  const road=avenueLanes.filter(l=>l.road==='R-02'&&l.length>7);
  expect(road).toHaveLength(2);
  for(const lane of road) {
    const p=pose({piece:lane,distance:1});
    expect((p.point[1]-29.361296)*Math.cos(p.angle)).toBeCloseTo(-.8);
  }
  // 跟车阶段在足够长的既有车道上运行，避免本测试期间进入新增的过街信号区。
  const sim=new TrafficSimulation(), lane=avenueLanes.find(l=>l.road?.startsWith('EXT-')&&l.length>10)!;
  sim.cars.splice(2);
  const [leader,follower]=sim.cars;
  for(const [v,d] of [[leader,7],[follower,4]] as const) {
    v.path=[lane];v.index=0;v.cursor={piece:lane,distance:d};v.pose=pose(v.cursor);
  }
  leader.speed=0;follower.speed=1.5;
  advance(sim,()=>false,2);
  expect(follower.cursor.distance).toBeGreaterThan(5);
  const waiting=follower.cursor.distance;
  sim.tick(.5);
  expect(follower.cursor.distance).toBe(waiting);
  expect(conflicts(leader,follower,0)).toBe(false);
  leader.speed=1.5;sim.tick(.75);
  expect(follower.cursor.distance).toBeGreaterThan(waiting);
  expect(conflicts(leader,follower,0)).toBe(false);
});

test('dispatch can take another legal turn when a queue blocks the final approach',()=>{
  const sim=new TrafficSimulation();
  for(let frame=0;frame<360;frame++)sim.tick(1/60);
  sim.setIncident(sw,3);
  for(let frame=0;frame<3600&&!sim.trucks.every(t=>t.status==='arrived');frame++)sim.tick(1/60);
  expect(sim.trucks.filter(t=>t.status==='arrived')).toHaveLength(3);
});

test('approved external parking lanes divert ordinary traffic before two responders arrive', () => {
  const sim = new TrafficSimulation();
  // 该启动时刻会让普通车在首车停下前进入停车路段，随后夹住第二辆消防车。
  sim.tick(2.75);
  Array.from({ length: 2306 }, () => sim.tick(.05));
  const approved = ['lane:92', 'turn:92:1', 'lane:24', 'turn:24:1', 'lane:142',
    'lane:166', 'lane:168', 'turn:168:1', 'lane:187'];
  [sim.trucks[1], sim.trucks[0]].forEach((truck, index) => {
    sim.applyExternalDispatch({ vehicleId: truck.id, targetPoiId: 'T-SW-01',
      targetPosition: { x: sw[0], y: sw[1] }, status: 'dispatched' },
    { pieceIds: [`garage:${index === 0 ? 1 : 0}`, ...approved],
      stop: index === 0 ? roadPieces.get(approved.at(-1)!)!.length - .98 : 2.88 });
  });
  sim.signals.setMode('emergency_priority');
  advance(sim, () => sim.trucks.slice(0, 2).every(t => t.status === 'arrived'), 300);
  expect(sim.trucks.slice(0, 2).map(t => t.status)).toEqual(['arrived', 'arrived']);
  expect(sim.all.every((vehicle, index) => sim.all.slice(index + 1).every(other => !conflicts(vehicle, other, 0)))).toBe(true);
});
