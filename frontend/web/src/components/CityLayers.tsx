import { memo, useEffect, useRef } from 'react';
import poiCatalog from '../../../../city_scene/poi_catalog.json';
import { pedestrianIds } from '../utils/pedestrianSimulation';
import type { TrafficSimulation } from '../utils/trafficSimulation';
import roadsLayer from '../../../../city_scene/assets/sand-table-roads.png';
import buildingsLayer from '../../../../city_scene/assets/sand-table-buildings.png';
import scene from '../../../../city_scene/city_scene.json';
import emergencyConfig from '../config/emergency.json';
import { SCENE_SIZE } from '../utils/mapCoordinates';
import { sceneToPixel } from '../utils/mapCoordinates';

type Geometry = { type: string; coordinates: number[][] | number[][][] };
export const point = (p: number[]) => sceneToPixel({x_m:p[0],y_m:p[1]});
export function geometryPoints(geometry: Geometry) {
  const points = geometry.type === 'Polygon' ? geometry.coordinates[0] as number[][] : geometry.coordinates as number[][];
  return points.map(p=>{const q=point(p); return `${q.x},${q.y}`;}).join(' ');
}
export const CityRoads = memo(function CityRoads() {
  return <g data-layer="roads" data-material="physical-asphalt" pointerEvents="none">
    <image href={roadsLayer} {...SCENE_SIZE}/>
    {scene.roads.filter(road => road.original_connection).map(road => {
      const start = point(road.centerline.coordinates[0]);
      const end = point(road.centerline.coordinates[1]);
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
      // 原图原生像素量测的路面半宽，接驳段沿既有中心线收至扩展路宽。
      const sourceHalf = end.x === start.x ? 74 : 67.5;
      const half = road.width * 42 / 2;
      const sidewalk = road.sidewalk_width * 42;
      // 与静态道路相同的路口尺度，在停止线前结束，保留完整斑马线与停止线。
      const join = Math.min(length / 2, length - half - 48);
      const outer = Math.max(sourceHalf + 12, half + sidewalk);
      return <g key={road.id} data-road-seam={road.id} transform={`translate(${start.x} ${start.y}) rotate(${angle})`}>
        <defs><clipPath id={`seam-${road.id}`}>
          <rect x="0" y={-outer} width={join} height={outer * 2}/>
        </clipPath></defs>
        {/* 局部 x 正向始终朝原图外侧，裁剪也约束描边，原图最后完整覆盖其内侧。 */}
        <g clipPath={`url(#seam-${road.id})`}>
          <rect x="0" y={-outer} width={join} height={outer * 2} fill="url(#sand-grass)"/>
          <polygon points={`0,${-sourceHalf - 12} ${join},${-half - sidewalk} ${join},${half + sidewalk} 0,${sourceHalf + 12}`} fill="url(#sand-pavement)"/>
          <polygon points={`0,${-sourceHalf} ${join},${-half} ${join},${half} 0,${sourceHalf}`} fill="url(#sand-asphalt)"/>
          {[-1, 1].map(side => <g key={side}>
            <path d={`M0 ${side * sourceHalf}L${join} ${side * half}`} fill="none" stroke="#eeeade" strokeWidth="2.5"/>
            <path d={`M0 ${side * (sourceHalf + 11)}L${join} ${side * (half + 5)}`} fill="none" stroke="#e9cb27" strokeWidth="1.6"/>
          </g>)}
          <path d={`M0 0H${join}`} stroke="#e9cb27" strokeWidth="1.6"/>
          {/* 同位置重放被局部路面替换的原扩展箭头，方向和车道偏移沿用静态层。 */}
          {length >= 170 && <>
            <path d="M-22 -2H8V-8L26 0 8 8V2H-22Z" fill="#f3f2e9" transform={`translate(${length * .37} 32)`}/>
            <path d="M-22 -2H8V-8L26 0 8 8V2H-22Z" fill="#f3f2e9" transform={`translate(${length * .63} -32) rotate(180)`}/>
          </>}
        </g>
      </g>;
    })}
  </g>;
});
export const CityBuildings = memo(function CityBuildings({ mockParking = false }: { mockParking?: boolean }) {
  return <g data-layer="buildings" data-material="physical-miniatures" pointerEvents="none">
    <image href={buildingsLayer} {...SCENE_SIZE} />
    {mockParking && <g data-fire-station="EXT-P-FIRE">
      <title>消防站 · 四个仿真泊位</title>
      <polygon points={geometryPoints(scene.fire_station_reserve.geometry)} fill="url(#sand-asphalt)" stroke="#dbdfcd" strokeWidth="2" />
      {emergencyConfig.trucks.map((truck, index) => {
        const [x, y] = truck.mockBay;
        const p = point([x - .52, y + 1.03]), q = point([x + .52, y - 1.05]);
        return <g key={truck.id} data-fire-bay={truck.id} data-x={x} data-y={y}>
          <rect x={p.x} y={p.y} width={q.x - p.x} height={q.y - p.y} rx="2" fill="#283b3f" stroke="#f0e5b9" strokeWidth="2" />
          <text x={(p.x + q.x) / 2} y={q.y - 3} textAnchor="middle" fontSize="13" fill="#f0e5b9">{index + 1}</text>
        </g>;
      })}
      <g transform={`translate(${point([20, 17.94]).x} ${point([20, 17.94]).y})`}>
        <rect x="-83" y="-10" width="166" height="21" rx="3" fill="#243a40" />
        <text textAnchor="middle" y="4" fontSize="13" fill="#f1e8c4">消防站 · 四个仿真泊位</text>
      </g>
    </g>}
  </g>;
});
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
export function CityMotion({pedestrians,simulation}:{pedestrians:boolean;simulation:TrafficSimulation}) {
  const root=useRef<SVGGElement>(null);
  useEffect(()=>{
    const elements = new Map([...root.current!.querySelectorAll<SVGGElement>('[data-actor]')].map(e => [e.dataset.actor!, e]));
    const draw = () => simulation.pedestrians.actors.forEach(actor => {
      const element = elements.get(actor.id);
      if (!element) return;
      const q = point(actor.point);
      element.setAttribute('transform', `translate(${q.x} ${q.y}) rotate(${-actor.angle})`);
      element.dataset.edgeId = actor.route.segments[actor.index].id;
      element.dataset.waitingForSignal = String(actor.waiting);
      element.dataset.x = actor.point[0].toFixed(4); element.dataset.y = actor.point[1].toFixed(4);
    });
    draw(); return simulation.subscribe(draw);
  },[pedestrians,simulation]);
  return <g ref={root} pointerEvents="none">
    {pedestrians&&<g data-layer="pedestrians">{pedestrianIds.map((id,i)=><g key={id} data-actor={id} data-pedestrian-route={id}><ellipse rx="3" ry="4" fill={['#ebc698','#a2b8d0','#c39ca4'][i%3]} stroke="#294343" strokeWidth=".8"/><circle cx="0" cy="0" r="2" fill="#ead9b9"/></g>)}</g>}
  </g>;
}
