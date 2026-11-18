import { original_map_placement } from '../../../../city_scene/city_scene.json';
import { nodes, roads } from '../../../../fire_poi/fire_sandbox_spatial_model.json';
import pedestrianAnimation from '../../../../city_scene/pedestrian_animation.json';
import config from '../config/trafficControl.json';
import { pixelToWorld, toCity } from './mapCoordinates';
import type { Point } from './roadNetwork';

export const junctionKey = (p: number[]) => p.map(n => n.toFixed(6)).join(',');
const localPoint = (x: number, y: number): Point => {
  const p = toCity(pixelToWorld({ x, y }));
  return [p.x_m, p.y_m];
};

// 原图未提供斑马线矢量数据。矩形记录实际白色条纹范围，路径沿条纹排列方向贯穿斑马线。
export const originalCrosswalks = config.originalCrosswalks.map((crossing, i) => {
  const [x1, y1, x2, y2] = crossing.pixels;
  const horizontal = x2 - x1 > y2 - y1;
  return {
    id: `LOCAL-ZEBRA-${String(i + 1).padStart(3, '0')}`, control: crossing.control,
    points: horizontal
      ? [localPoint(x1 - 8, (y1 + y2) / 2), localPoint(x2 + 8, (y1 + y2) / 2)]
      : [localPoint((x1 + x2) / 2, y1 - 8), localPoint((x1 + x2) / 2, y2 + 8)],
    halfWidth: (horizontal ? y2 - y1 : x2 - x1) / 2 / 42,
  };
});

// 无机动车分支的原图过街点由条纹组中心投影到实际道路中心线；只细分路段，不增加道路。
export const crossingNodes = [...new Set(originalCrosswalks.map(c => c.control))].flatMap(control => {
  const road = roads.find(r => r.id === control);
  if (!road) return [];
  const crossings = originalCrosswalks.filter(c => c.control === control);
  const center = [0, 1].map(axis => crossings.reduce((n, c) => n + (c.points[0][axis] + c.points[1][axis]) / 2, 0) / crossings.length);
  const a = road.centerline.coordinates[0], b = road.centerline.coordinates.at(-1)!;
  const point: Point = a[0] === b[0] ? [a[0] + original_map_placement.offset[0], center[1]]
    : [center[0], a[1] + original_map_placement.offset[1]];
  return [{ id: `CROSSING:${control}`, road: control, point }];
});

export const crosswalkGeometry = [
  ...pedestrianAnimation.crosswalks.map(c => {
    const edge = pedestrianAnimation.edges.find(e => e.crosswalk_id === c.id)!;
    return { id: c.id, junction: c.junction_id,
      points: edge.geometry.coordinates as Point[], halfWidth: c.half_width_pixels / 42, original: false };
  }),
  ...originalCrosswalks.map(c => {
    const node = nodes.find(n => n.id === c.control);
    const center = node ? node.center.map((n, i) => n + original_map_placement.offset[i])
      : crossingNodes.find(n => n.road === c.control)!.point;
    return { id: c.id, junction: junctionKey(center), points: c.points, halfWidth: c.halfWidth, original: true };
  }),
];

export const originalRoadWidths = roads.map(r => [r.id, r.road_class === 'primary' ? 3.9 : 1.4] as const);
