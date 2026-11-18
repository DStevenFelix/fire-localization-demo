import { describe, expect, test } from 'vitest';
import { cityToScene, getFireScene, isInsideScene, localToScene, PIXELS_PER_UNIT, sceneTanks } from './fireSceneData';
import { scenePixelToCity, sceneToPixel } from './mapCoordinates';
import { pois } from '../../../../fire_poi/fire_sandbox_spatial_model.json';
import resources from '../../../../city_scene/fire_resources.json';
import city from '../../../../city_scene/city_scene.json';
import catalog from '../../../../city_scene/poi_catalog.json';
import hierarchy from '../../../../city_scene/poi_hierarchy.json';
import emergency from '../config/emergency.json';

test('source axes and pixel centers use separate X/Y scales', () => {
  expect(localToScene([0, 0])).toEqual({ x: -656, y: 0, z: 524.5 });
  expect(localToScene([30, 25], 40)).toEqual({ x: 656, y: 40, z: -524.5 });
  expect(localToScene([15, 12.5])).toEqual({ x: 0, y: 0, z: 0 });
  expect(PIXELS_PER_UNIT.x).not.toBe(PIXELS_PER_UNIT.y);
});

test.each([
  ['T-NW-01', -235.000017, -122.499996],
  ['T-SW-01', -230.999991, 147.500016],
  ['T-SE-02', 225.999999, 148.499996],
])('%s center matches the authored image location', (id, x, z) => {
  const tank = sceneTanks.find(p => p.id === id)!;
  const scene = localToScene(tank.center);
  expect(scene.x).toBeCloseTo(Number(x), 3);
  expect(scene.z).toBeCloseTo(Number(z), 3);
  const city = cityToScene({ x: tank.center[0] + 30, y: tank.center[1] + 25 });
  expect(city.x).toBeCloseTo(scene.x, 9);
  expect(city.z).toBeCloseTo(scene.z, 9);
});

describe('all authored tanks', () => {
  test('exactly eight tanks, four groups', () => {
    expect(sceneTanks).toHaveLength(8);
    expect(new Set(sceneTanks.map(p => p.parent_id)).size).toBe(4);
  });
  test.each(sceneTanks.map(p => p.id))('%s resolves siblings, facilities, bounds and SVG correspondence', id => {
    const scene = getFireScene(id)!;
    expect(scene.target.id).toBe(id);
    expect(scene.area.id).toBe(scene.target.parent_id);
    expect(scene.tanks).toHaveLength(2);
    expect(scene.tanks.every(tank => tank.parent_id === scene.area.id)).toBe(true);
    expect(scene.pipes.map(p => p.id)).toEqual([`F-PIPE-${id.split('-')[1]}`]);
    expect(scene.buildings.map(p => p.id)).toEqual(pois.filter(p => p.entity_type === 'Building' && p.parent_id === scene.area.id).map(p => p.id));
    scene.tanks.map(tank => {
      const position = localToScene(tank.center);
      expect(isInsideScene(position, scene.bounds)).toBe(true);
      const svg = sceneToPixel({ x_m: tank.center[0], y_m: tank.center[1] }, 'LOCAL30x25');
      const city = scenePixelToCity(svg);
      const converted = cityToScene({ x: city.x_m, y: city.y_m });
      expect(converted.x).toBeCloseTo(position.x, 8);
      expect(converted.z).toBeCloseTo(position.z, 8);
      tank.geometry.coordinates[0].map(point => {
        const edge = localToScene(point);
        const ellipse = ((edge.x - position.x) / (tank.shape.radius_x * PIXELS_PER_UNIT.x)) ** 2 +
          ((edge.z - position.z) / (tank.shape.radius_y * PIXELS_PER_UNIT.y)) ** 2;
        expect(ellipse).toBeCloseTo(1, 4);
      });
    });
    expect(localToScene(scene.tanks[0].center).x).toBeLessThan(localToScene(scene.tanks[1].center).x);
    expect(scene.bounds.maxX - scene.bounds.minX).toBeLessThan(500);
  });
});

test('unknown targets never select an arbitrary fire', () => {
  expect(getFireScene(null)).toBeNull();
  expect(getFireScene('not-a-tank')).toBeNull();
});

test('the shared drone station, catalog, spatial relations and both home bays agree', () => {
  const station = resources.drone_station;
  const poi = catalog.find(p => p.id === station.poi_id)!;
  const scenePoi = city.scene_pois.find(p => p.id === station.poi_id)!;
  expect(poi.type).toBe('drone_station');
  expect(poi.name).toBe('消防无人机站');
  expect(poi.can_post).toBe(false);
  expect(poi.center).toEqual(station.center);
  expect(poi.geometry).toEqual(station.geometry);
  expect(scenePoi.center).toEqual(station.center);
  expect(scenePoi.geometry).toEqual(station.geometry);
  expect(hierarchy.relations).toContainEqual({ subject_id: station.poi_id, relation: 'serves', object_id: resources.station_poi_id, source: 'city_full_extension' });
  expect(emergency.stationPoiId).toBe(station.poi_id);
  station.bays.forEach(bay => {
    expect(emergency.drones.find(d => d.id === bay.drone_id)?.position).toEqual({ x: bay.center[0], y: bay.center[1] });
    const shape = station.geometry.coordinates[0];
    expect(bay.center[0] - .72).toBeGreaterThan(Math.min(...shape.map(p => p[0])));
    expect(bay.center[0] + .72).toBeLessThan(Math.max(...shape.map(p => p[0])));
    expect(bay.center[1] - .72).toBeGreaterThan(Math.min(...shape.map(p => p[1])));
    expect(bay.center[1] + .72).toBeLessThan(Math.max(...shape.map(p => p[1])));
  });
  expect(Math.hypot(...station.bays[0].center.map((v, i) => v - station.bays[1].center[i]))).toBeGreaterThan(1.44);
});
