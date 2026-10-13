import { describe, expect, it } from 'vitest';
import samples from '../../../docs/map-calibration.json';
import { DEFAULT_CALIBRATION, pixelToWorld, worldToPixel } from './mapCoordinates';

describe('measured map calibration', () => {
  it('maps southwest/northeast extent with north pointing up', () => {
    expect(worldToPixel({ x_m: 0, y_m: 0 })).toEqual({ x: 160, y: 1190 });
    expect(worldToPixel({ x_m: 30, y_m: 25 })).toEqual({ x: 1545, y: 70 });
  });
  it.each(samples.anchors)('matches measured JPEG POI $poi_id', anchor => {
    const point = worldToPixel(anchor);
    expect(Math.hypot(point.x-anchor.jpeg_x, point.y-anchor.jpeg_y)).toBeLessThan(0.05);
    expect(pixelToWorld(point).x_m).toBeCloseTo(anchor.x_m, 8);
    expect(pixelToWorld(point).y_m).toBeCloseTo(anchor.y_m, 8);
  });
  it('allows a calibrated shift without changing physical coordinates', () => {
    const point = worldToPixel({ x_m: 11.22, y_m: 10.647 }, { ...DEFAULT_CALIBRATION, left: 165 });
    expect(point.x).toBeCloseTo(683, 1);
    expect(point.y).toBeCloseTo(713, 1);
  });
  it('rejects invalid sizes and nonfinite coordinates', () => {
    expect(() => worldToPixel({ x_m: NaN, y_m: 0 })).toThrow();
    expect(() => worldToPixel({ x_m: 0, y_m: 0 }, { ...DEFAULT_CALIBRATION, width: 0 })).toThrow();
  });
});
