import { memo, useEffect, useRef } from 'react';
import { carIds, TrafficSimulation, truckIds, type ResetMode, type Severity } from '../utils/trafficSimulation';
import { SCENE_SIZE, WORLD_SIZE } from '../utils/mapCoordinates';
import type { Point } from '../utils/roadNetwork';
import { point } from './CityLayers';

type Props = { visible: boolean; target: Point|null; severity: Severity; reset: {mode: ResetMode; version: number}; paused: boolean; speed: number };
const scale = `scale(${SCENE_SIZE.width/WORLD_SIZE.width} ${SCENE_SIZE.height/WORLD_SIZE.height})`;
export const VehicleLayer = memo(function VehicleLayer({visible,target,severity,reset,paused,speed}:Props) {
  const root=useRef<SVGGElement>(null);
  const engine=useRef<TrafficSimulation|null>(null);
  const targetRef=useRef<Point|null>(null);
  const resetVersion=useRef(0);
  const draw=useRef<()=>void>(()=>{});
  useEffect(()=>{
    const sim=engine.current??=new TrafficSimulation();
    const nodes=new Map([...root.current!.querySelectorAll<SVGGElement>('[data-actor]')].map(e=>[e.dataset.actor!,e]));
    const water=new Map([...root.current!.querySelectorAll<SVGGElement>('[data-water-for]')].map(e=>[e.dataset.waterFor!,e]));
    let last=0, frame=0;
    draw.current=()=>{
      for(const vehicle of sim.all) {
        const p=point(vehicle.pose.point), element=nodes.get(vehicle.id)!;
        element.setAttribute('transform',`translate(${p.x} ${p.y}) ${scale} rotate(${-vehicle.pose.angle*180/Math.PI})`);
        if(!vehicle.fire)continue;
        element.dataset.status=vehicle.status;
        element.dataset.reversing=vehicle.reversing??'';
        element.dataset.x=vehicle.pose.point[0].toFixed(4);element.dataset.y=vehicle.pose.point[1].toFixed(4);
        element.dataset.road=vehicle.cursor.piece.road??'';
        const spray=water.get(vehicle.id)!;
        if(vehicle.status==='arrived'&&targetRef.current) {
          const q=point(targetRef.current), mx=(p.x+q.x)/2, my=(p.y+q.y)/2;
          const stream=`M${p.x},${p.y} Q${mx},${my-22} ${q.x},${q.y}`;
          spray.setAttribute('visibility','visible');
          for(const path of spray.querySelectorAll('path'))path.setAttribute('d',stream);
        } else spray.setAttribute('visibility','hidden');
      }
    };
    const tick=(now:number)=>{if(last)sim.tick(Math.min((now-last)/1000,.08)*speed);last=now;draw.current();frame=requestAnimationFrame(tick);};
    const sync=()=>{cancelAnimationFrame(frame);last=0;draw.current();if(!paused&&!document.hidden)frame=requestAnimationFrame(tick);};
    document.addEventListener('visibilitychange',sync);sync();
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',sync);};
  },[paused,speed]);
  const tx=target?.[0], ty=target?.[1];
  useEffect(()=>{
    targetRef.current=tx===undefined||ty===undefined?null:[tx,ty];
    engine.current?.setIncident(targetRef.current,severity);draw.current();
  },[tx,ty,severity]);
  useEffect(()=>{
    if(reset.version===resetVersion.current)return;
    resetVersion.current=reset.version;
    engine.current?.reset(reset.mode);draw.current();
  },[reset]);
  return <g ref={root} pointerEvents="none" display={visible?undefined:'none'}>
    <g data-layer="vehicles">{carIds.map((id,i)=><g key={id} data-actor={id} transform="translate(-100 -100)">
      <rect x="-.64" y="-.25" width="1.28" height=".5" rx=".12" fill={['#e9d3a6','#e4e8e0','#91b9c4','#ca7765'][i%4]} stroke="#263c43" strokeWidth=".025"/>
      <rect x="-.28" y="-.17" width=".62" height=".34" rx=".06" fill="#395764"/>
      <path d="M.55 -.18v.075 M.55 .105v.075" stroke="#ffefbd" strokeWidth=".045"/>
    </g>)}</g>
    <g data-layer="fire-trucks">{truckIds.map(id=><g key={id} data-water-for={id} visibility="hidden"><path className="water-jet-base"/><path className="water-jet"/></g>)}
    {truckIds.map((id,i)=><g key={id} data-actor={id} data-fire-truck={i+1} transform="translate(-100 -100)">
      <title>消防车 {i+1}</title>
      <rect x="-.83" y="-.285" width="1.66" height=".57" rx=".09" fill="#c82034" stroke="#481f25" strokeWidth=".03"/>
      <rect x="-.77" y="-.24" width=".81" height=".48" rx=".045" fill="#f0f2ef"/>
      <rect x=".11" y="-.24" width=".56" height=".48" rx=".055" fill="#ed3d43"/>
      <path d="M.55 -.2 .69 -.15V.15L.55 .2Z" fill="#263b49"/>
      <path d="M-.70 -.10H-.04M-.70 .10H-.04M-.63 -.10V.10M-.47 -.10V.10M-.31 -.10V.10M-.15 -.10V.10" stroke="#7b8b8e" strokeWidth=".035"/>
      <path d="M.78 -.2v.085m0 .23v.085" stroke="#fff2cd" strokeWidth=".06"/>
      <rect x=".19" y="-.21" width=".12" height=".42" rx=".035" fill="#fff4e8"/>
      <g className="fire-beacons"><circle cx=".25" cy="-.16" r=".095"/><circle cx=".25" cy=".16" r=".095"/></g>
    </g>)}</g>
  </g>;
});
