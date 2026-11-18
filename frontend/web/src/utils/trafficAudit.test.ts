import { expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import local from '../../../../fire_poi/fire_sandbox_spatial_model.json';
import city from '../../../../city_scene/city_scene.json';
import { lanes } from './roadNetwork';
import { originalCrosswalks, junctionKey } from './trafficSignalGeometry';
import { intersections, signalCoverage, TrafficSignalController } from './trafficSignalController';
import { PedestrianSimulation } from './pedestrianSimulation';

test('audit all 15 original junctions, every vehicle edge and all 20 zebra stripes against real controls', () => {
  const signals = new TrafficSignalController(), pedestrians = new PedestrianSimulation(signals);
  local.edges.filter(e => e.vehicle_allowed).forEach(edge => expect(lanes.some(l => l.road === edge.road_id)).toBe(true));
  const junctions = local.nodes.filter(n => n.id.startsWith('J')).map(node => {
    const id = junctionKey(node.center.map((p, i) => p + city.original_map_placement.offset[i]));
    const incoming = lanes.filter(l => l.to === id);
    const controlled = intersections.find(i => i.id === id);
    const edges = local.edges.filter(e => e.geometry.coordinates.some(p => p.every((v, i) => v === node.center[i])));
    expect(Boolean(controlled)).toBe(incoming.length >= 3);
    return { id: node.id, cityJunction: id, incomingVehicleLanes: incoming.length, controlled: Boolean(controlled),
      kind: controlled?.kind, vehicleRoads: [...new Set(edges.filter(e => e.vehicle_allowed).map(e => e.road_id))],
      pedestrianRoads: [...new Set(edges.filter(e => !e.vehicle_allowed).map(e => e.road_id))] };
  });
  expect(junctions).toHaveLength(15);
  const crossings = originalCrosswalks.map(crossing => {
    const control = signals.getCrosswalkControl(crossing.id)!;
    expect(control).toBeDefined();
    expect(pedestrians.actors.some(a => a.route.segments.some(s => s.crosswalk === crossing.id))).toBe(true);
    signals.setMode('emergency_lockdown'); expect(signals.canEnterPedestrian(crossing.id)).toBe(false);
    return { id: crossing.id, sourceControl: crossing.control, cityJunction: control.intersection.id, points: crossing.points };
  });
  expect(crossings).toHaveLength(20);
  expect(new Set(crossings.map(c => c.cityJunction)).size).toBe(6);
  const counts = ['original', 'extension', 'station'].map(region => ({ region,
    positions: intersections.filter(i => i.region === region).length,
    approaches: intersections.filter(i => i.region === region).reduce((sum, i) => sum + i.entries.length, 0),
    crossroads: intersections.filter(i => i.region === region && i.kind === 'crossroad').length,
    tJunctions: intersections.filter(i => i.region === region && i.kind === 't_junction').length,
    crossingPoints: intersections.filter(i => i.region === region && i.kind === 'crossing').length,
  }));
  const output = process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/unit` : 'screenshots/phase3';
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/traffic-audit.json`, JSON.stringify({ counts, coverage: signalCoverage, junctions, crossings }, null, 2));
});
