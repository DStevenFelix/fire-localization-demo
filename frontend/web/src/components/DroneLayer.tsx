import { useEffect, useRef } from 'react';
import { IMAGE_SIZE, WORLD_SIZE } from '../utils/mapCoordinates';
import { point } from './CityLayers';
import { droneStatusLabels, type EmergencyService } from '../utils/emergency';
import type { TrafficSimulation } from '../utils/trafficSimulation';
import { drone_station } from '../../../../city_scene/fire_resources.json';

export default function DroneLayer({ emergency, traffic }: { emergency: EmergencyService; traffic: TrafficSimulation }) {
  const root = useRef<SVGGElement>(null);
  useEffect(() => {
    const nodes = new Map([...root.current!.querySelectorAll<SVGGElement>('[data-drone]')].map(node => [node.dataset.drone!, node]));
    const routes = new Map([...root.current!.querySelectorAll<SVGPolylineElement>('[data-drone-path]')].map(node => [node.dataset.dronePath!, node]));
    const draw = () => emergency.getSnapshot().drones.forEach(drone => {
      const route = routes.get(drone.id)!;
      route.setAttribute('points', drone.path?.map(position => {
        const p = point([position.x, position.y]);
        return `${p.x},${p.y}`;
      }).join(' ') ?? '');
      const node = nodes.get(drone.id)!, p = point([drone.position.x, drone.position.y]);
      node.setAttribute('transform', `translate(${p.x} ${p.y}) scale(${IMAGE_SIZE.width / WORLD_SIZE.width} ${IMAGE_SIZE.height / WORLD_SIZE.height}) rotate(${-drone.heading * 180 / Math.PI})`);
      node.dataset.x = String(drone.position.x); node.dataset.y = String(drone.position.y);
      node.dataset.heading = String(drone.heading); node.dataset.altitude = String(drone.altitude); node.dataset.status = drone.status;
      node.querySelector('title')!.textContent = `${drone.id} · ${droneStatusLabels[drone.status]}`;
    });
    draw();
    const unsubscribe = traffic.subscribe(draw), unwatch = emergency.subscribe(draw);
    return () => { unsubscribe(); unwatch(); };
  }, [emergency, traffic]);
  return <g ref={root} data-layer="drones" pointerEvents="none">
    <g data-drone-station={drone_station.poi_id} data-x={drone_station.center[0]} data-y={drone_station.center[1]}>
      <polygon points={drone_station.geometry.coordinates[0].map(p => { const q = point(p); return `${q.x},${q.y}`; }).join(' ')} fill="#254b51" stroke="#9cddcf" strokeWidth="2" />
      {drone_station.bays.map(bay => { const p = point(bay.center); return <g key={bay.drone_id} data-drone-bay={bay.drone_id} transform={`translate(${p.x} ${p.y})`}>
        <circle r="31" fill="#326068" stroke="#8fd4c6" strokeWidth="2" />
        <path d="M-10 -15V15M10 -15V15M-10 0H10" stroke="#c6e5da" strokeWidth="4" />
      </g>; })}
      <text x={point(drone_station.center).x} y={point(drone_station.center).y + 77} textAnchor="middle" fontSize="18" fill="#d5eee5" stroke="#183b43" paintOrder="stroke" strokeWidth="4">消防无人机站</text>
    </g>
    <g data-layer="drone-routes" fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke">{emergency.getSnapshot().drones.map((drone, index) =>
      <polyline key={drone.id} data-drone-path={drone.id} stroke={index === 0 ? '#75e0e3' : '#f6c974'} strokeDasharray={index === 0 ? undefined : '8 5'} vectorEffect="non-scaling-stroke" />)}</g>
    {emergency.getSnapshot().drones.map(drone =>
    <g key={drone.id} data-drone={drone.id}>
      <title>{drone.id}</title>
      <circle r=".72" fill="#0c3643" fillOpacity=".38" />
      <path d="M-.45 -.45 .45 .45 M-.45 .45 .45 -.45" stroke="#082732" strokeWidth=".2" />
      <path d="M-.45 -.45 .45 .45 M-.45 .45 .45 -.45" stroke="#98f3f0" strokeWidth=".09" />
      {[-.45, .45].flatMap(x => [-.45, .45].map(y => <circle key={`${x}:${y}`} cx={x} cy={y} r=".22" fill="#133f4b" stroke="#b8ffff" strokeWidth=".06" />))}
      <rect x="-.22" y="-.16" width=".44" height=".32" rx=".1" fill="#75e0e3" stroke="#0b3641" strokeWidth=".04" />
      <path d="M.29 -.12 .48 0 .29 .12" fill="#fff0b8" />
    </g>)}</g>;
}
