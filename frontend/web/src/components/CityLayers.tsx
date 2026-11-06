import { memo, useEffect, useRef } from 'react';
import poiCatalog from '../../../../city_scene/poi_catalog.json';
import pedestrianAnimation from '../../../../city_scene/pedestrian_animation.json';
import roadsLayer from '../../../../city_scene/assets/sand-table-roads.png';
import buildingsLayer from '../../../../city_scene/assets/sand-table-buildings.png';
import { SCENE_SIZE } from '../utils/mapCoordinates';
import { sceneToPixel } from '../utils/mapCoordinates';

type Geometry = { type: string; coordinates: number[][] | number[][][] };
export const point = (p: number[]) => sceneToPixel({x_m:p[0],y_m:p[1]});
export function geometryPoints(geometry: Geometry) {
  const points = geometry.type === 'Polygon' ? geometry.coordinates[0] as number[][] : geometry.coordinates as number[][];
  return points.map(p=>{const q=point(p); return `${q.x},${q.y}`;}).join(' ');
}
export const CityRoads = memo(function CityRoads(){return <image href={roadsLayer} {...SCENE_SIZE} data-layer="roads" data-material="physical-asphalt" pointerEvents="none"/>;});
export const CityBuildings = memo(function CityBuildings(){return <image href={buildingsLayer} {...SCENE_SIZE} data-layer="buildings" data-material="physical-miniatures" pointerEvents="none"/>;});
export const CityPois = memo(function CityPois({select}:{select:(name:string)=>void}) {
  const information=(p:typeof poiCatalog[number])=>`${p.name} · ${p.id} · 父级 ${poiCatalog.find(parent=>parent.id===p.parent_id)?.name??'城市公共空间'}${p.parent_id?` (${p.parent_id})`:''} · CITY90x75 (${p.center.map(v=>v.toFixed(3)).join(', ')})`;
  return <g data-layer="city-pois">{poiCatalog.map(p=>{const c=point(p.center);return <g key={p.id} data-city-poi={p.id} data-poi-type={p.type} role="button" tabIndex={0} aria-label={p.name} onClick={()=>select(information(p))} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')select(information(p));}}>
    {p.type==='community'?<path d={`M${c.x} ${c.y-8}l7 8-7 8-7-8Z`} fill="#90c6b3" stroke="#284e52"/>:p.type==='entrance'?<rect x={c.x-3} y={c.y-3} width="6" height="6" fill="#d1bd73" stroke="#3b555b"/>:<circle cx={c.x} cy={c.y} r={p.type==='facility'?5:3.5} fill="#e3e7cb" stroke="#3b555b" strokeWidth="1.5"/>}<circle cx={c.x} cy={c.y} r="10" fill="transparent"/><title>{information(p)}</title>
  </g>;})}</g>;
});

// 路径弧长采样与统一时钟驱动所有对象，不触发整个地图的高频 React 重绘。
export function positionOnPath(points: number[][], distance: number) {
  const lengths=points.slice(1).map((p,i)=>Math.hypot(p[0]-points[i][0],p[1]-points[i][1]));
  const total=lengths.reduce((a,b)=>a+b,0);let remaining=((distance%total)+total)%total;
  for(let i=0;i<lengths.length;i++)if(remaining<=lengths[i]){const a=points[i],b=points[i+1],t=lengths[i]?remaining/lengths[i]:0;return {x:a[0]+(b[0]-a[0])*t,y:a[1]+(b[1]-a[1])*t,angle:Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI};}else remaining-=lengths[i];
  return {x:points[0][0],y:points[0][1],angle:0};
}
export function CityMotion({pedestrians,paused,speed}:{pedestrians:boolean;paused:boolean;speed:number}) {
  const root=useRef<SVGGElement>(null);
  const elapsed=useRef(0);
  useEffect(()=>{
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');let frame=0,last=0;
    const nodeMap=new Map(pedestrianAnimation.nodes.map(n=>[n.id,n.center]));
    const moving=pedestrians?pedestrianAnimation.routes.map(r=>({...r,points:r.node_ids.map(id=>nodeMap.get(id)!)})):[];
    const elements=moving.map(r=>({r,element:root.current?.querySelector(`[data-actor="${r.id}"]`),points:r.points}));
    const draw=()=>{for(const {r,element,points} of elements){const distance=elapsed.current*r.speed+r.phase*r.length,p=positionOnPath(points,distance),q=point([p.x,p.y]);element?.setAttribute('transform',`translate(${q.x} ${q.y}) rotate(${-p.angle})`);let rest=distance%r.length,index=0;while(index<points.length-2&&rest>Math.hypot(points[index+1][0]-points[index][0],points[index+1][1]-points[index][1])){rest-=Math.hypot(points[index+1][0]-points[index][0],points[index+1][1]-points[index][1]);index++;}element?.setAttribute('data-edge-id',r.edge_ids[index]);}};
    const tick=(time:number)=>{if(last)elapsed.current+=Math.min((time-last)/1000,.1)*speed;last=time;draw();frame=requestAnimationFrame(tick);};
    const sync=()=>{cancelAnimationFrame(frame);last=0;draw();if(!paused&&!media.matches&&!document.hidden&&pedestrians)frame=requestAnimationFrame(tick);};
    media.addEventListener('change',sync);document.addEventListener('visibilitychange',sync);sync();
    return()=>{cancelAnimationFrame(frame);media.removeEventListener('change',sync);document.removeEventListener('visibilitychange',sync);};
  },[pedestrians,paused,speed]);
  return <g ref={root} pointerEvents="none">
    {pedestrians&&<g data-layer="pedestrians">{pedestrianAnimation.routes.map((r,i)=><g key={r.id} data-actor={r.id} data-pedestrian-route={r.id}><ellipse rx="3" ry="4" fill={['#ebc698','#a2b8d0','#c39ca4'][i%3]} stroke="#294343" strokeWidth=".8"/><circle cx="0" cy="0" r="2" fill="#ead9b9"/></g>)}</g>}
  </g>;
}
