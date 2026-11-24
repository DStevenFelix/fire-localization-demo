import { useEffect, useRef } from 'react';
import { FULL_VIEW, IMAGE_SIZE, WORLD_SIZE } from '../utils/mapCoordinates';
import { point } from './CityLayers';
import { droneStatusLabels, type EmergencyService } from '../utils/emergency';
import type { TrafficSimulation } from '../utils/trafficSimulation';
import { drone_station } from '../../../../city_scene/fire_resources.json';
import { responders, visibleDeviceRoute, type DashboardInput } from '../services/dashboardInput';
import { deviceTitle, routePoints } from './VehicleLayer';

export default function DroneLayer({ emergency, traffic, dashboard, viewWidth }: {
  emergency?: EmergencyService; traffic: TrafficSimulation; dashboard?: DashboardInput; viewWidth: number;
}) {
  const root = useRef<SVGGElement>(null);
  const roster = responders.filter(device => device.kind === 'drone');
  useEffect(() => {
    const nodes = new Map([...root.current!.querySelectorAll<SVGGElement>('[data-drone]')].map(node => [node.dataset.drone!, node]));
    const routes = new Map([...root.current!.querySelectorAll<SVGPolylineElement>('[data-drone-path]')].map(node => [node.dataset.dronePath!, node]));
    const tracks = new Map([...root.current!.querySelectorAll<SVGPolylineElement>('[data-drone-track]')].map(node => [node.dataset.droneTrack!, node]));
    const labels = new Map([...root.current!.querySelectorAll<SVGTextElement>('[data-drone-label]')].map(node => [node.dataset.droneLabel!, node]));
    const draw = () => {
      for (const id of nodes.keys()) {
        const device = dashboard?.getSnapshot().devices[id];
        const legacy = emergency?.getDrone(id);
        const drone = device ?? legacy;
        if (!drone) continue;
        routes.get(id)!.setAttribute('points', routePoints(device ? visibleDeviceRoute(device) : legacy?.status !== 'returning' ? legacy?.path : undefined));
        tracks.get(id)!.setAttribute('points', '');
        const node = nodes.get(id)!, p = point([drone.position.x, drone.position.y]);
        node.setAttribute('transform', `translate(${p.x} ${p.y}) scale(${IMAGE_SIZE.width / WORLD_SIZE.width} ${IMAGE_SIZE.height / WORLD_SIZE.height}) rotate(${-drone.heading * 180 / Math.PI})`);
        labels.get(id)!.setAttribute('transform', `translate(${p.x} ${p.y})`);
        node.dataset.x = String(drone.position.x); node.dataset.y = String(drone.position.y);
        node.dataset.heading = String(drone.heading); node.dataset.altitude = String(drone.altitude ?? 0); node.dataset.status = drone.status;
        if (device) {
          node.dataset.location = device.locatedAt ? device.stale ? 'stale' : 'tracked' : 'virtual';
          node.dataset.connection = device.connection;
          node.dataset.task = device.task?.id ?? '';
          node.dataset.altitudeMeters = String(device.altitudeMeters ?? '');
          node.querySelector('title')!.textContent = deviceTitle(device);
        } else if (legacy) node.querySelector('title')!.textContent = `${id} · ${droneStatusLabels[legacy.status]}`;
      }
    };
    const unsubscribe = dashboard ? dashboard.subscribe(draw) : traffic.subscribe(draw);
    const unwatch = dashboard ? undefined : emergency?.subscribe(draw);
    draw();
    return () => { unsubscribe(); unwatch?.(); };
  }, [emergency, traffic, dashboard]);
  return <g ref={root} data-layer="drones" pointerEvents="none">
    <g data-drone-station={drone_station.poi_id} data-x={drone_station.center[0]} data-y={drone_station.center[1]}>
      <polygon points={drone_station.geometry.coordinates[0].map(p => { const q = point(p); return `${q.x},${q.y}`; }).join(' ')} fill="#254b51" stroke="#9cddcf" strokeWidth="2" />
      {drone_station.bays.map(bay => { const p = point(bay.center); return <g key={bay.drone_id} data-drone-bay={bay.drone_id} transform={`translate(${p.x} ${p.y})`}>
        <circle r="31" fill="#326068" stroke="#8fd4c6" strokeWidth="2" />
        <path d="M-10 -15V15M10 -15V15M-10 0H10" stroke="#c6e5da" strokeWidth="4" />
      </g>; })}
      <text x={point(drone_station.center).x} y={point(drone_station.center).y + 77} textAnchor="middle" fontSize="18" fill="#d5eee5" stroke="#183b43" paintOrder="stroke" strokeWidth="4">消防无人机站</text>
    </g>
    <g data-layer="drone-routes">{roster.map((drone, index) => {
      const color = index === 0 ? '#75e0e3' : '#f6c974';
      return <g key={drone.id}>
        <polyline data-drone-path={drone.id} className="device-route" stroke={color} />
        <polyline data-drone-track={drone.id} className="device-track" stroke={color} />
      </g>;
    })}</g>
    {roster.map((drone, index) => <g key={drone.id}>
      <g data-drone={drone.id}>
        <title>{drone.id}</title>
        <circle r=".72" fill="#0c3643" fillOpacity=".38" />
        <path d="M-.45 -.45 .45 .45 M-.45 .45 .45 -.45" stroke="#082732" strokeWidth=".2" />
        <path d="M-.45 -.45 .45 .45 M-.45 .45 .45 -.45" stroke="#98f3f0" strokeWidth=".09" />
        {[-.45, .45].flatMap(x => [-.45, .45].map(y => <circle key={`${x}:${y}`} cx={x} cy={y} r=".22" fill="#133f4b" stroke="#b8ffff" strokeWidth=".06" />))}
        <rect x="-.22" y="-.16" width=".44" height=".32" rx=".1" fill="#75e0e3" stroke="#0b3641" strokeWidth=".04" />
        <path d="M.29 -.12 .48 0 .29 .12" fill="#fff0b8" />
      </g>
      <text data-drone-label={drone.id} className="device-map-label" fontSize={44 * viewWidth / FULL_VIEW.width}
        x={59 * viewWidth / FULL_VIEW.width} y={index === 0 ? 31 : -30} textAnchor="middle">D{index + 1}</text>
    </g>)}
  </g>;
}
