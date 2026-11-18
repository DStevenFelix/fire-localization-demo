import mapConfig from '../../../../fire_poi/map_config.json';
import { pois, areas } from '../../../../fire_poi/fire_sandbox_spatial_model.json';
import { fire_station_reserve, original_map_placement } from '../../../../city_scene/city_scene.json';
import { drone_station } from '../../../../city_scene/fire_resources.json';
import { ARRIVAL_RADIUS } from './roadNetwork';

export const SOURCE_SIZE = { width: mapConfig.source.width_px, height: mapConfig.source.height_px };
export const PIXELS_PER_UNIT = {
  x: (SOURCE_SIZE.width - 1) / mapConfig.coordinate_system.extent[2],
  y: (SOURCE_SIZE.height - 1) / mapConfig.coordinate_system.extent[3],
};
export const sceneTanks = pois.filter((poi): poi is typeof poi & { shape: NonNullable<typeof poi.shape> } => poi.entity_type === 'Tank' && !!poi.shape);

export function localToScene(point: readonly number[], height = 0) {
  // Three.js is right-handed with Y up: south is +Z, north is -Z.
  // Source pixel centers map to texel centers, not texture outer edges.
  return { x: point[0] * PIXELS_PER_UNIT.x - (SOURCE_SIZE.width - 1) / 2,
    y: height, z: (SOURCE_SIZE.height - 1) / 2 - point[1] * PIXELS_PER_UNIT.y };
}

export function cityToScene(point: { readonly x: number; readonly y: number }, height = 0) {
  return localToScene([point.x - original_map_placement.offset[0], point.y - original_map_placement.offset[1]], height);
}

const stationCenter = cityToScene({ x: (drone_station.center[0] + fire_station_reserve.center[0]) / 2,
  y: (drone_station.center[1] + fire_station_reserve.center[1]) / 2 });
const stationHalfWidth = Math.abs(drone_station.center[0] - fire_station_reserve.center[0]) / 2 + 4;
const stationHalfHeight = Math.abs(drone_station.center[1] - fire_station_reserve.center[1]) / 2 + 4;
export const droneStationScene = {
  center: stationCenter,
  bounds: { minX: stationCenter.x - stationHalfWidth * PIXELS_PER_UNIT.x, maxX: stationCenter.x + stationHalfWidth * PIXELS_PER_UNIT.x,
    minZ: stationCenter.z - stationHalfHeight * PIXELS_PER_UNIT.y, maxZ: stationCenter.z + stationHalfHeight * PIXELS_PER_UNIT.y },
};

export function getFireScene(targetId: string | null) {
  const target = sceneTanks.find(poi => poi.id === targetId);
  if (!target) return null;
  const area = areas.find(poi => poi.id === target.parent_id)!;
  const footprint = area.geometry.coordinates[0].map(point => localToScene(point));
  const origin = localToScene(target.center);
  const reachX = ARRIVAL_RADIUS * PIXELS_PER_UNIT.x, reachZ = ARRIVAL_RADIUS * PIXELS_PER_UNIT.y;
  // Include the adjoining access roads and the dispatch algorithm's stopping radius.
  const bounds = { minX: Math.min(Math.min(...footprint.map(p => p.x)) - 100, origin.x - reachX),
    maxX: Math.max(Math.max(...footprint.map(p => p.x)) + 100, origin.x + reachX),
    minZ: Math.min(Math.min(...footprint.map(p => p.z)) - 64, origin.z - reachZ),
    maxZ: Math.max(Math.max(...footprint.map(p => p.z)) + 64, origin.z + reachZ) };
  return { target, area, bounds,
    center: { x: (bounds.minX + bounds.maxX) / 2, y: 0, z: (bounds.minZ + bounds.maxZ) / 2 },
    tanks: sceneTanks.filter(poi => poi.parent_id === target.parent_id),
    pipes: pois.filter((poi): poi is typeof poi & { linework: NonNullable<typeof poi.linework> } => poi.parent_id === target.parent_id && !!poi.linework),
    buildings: pois.filter(poi => poi.parent_id === target.parent_id && poi.entity_type === 'Building'),
  };
}

export type FireSceneData = NonNullable<ReturnType<typeof getFireScene>>;

export function isInsideScene(point: { x: number; z: number }, bounds: FireSceneData['bounds']) {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.z >= bounds.minZ && point.z <= bounds.maxZ;
}
