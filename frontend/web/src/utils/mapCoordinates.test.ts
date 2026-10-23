import { describe, expect, it } from 'vitest';
import audit from '../../../../fire_poi/CoordinateAudit.json';
import { DEFAULT_CALIBRATION, IMAGE_SIZE, pixelToWorld, worldToPixel } from './mapCoordinates';

describe('current map pixel conventions', () => {
  it('maps all four image edges with southwest origin and north up', () => {
    expect(worldToPixel({ x_m: 0, y_m: 0 })).toEqual({ x: 0, y: 1050 });
    expect(worldToPixel({ x_m: 30, y_m: 25 })).toEqual({ x: 1313, y: 0 });
    expect(worldToPixel({ x_m: 0, y_m: 25 })).toEqual({ x: 0, y: 0 });
    expect(worldToPixel({ x_m: 30, y_m: 0 })).toEqual({ x: 1313, y: 1050 });
  });
  it.each(audit.items)('aligns $id with independently audited source pixels', anchor => {
    const coordinates = { x_m: anchor.center[0], y_m: anchor.center[1] };
    const point = worldToPixel(coordinates);
    // Audit uses source center indices; SVG images use outer-edge coordinates.
    expect(point.x * (IMAGE_SIZE.width - 1) / IMAGE_SIZE.width).toBeCloseTo(anchor.display_pixel_center[0], 3);
    expect(point.y * (IMAGE_SIZE.height - 1) / IMAGE_SIZE.height).toBeCloseTo(anchor.display_pixel_center[1], 3);
    expect(pixelToWorld(point).x_m).toBeCloseTo(coordinates.x_m, 8);
    expect(pixelToWorld(point).y_m).toBeCloseTo(coordinates.y_m, 8);
  });
  it('rejects invalid sizes and nonfinite coordinates', () => {
    expect(() => worldToPixel({ x_m: NaN, y_m: 0 })).toThrow();
    expect(() => worldToPixel({ x_m: 0, y_m: 0 }, { ...DEFAULT_CALIBRATION, width: 0 })).toThrow();
  });
});
