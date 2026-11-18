import { expect, test } from 'vitest';
import { fire_station_reserve } from '../../../../city_scene/city_scene.json';
import { pois } from '../../../../fire_poi/fire_sandbox_spatial_model.json';
import { approaches, avenueLanes, distance, garage, garageEntries, inTankZone, isFireStationOnly, isGarageAccess, lanes, oppositeLane, pose, roadPieces, stationExit, type Point } from './roadNetwork';
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
  expect(sim.cars).toHaveLength(27);
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

test.each([false, true])('a car with a stopped truck ahead can turn safely with a rear truck present: %s', (boxedIn) => {
  const sim = new TrafficSimulation();
  const lane = westFireLane;
  const opposite = oppositeLane(lane)!;
  const car = sim.cars.find(car => car.path.includes(lane))!;
  const other = sim.cars.find(candidate => candidate !== car)!;
  sim.cars.splice(0, sim.cars.length, car, other);
  const [front, rear] = sim.trucks;
  for (const [vehicle, piece, offset] of [[front, lane, 4.1], [rear, lane, 1], [car, lane, 2.55], [other, opposite, opposite.length - 2.55]] as const) {
    vehicle.cursor = { piece, distance: offset };
    vehicle.pose = pose(vehicle.cursor);
    vehicle.junction = undefined;
  }
  front.status = 'arrived';
  if (boxedIn) rear.status = 'arrived';
  else sim.trucks.splice(1, 1);
  car.index = car.path.indexOf(lane);
  other.path = [opposite]; other.index = 0; other.speed = 0;
  sim.tick(.2);
  expect(car.cursor.piece).toBe(lane);
  expect(car.cursor.distance).toBe(2.55);
  sim.cars.pop();
  sim.tick(.1);
  expect(car.cursor.piece).toBe(opposite);
  expect(Math.cos(car.pose.angle - front.pose.angle)).toBeCloseTo(-1);
  expect(sim.trucks.every(truck => !conflicts(truck, car, 0))).toBe(true);
});

test('an ordinary car uses a different legal exit before entering a blocked turn', () => {
  const sim = new TrafficSimulation();
  const car = sim.cars.find(car => car.path.some(lane => lane.road && lane.next.length >= 3))!;
  const index = car.path.findIndex(lane => lane.road && lane.next.length >= 3);
  const lane = car.path[index], intended = car.path[(index + 1) % car.path.length];
  const exit = intended.road ? intended : intended.next[0];
  const truck = sim.trucks[0];
  truck.cursor = { piece: exit, distance: .85 }; truck.pose = pose(truck.cursor); truck.status = 'arrived';
  car.cursor = { piece: lane, distance: sim.signals.stopDistance(lane, .65) - .1 };
  car.pose = pose(car.cursor); car.index = index;
  sim.tick(.05);
  const replacement = car.path[car.index + 1];
  expect(lane.next.includes(replacement)).toBe(true);
  expect(replacement === intended).toBe(false);
});

test('when two trucks are nose-to-tail, the front truck returns and the rear one keeps responding', () => {
  const sim = new TrafficSimulation();
  sim.setIncident(sw, 2);
  const [front, rear] = sim.trucks;
  for (const [truck, offset] of [[front, 4], [rear, 2.22]] as const) {
    truck.cursor = { piece: westFireLane, distance: offset };
    truck.pose = pose(truck.cursor);
    truck.status = 'arrived';
    truck.junction = undefined;
  }
  sim.setIncident(sw, 1);
  expect(front.status).toBe('returning');
  expect(rear.status).toBe('arrived');
  advance(sim, () => front.status === 'idle', 360);
  expect(front.pose.point).toEqual(garage[0].points[0]);
  expect(rear.cursor.distance).toBe(2.22);
  sim.setIncident(null, 1);
  advance(sim, () => sim.trucks.every(truck => truck.status === 'idle'), 600);
  expect(sim.trucks.map(truck => truck.pose.point)).toEqual(garage.map(bay => bay.points[0]));
});

