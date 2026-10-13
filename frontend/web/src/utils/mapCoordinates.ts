import type { Coordinates } from '../types';

export type Calibration = { left: number; top: number; width: number; height: number };
export const IMAGE_SIZE = { width: 1707, height: 1280 };
export const WORLD_SIZE = { width: 30, height: 25 };
// Measured against 28 annotated POIs; PNG -> JPEG is a vertical translation of -80px.
export const DEFAULT_CALIBRATION: Calibration = { left: 160, top: 70, width: 1385, height: 1120 };

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
