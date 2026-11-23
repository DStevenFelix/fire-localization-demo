import { memo, useEffect, useRef } from 'react';
import pedestrianAnimation from '../../../city_scene/pedestrian_animation.json';
import { SCENE_SIZE, worldToPixel } from '../utils/mapCoordinates';

export const point = (p: number[]) => worldToPixel({x_m:p[0],y_m:p[1]});

export const CityRoads = memo(function CityRoads() {
  return <image href="/city-assets/sand-table-roads.png" {...SCENE_SIZE} data-layer="city-roads" pointerEvents="none"/>;
});

export const CityBuildings = memo(function CityBuildings() {
  return <image href="/city-assets/sand-table-buildings.png" {...SCENE_SIZE}
    data-layer="city-buildings" pointerEvents="none"/>;
});

const nodes = new Map(pedestrianAnimation.nodes.map(node => [node.id, node.center]));
const walkers = pedestrianAnimation.routes.map(route => {
  const vertices = route.node_ids.map(id => nodes.get(id)!);
  const segments = vertices.slice(1).map((end, index) => {
    const start = vertices[index];
    const dx = end[0] - start[0], dy = end[1] - start[1];
    return {start, dx, dy, length: Math.hypot(dx, dy), angle: -Math.atan2(dy, dx) * 180 / Math.PI};
  });
  return {route, segments, length: segments.reduce((sum, segment) => sum + segment.length, 0)};
});
const pedestrianColors = ['#ebc698', '#a2b8d0', '#c39ca4'];

// Cache segment geometry and update glyphs at most 30 times per second for the full walking layer.
export const CityMotion = memo(function CityMotion(
  {pedestrians, paused, speed}: {pedestrians: boolean; paused: boolean; speed: number},
) {
  const root = useRef<SVGGElement>(null);
  const elapsed = useRef(0);

  useEffect(() => {
    if (!pedestrians || !root.current) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const elements = [...root.current.querySelectorAll<SVGGElement>('[data-actor]')];
    let frame = 0, last = 0;

    function draw() {
      for (const [index, {route, segments, length}] of walkers.entries()) {
        const element = elements[index];
        if (!length) continue;
        let remaining = (elapsed.current * route.speed + route.phase * route.length) % length;
        let segmentIndex = 0;
        while (segmentIndex < segments.length - 1 && remaining > segments[segmentIndex].length) {
          remaining -= segments[segmentIndex++].length;
        }
        const segment = segments[segmentIndex];
        const fraction = segment.length ? remaining / segment.length : 0;
        const position = point([segment.start[0] + segment.dx * fraction, segment.start[1] + segment.dy * fraction]);
        element.setAttribute('transform', `translate(${position.x.toFixed(2)} ${position.y.toFixed(2)}) rotate(${segment.angle.toFixed(2)})`);
        const edge = route.edge_ids[segmentIndex];
        if (element.dataset.edgeId !== edge) element.dataset.edgeId = edge;
      }
    }

    function tick(time: number) {
      if (!last) last = time;
      const delta = time - last;
      if (delta >= 1000 / 30) {
        elapsed.current += Math.min(delta / 1000, .1) * speed;
        last = time;
        draw();
      }
      frame = requestAnimationFrame(tick);
    }

    function sync() {
      cancelAnimationFrame(frame);
      last = 0;
      draw();
      if (!paused && !media.matches && !document.hidden) frame = requestAnimationFrame(tick);
    }

    media.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [pedestrians, paused, speed]);

  if (!pedestrians) return null;
  return <g ref={root} data-layer="pedestrians" pointerEvents="none">
    {walkers.map(({route}, index) => <g key={route.id} data-actor={route.id} data-pedestrian-route={route.id}>
      <ellipse rx="3" ry="4" fill={pedestrianColors[index % pedestrianColors.length]} stroke="#294343" strokeWidth=".8"/>
      <circle r="2" fill="#ead9b9"/>
    </g>)}
  </g>;
});
