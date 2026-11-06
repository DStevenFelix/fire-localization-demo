import type { Coordinates } from '../types';
import mapConfig from '../../../../fire_poi/map_config.json';
import { scene_config, original_map_placement, coordinate_system } from '../../../../city_scene/city_scene.json';

export type CoordinateSystem = 'LOCAL30x25' | 'local_cartesian_meters' | 'CITY90x75';
export const SCENE_SIZE = scene_config.scene_pixels;
export const ORIGINAL_PLACEMENT = original_map_placement.pixels;
export function toCity(coordinates: Coordinates, system: CoordinateSystem = 'LOCAL30x25'): Coordinates {
  if (!Number.isFinite(coordinates.x_m) || !Number.isFinite(coordinates.y_m)) throw new Error('坐标无效');
  if (system === 'CITY90x75') return coordinates;
  if (system !== 'LOCAL30x25' && system !== 'local_cartesian_meters') throw new Error('未知坐标系');
  return { x_m: coordinates.x_m + original_map_placement.offset[0], y_m: coordinates.y_m + original_map_placement.offset[1] };
}
export function sceneToPixel(coordinates: Coordinates, system: CoordinateSystem = 'CITY90x75') {
  const c = toCity(coordinates, system);
  return { x: c.x_m * IMAGE_SIZE.width / WORLD_SIZE.width,
    y: (coordinate_system.extent[3] - c.y_m) * IMAGE_SIZE.height / WORLD_SIZE.height };
}
export function scenePixelToCity(point: { x: number; y: number }): Coordinates {
  return { x_m: point.x / SCENE_SIZE.width * 90, y_m: (1 - point.y / SCENE_SIZE.height) * 75 };
}
export type MapView = { x: number; y: number; width: number; height: number };
export const ORIGINAL_VIEW: MapView = { ...ORIGINAL_PLACEMENT };
export const FULL_VIEW: MapView = { x: 0, y: 0, ...SCENE_SIZE };
export function clampView(view: MapView): MapView {
  return { ...view, x: Math.max(0, Math.min(SCENE_SIZE.width-view.width, view.x)), y: Math.max(0, Math.min(SCENE_SIZE.height-view.height, view.y)) };
}
export function zoomView(view: MapView, factor: number, anchor = { x: view.x+view.width/2, y: view.y+view.height/2 }): MapView {
  const width = Math.min(SCENE_SIZE.width, Math.max(IMAGE_SIZE.width/8, view.width/factor));
  const ratio = width/view.width;
  return clampView({x: anchor.x-(anchor.x-view.x)*ratio, y: anchor.y-(anchor.y-view.y)*ratio, width, height: width*IMAGE_SIZE.height/IMAGE_SIZE.width});
}

export type Calibration = { left: number; top: number; width: number; height: number };
export const IMAGE_SIZE = { width: mapConfig.source.width_px, height: mapConfig.source.height_px };
export const WORLD_SIZE = { width: mapConfig.coordinate_system.extent[2], height: mapConfig.coordinate_system.extent[3] };
// SVG image coordinates describe outer edges [0,W]×[0,H]. Source pixel centers
// use [0,W-1]×[0,H-1]; converting between conventions cancels the W-1 factor.
// The whole uncropped image represents the 30×25 map. 1 simulation unit = 1 m.
export const DEFAULT_CALIBRATION: Calibration = { left: 0, top: 0, width: IMAGE_SIZE.width, height: IMAGE_SIZE.height };

export function isValidCalibration(value: Calibration): boolean {
  return Object.values(value).every(Number.isFinite) && value.left >= 0 && value.top >= 0 &&
    value.width > 0 && value.height > 0 && value.left + value.width <= IMAGE_SIZE.width &&
    value.top + value.height <= IMAGE_SIZE.height;
}
export function worldToPixel(coordinates: Coordinates, calibration = DEFAULT_CALIBRATION) {
  if (!isValidCalibration(calibration) || !Number.isFinite(coordinates.x_m) || !Number.isFinite(coordinates.y_m)) {
    throw new Error('地图坐标或校准参数无效');
  }
  return { x: calibration.left + coordinates.x_m / WORLD_SIZE.width * calibration.width,
    y: calibration.top + (1 - coordinates.y_m / WORLD_SIZE.height) * calibration.height };
}
export function pixelToWorld(pixel: { x: number; y: number }, calibration = DEFAULT_CALIBRATION): Coordinates {
  if (!isValidCalibration(calibration) || !Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) throw new Error('地图像素或校准参数无效');
  return { x_m: (pixel.x-calibration.left)/calibration.width*WORLD_SIZE.width,
    y_m: (1-(pixel.y-calibration.top)/calibration.height)*WORLD_SIZE.height };
}
