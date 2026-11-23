import type { Coordinates } from '../types';
import mapConfig from '../../../fire_poi/map_config.json';
import city from '../../../city_scene/city_scene.json';

export type Calibration = { left: number; top: number; width: number; height: number };
export const IMAGE_SIZE = { width: mapConfig.source.width_px, height: mapConfig.source.height_px };
export const WORLD_SIZE = { width: 90, height: 75 };
export const SCENE_SIZE = city.scene_config.scene_pixels;
export const ORIGINAL_PLACEMENT = city.original_map_placement.pixels;
// SVG image coordinates describe outer edges [0,W]×[0,H]. Source pixel centers
// use [0,W-1]×[0,H-1]; converting between conventions cancels the W-1 factor.
// 世界坐标统一 CITY90x75；原图不裁剪，按 placement 嵌入整城画布。
export const DEFAULT_CALIBRATION: Calibration = { left: 0, top: 0, width: SCENE_SIZE.width, height: SCENE_SIZE.height };

export function isValidCalibration(value: Calibration): boolean {
  return Object.values(value).every(Number.isFinite) && value.left >= 0 && value.top >= 0 &&
    value.width > 0 && value.height > 0 && value.left + value.width <= SCENE_SIZE.width &&
    value.top + value.height <= SCENE_SIZE.height;
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
