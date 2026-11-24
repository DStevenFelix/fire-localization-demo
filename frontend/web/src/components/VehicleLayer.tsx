import { memo, useEffect, useRef } from 'react';
import { carIds, TrafficSimulation, type ResetMode, type Severity } from '../utils/trafficSimulation';
import { FULL_VIEW, IMAGE_SIZE, WORLD_SIZE } from '../utils/mapCoordinates';
import { isParkingEntry, type Point } from '../utils/roadNetwork';
import { point } from './CityLayers';
import type { SceneActorSnapshot } from '../types';
import type { EmergencyService } from '../utils/emergency';
import { connectionLabels, deviceStatusLabels, responders, visibleDeviceRoute, type DashboardInput, type Device } from '../services/dashboardInput';

type Props = { simulation: TrafficSimulation; dashboard?: DashboardInput; emergency?: EmergencyService; visible: boolean; target: Point|null; severity: Severity; reset: {mode: ResetMode; version: number}; paused: boolean; speed: number; viewWidth: number; sceneActors: { current: readonly SceneActorSnapshot[] } };
const scale = `scale(${IMAGE_SIZE.width/WORLD_SIZE.width} ${IMAGE_SIZE.height/WORLD_SIZE.height})`;
export const routePoints = (positions: readonly { x: number; y: number }[] | undefined) => positions?.map(position => {
  const pixel = point([position.x, position.y]);
  return `${pixel.x},${pixel.y}`;
}).join(' ') ?? '';
export const deviceQuality = (device: Device) => device.stale ? '定位过期' : device.locatedAt ? '已定位' : '未收到定位';
export const deviceTitle = (device: Device) => `${device.id} · ${connectionLabels[device.connection]} · ${deviceQuality(device)} · ${deviceStatusLabels[device.status]}`;

