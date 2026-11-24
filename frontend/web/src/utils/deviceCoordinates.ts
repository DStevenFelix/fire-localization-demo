import type { CityPosition } from '../types';
import { toCity, WORLD_SIZE, SCENE_SIZE, sceneToPixel, scenePixelToCity } from './mapCoordinates';

type Bounds = readonly [minX: number, minY: number, maxX: number, maxY: number];
type Affine = readonly [xx: number, xy: number, yx: number, yy: number, offsetX: number, offsetY: number];
export type DeviceCalibration = Readonly<{
  sourceCoordinateSystem: string;
  version: string;
  origin: string;
  axisDirection: string;
  physicalBounds: Bounds;
  mapBounds: Bounds;
  // Applies to raw source coordinates and returns LOCAL30x25 coordinates.
  transform: Affine;
}>;

const cityBounds: Bounds = [0, 0, 90, 75];
const localBounds: Bounds = [0, 0, WORLD_SIZE.width, WORLD_SIZE.height];
const cityOrigin = toCity({ x_m: 0, y_m: 0 });
export const tabletopCalibration: DeviceCalibration = {
  sourceCoordinateSystem: 'PHYSICAL_SW_METERS', version: 'axis-aligned-v1',
  origin: '沙盘西南角', axisDirection: 'X 东、Y 北，单位米',
  physicalBounds: [0, 0, 5, 4], mapBounds: localBounds,
  transform: [WORLD_SIZE.width / 5, 0, 0, WORLD_SIZE.height / 4, 0, 0],
};

export function isInBounds(point: CityPosition, [minX, minY, maxX, maxY]: Bounds) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
}

export function validateCalibration(calibration: DeviceCalibration) {
  const [xx, xy, yx, yy] = calibration.transform;
  const [minX, minY, maxX, maxY] = calibration.physicalBounds;
  const [left, bottom, right, top] = calibration.mapBounds;
  if (!calibration.version.trim() || !calibration.sourceCoordinateSystem.trim() ||
    [ 'LOCAL30x25', 'CITY90x75' ].includes(calibration.sourceCoordinateSystem) ||
    !calibration.origin.trim() || !calibration.axisDirection.trim() ||
    !calibration.transform.every(Number.isFinite) || !Number.isFinite(xx * yy - xy * yx) || xx * yy === xy * yx ||
    !calibration.physicalBounds.every(Number.isFinite) || minX >= maxX || minY >= maxY ||
    !isInBounds({ x: left, y: bottom }, localBounds) || !isInBounds({ x: right, y: top }, localBounds) ||
    left >= right || bottom >= top) throw new RangeError('设备坐标标定参数无效');
}

export function deviceToCity(point: CityPosition, system: string, calibrations: ReadonlyMap<string, DeviceCalibration>, version?: string): CityPosition {
  if (system === 'CITY90x75') {
    if (!isInBounds(point, cityBounds)) throw new RangeError('全局城市坐标越界');
    return point;
  }
  const local = system === 'LOCAL30x25' ? point : deviceToLocal(point, calibrations.get(system), version);
  if (!isInBounds(local, localBounds)) throw new RangeError('局部沙盘坐标越界');
  const city = toCity({ x_m: local.x, y_m: local.y });
  return { x: city.x_m, y: city.y_m };
}

function deviceToLocal(point: CityPosition, calibration: DeviceCalibration | undefined, version?: string) {
  if (!calibration || calibration.version !== version) throw new RangeError('设备坐标系未标定或标定版本不一致');
  if (!isInBounds(point, calibration.physicalBounds)) throw new RangeError('原始设备坐标越界');
  const [xx, xy, yx, yy, offsetX, offsetY] = calibration.transform;
  const local = { x: xx * point.x + xy * point.y + offsetX, y: yx * point.x + yy * point.y + offsetY };
  if (!isInBounds(local, calibration.mapBounds)) throw new RangeError('标定后坐标越界');
  return local;
}

export function cityToDevice(city: CityPosition, calibration: DeviceCalibration): CityPosition {
  validateCalibration(calibration);
  const local = { x: city.x - cityOrigin.x_m, y: city.y - cityOrigin.y_m };
  if (!isInBounds(local, calibration.mapBounds)) throw new RangeError('城市坐标不在标定区域内');
  const [xx, xy, yx, yy, offsetX, offsetY] = calibration.transform;
  const determinant = xx * yy - xy * yx;
  const point = { x: (yy * (local.x - offsetX) - xy * (local.y - offsetY)) / determinant,
    y: (xx * (local.y - offsetY) - yx * (local.x - offsetX)) / determinant };
  if (!isInBounds(point, calibration.physicalBounds)) throw new RangeError('反向标定坐标越界');
  return point;
}

// getScreenCTM incorporates the actual SVG viewBox, CSS box and letterboxing.
export function cityToScreen(city: CityPosition, matrix: DOMMatrixReadOnly) {
  const pixel = sceneToPixel({ x_m: city.x, y_m: city.y });
  return new DOMPoint(pixel.x, pixel.y).matrixTransform(matrix);
}

export function screenToCity(screen: CityPosition, matrix: DOMMatrixReadOnly): CityPosition {
  const pixel = new DOMPoint(screen.x, screen.y).matrixTransform(matrix.inverse());
  if (!isInBounds(pixel, [0, 0, SCENE_SIZE.width, SCENE_SIZE.height])) throw new RangeError('屏幕位置在地图范围外');
  const city = scenePixelToCity(pixel);
  return { x: city.x_m, y: city.y_m };
}