test.each([
  { tank: 'T-SW-01', initialSeconds: 17, maxWait: 40 },
  { tank: 'T-NE-01', initialSeconds: 115, maxWait: 90 },
  { tank: 'T-SW-02', initialSeconds: 115, maxWait: 95 },
  { tank: 'T-SE-01', initialSeconds: 115, maxWait: 95 },
])('returning trucks at $tank with $initialSeconds seconds of initial traffic avoid prolonged approach queues', ({ tank, initialSeconds, maxWait }) => {
  const sim = new TrafficSimulation();
  const target = tanks.find(({ id }) => id === tank)!.point;
  const advanceUntil = (done: () => boolean, maxSeconds: number) => {
    for (let step = 0; step < maxSeconds * 10 && !done(); step++) sim.tick(.1);
    expect(done()).toBe(true);
  };
  for (let step = 0; step < initialSeconds * 10; step++) sim.tick(.1);
  sim.setTankZoneClosed(true);
  for (let step = 0; step < 60; step++) sim.tick(.1);
  const allArrived = () => sim.trucks.every(truck => truck.status === 'arrived');
  sim.setIncident(target, 3);
  advanceUntil(allArrived, 125);
  sim.setIncident(target, 1);
  advanceUntil(() => sim.trucks.filter(truck => truck.status === 'idle').length === 2, 500);
  sim.setIncident(target, 3);
  advanceUntil(allArrived, 140);
  sim.setTankZoneClosed(false);
  sim.setIncident(null, 3);

  const waited = new Map<string, number>();
  let longestWait = 0;
  for (let step = 0; step < 5000 && sim.trucks.some(truck => truck.status !== 'idle'); step++) {
    const previous = sim.trucks.map(truck => truck.cursor);
    sim.tick(.1);
    sim.trucks.forEach((truck, index) => {
      if (truck.status !== 'returning' || !sim.signals.getLaneControl(truck.cursor.piece) ||
          truck.cursor.piece !== previous[index].piece || truck.cursor.distance !== previous[index].distance) {
        waited.delete(truck.id); return;
      }
      const stoppedFor = (waited.get(truck.id) ?? 0) + .1;
      waited.set(truck.id, stoppedFor);
      longestWait = Math.max(longestWait, stoppedFor);
    });
  }
  expect(longestWait).toBeLessThan(maxWait);
  expect(sim.trucks.every(truck => truck.status === 'idle')).toBe(true);
});

test('only the four station-facing directions and their entrances are reserved for fire trucks', () => {
  const reserved = lanes.filter(isFireStationOnly);
  expect(reserved.map(lane => `${lane.from}>${lane.to}`).sort()).toEqual([
    '15.000000,12.000000>15.000000,20.000000', '15.000000,20.000000>20.000000,20.000000',
    '20.000000,20.000000>25.000000,20.000000', '25.000000,12.000000>15.000000,12.000000',
    '25.000000,20.000000>25.000000,12.000000',
  ]);
  for (const lane of reserved) expect(isFireStationOnly(oppositeLane(lane)!)).toBe(false);
  const entrances = lanes.flatMap(lane => lane.next).filter(turn => !turn.road && reserved.includes(turn.next[0]));
  expect(entrances.every(isFireStationOnly)).toBe(true);
  const sim = new TrafficSimulation();
  expect(sim.cars.every(car => !car.path.some(isFireStationOnly))).toBe(true);
});

test('tank district evacuation excludes new cars until reopening', () => {
  const sim = new TrafficSimulation();
  const local = sim.cars.filter(car => inTankZone(car.cursor.piece));
  expect(local.length).toBeGreaterThan(0);
  sim.setTankZoneClosed(true);
  expect(sim.signals.getMode()).toBe('normal');
  advance(sim, () => sim.cars.every(car => !inTankZone(car.cursor.piece)), 180);
  expect(sim.cars.filter(car => inTankZone(car.cursor.piece))).toHaveLength(0);
  for (let elapsed = 0; elapsed < 40; elapsed += .2) {
    sim.tick(.2);
    if (sim.cars.some(car => inTankZone(car.cursor.piece))) throw new Error('Car entered the closed zone');
  }
  sim.setTankZoneClosed(false);
  advance(sim, () => local.some(car => inTankZone(car.cursor.piece)), 180);
  expect(local.some(car => inTankZone(car.cursor.piece))).toBe(true);
});

test.each([0, 1, 2])('bay %i can be entered by a smooth reverse manoeuvre with the other bays occupied', bay=>{
  const sim = new TrafficSimulation();
  sim.cars.splice(0);
  sim.setIncident(sw, 3);
  const truck = sim.trucks[bay];
  truck.cursor = {piece: stationExit, distance: 0};
  truck.pose = pose(truck.cursor);
  sim.setIncident(null, 3);
  let largestTurn = 0, backedDistance = 0;
  for (let time = 0; time < 300 && truck.status !== 'idle'; time += .04) {
    const before = truck.pose, beforePiece = truck.cursor.piece;
    sim.tick(.04);
    if (isGarageAccess(beforePiece) || isGarageAccess(truck.cursor.piece)) {
      largestTurn = Math.max(largestTurn, Math.acos(Math.min(1, Math.cos(truck.pose.angle - before.angle))));
    }
    if (beforePiece === garageEntries[bay] && truck.cursor.piece === beforePiece) {
      const displacement = (truck.pose.point[0] - before.point[0]) * Math.cos(before.angle) +
        (truck.pose.point[1] - before.point[1]) * Math.sin(before.angle);
      expect(displacement).toBeLessThanOrEqual(1e-8);
      backedDistance -= displacement;
    }
  }
  expect(largestTurn).toBeLessThan(.45);
  expect(backedDistance).toBeGreaterThan(2);
  expect(truck.status).toBe('idle');
  expect(truck.pose.point).toEqual(garage[bay].points[0]);
  expect(Math.sin(truck.pose.angle)).toBeCloseTo(1);
  expect(sim.trucks.every((other, index) => index === bay || distance(other.pose.point, garage[index].points[0]) < 1e-6)).toBe(true);
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
  advance(sim,()=>sim.trucks.every(truck=>truck.status==='idle'),300);
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