export const VehicleLayer = memo(function VehicleLayer({simulation,dashboard,emergency,visible,target,severity,reset,paused,speed,viewWidth,sceneActors}:Props) {
  const root=useRef<SVGGElement>(null);
  const trucks = dashboard ? responders.filter(device => device.kind === 'fireTruck') : simulation.trucks;
  const resetVersion=useRef(0);
  const draw=useRef<()=>void>(()=>{});
  useEffect(()=>{
    const sim=simulation;
    const nodes=new Map([...root.current!.querySelectorAll<SVGGElement>('[data-actor]')].map(e=>[e.dataset.actor!,e]));
    const water=new Map([...root.current!.querySelectorAll<SVGGElement>('[data-water-for]')].map(e=>[e.dataset.waterFor!,e]));
    const labels=new Map([...root.current!.querySelectorAll<SVGTextElement>('[data-actor-label]')].map(e=>[e.dataset.actorLabel!,e]));
    const paths=new Map([...root.current!.querySelectorAll<SVGPolylineElement>('[data-truck-path]')].map(e=>[e.dataset.truckPath!,e]));
    const tracks=new Map([...root.current!.querySelectorAll<SVGPolylineElement>('[data-truck-track]')].map(e=>[e.dataset.truckTrack!,e]));
    let last=0, frame=0;
    draw.current=()=>{
      const devices = dashboard?.getSnapshot().devices;
      const actors = devices ? Object.values(devices).map(device => device.waterTarget &&
        (device.stale || !device.locatedAt || device.connection !== 'online') ? { ...device, waterTarget: undefined } : device) :
        [...sim.sceneSnapshot, ...(emergency?.getSceneActors() ?? [])];
      sceneActors.current = actors;
      for(const vehicle of sim.cars) {
        const p=point(vehicle.pose.point), element=nodes.get(vehicle.id)!;
        element.setAttribute('transform',`translate(${p.x} ${p.y}) ${scale} rotate(${-vehicle.pose.angle*180/Math.PI})`);
        element.dataset.x=vehicle.pose.point[0].toFixed(4);element.dataset.y=vehicle.pose.point[1].toFixed(4);
        element.dataset.waitingForSignal=String(Boolean(vehicle.waitingForSignal));
      }
      for (const actor of actors) {
        if (actor.kind !== 'fireTruck') continue;
        const vehicle = sim.trucks.find(truck => truck.id === actor.id);
        const device = devices?.[actor.id];
        const p = point([actor.position.x, actor.position.y]), element = nodes.get(actor.id)!;
        element.setAttribute('transform',`translate(${p.x} ${p.y}) ${scale} rotate(${-actor.heading*180/Math.PI})`);
        element.dataset.x=actor.position.x.toFixed(4);element.dataset.y=actor.position.y.toFixed(4);
        element.dataset.heading=String(actor.heading);
        element.dataset.status=actor.status;
        element.dataset.reversing=vehicle && isParkingEntry(vehicle.cursor.piece)?'parking':'';
        element.dataset.waitingForSignal=String(Boolean(vehicle?.waitingForSignal));
        element.dataset.road=vehicle?.cursor.piece.road??'';
        const label = labels.get(actor.id)!;
        label.setAttribute('transform', `translate(${p.x} ${p.y})`);
        if (device) {
          element.dataset.location = device.locatedAt ? device.stale ? 'stale' : 'tracked' : 'virtual';
          element.dataset.connection = device.connection;
          element.dataset.task = device.task?.id ?? '';
          element.querySelector('title')!.textContent = deviceTitle(device);
          paths.get(actor.id)!.setAttribute('points', routePoints(visibleDeviceRoute(device)));
          tracks.get(actor.id)!.setAttribute('points', '');
        }
        const spray=water.get(actor.id)!;
        const waterTarget = actor.waterTarget;
        if(actor.status === 'extinguishing' && waterTarget) {
          const q=point([waterTarget.x,waterTarget.y]), mx=(p.x+q.x)/2, my=(p.y+q.y)/2;
          const stream=`M${p.x},${p.y} Q${mx},${my-22} ${q.x},${q.y}`;
          spray.setAttribute('visibility','visible');
          for(const path of spray.querySelectorAll('path'))path.setAttribute('d',stream);
        } else spray.setAttribute('visibility','hidden');
      }
    };
    const tick=(now:number)=>{if(last)sim.tick(Math.min((now-last)/1000,.08)*speed);last=now;frame=requestAnimationFrame(tick);};
    const sync=()=>{cancelAnimationFrame(frame);last=0;draw.current();if(!paused&&!document.hidden)frame=requestAnimationFrame(tick);};
    const unsubscribe = sim.subscribe(() => draw.current());
    const unwatch = emergency?.subscribe(() => draw.current());
    const disconnect = dashboard?.subscribe(() => draw.current());
    document.addEventListener('visibilitychange',sync);sync();
    return()=>{cancelAnimationFrame(frame);unsubscribe();unwatch?.();disconnect?.();document.removeEventListener('visibilitychange',sync);sceneActors.current=[];};
  },[paused,speed,sceneActors,simulation,emergency,dashboard]);
  const tx=target?.[0], ty=target?.[1];
  useEffect(()=>{
    if(paused||emergency)return;
    simulation.setIncident(tx===undefined||ty===undefined?null:[tx,ty],severity);draw.current();
  },[tx,ty,severity,paused,simulation,emergency]);
  useEffect(()=>{
    if(paused||reset.version===resetVersion.current)return;
    resetVersion.current=reset.version;
    simulation.reset(reset.mode);draw.current();
  },[reset,paused,simulation]);
  return <g ref={root} pointerEvents="none" display={visible?undefined:'none'}>
    <g data-layer="vehicles">{carIds.map((id,i)=><g key={id} data-actor={id} transform="translate(-100 -100)">
      <rect x="-.64" y="-.25" width="1.28" height=".5" rx=".12" fill={['#e9d3a6','#e4e8e0','#91b9c4','#ca7765'][i%4]} stroke="#263c43" strokeWidth=".025"/>
      <rect x="-.28" y="-.17" width=".62" height=".34" rx=".06" fill="#395764"/>
      <path d="M.55 -.18v.075 M.55 .105v.075" stroke="#ffefbd" strokeWidth=".045"/>
    </g>)}</g>
    <g data-layer="fire-trucks">{trucks.map(({ id },i)=><g key={id}>
      <polyline data-truck-path={id} className="device-route" style={{ stroke: ['#ff8469', '#efbd66', '#57d6c6', '#99c7fd'][i] }} />
      <polyline data-truck-track={id} className="device-track" style={{ stroke: ['#ff8469', '#efbd66', '#57d6c6', '#99c7fd'][i] }} />
      <g data-water-for={id} visibility="hidden"><path className="water-jet-base"/><path className="water-jet"/></g>
    </g>)}
    {trucks.map(({ id },i)=><g key={id} data-actor={id} data-fire-truck={i+1} transform="translate(-100 -100)">
      <title>消防车 {i+1}</title>
      <rect x="-.83" y="-.285" width="1.66" height=".57" rx=".09" fill="#c82034" stroke="#481f25" strokeWidth=".03"/>
      <rect x="-.77" y="-.24" width=".81" height=".48" rx=".045" fill="#f0f2ef"/>
      <rect x=".11" y="-.24" width=".56" height=".48" rx=".055" fill="#ed3d43"/>
      <path d="M.55 -.2 .69 -.15V.15L.55 .2Z" fill="#263b49"/>
      <path d="M-.70 -.10H-.04M-.70 .10H-.04M-.63 -.10V.10M-.47 -.10V.10M-.31 -.10V.10M-.15 -.10V.10" stroke="#7b8b8e" strokeWidth=".035"/>
      <path d="M.78 -.2v.085m0 .23v.085" stroke="#fff2cd" strokeWidth=".06"/>
      <rect x=".19" y="-.21" width=".12" height=".42" rx=".035" fill="#fff4e8"/>
      <g className="fire-beacons"><circle cx=".25" cy="-.16" r=".095"/><circle cx=".25" cy=".16" r=".095"/></g>
    </g>)}
    {trucks.map(({ id },i)=><text key={id} data-actor-label={id} className="device-map-label" fontSize={48 * viewWidth / FULL_VIEW.width} y={-42 * viewWidth / FULL_VIEW.width} textAnchor="middle">{i + 1}</text>)}
    </g>
  </g>;
});
