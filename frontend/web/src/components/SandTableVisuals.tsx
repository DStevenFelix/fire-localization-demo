import { memo } from 'react';
import scene from '../../../../city_scene/city_scene.json';
import { sceneToPixel } from '../utils/mapCoordinates';

const P=(p:number[])=>sceneToPixel({x_m:p[0],y_m:p[1]});
const points=(ps:number[][])=>ps.map(p=>{const q=P(p);return `${q.x},${q.y}`;}).join(' ');
const scale=42;
// 模型照片与材质图只用于表面显示，所有交互、路网和移动路径仍读取独立几何。
export { SandTableDefs } from './SandTableTextures';
function Model({center,width,height,variant,rotation=0}:{center:number[];width:number;height:number;variant:number;rotation?:number}){
  const p=P(center);return <use href={`#physical-model-${variant}`} x={p.x-width/2} y={p.y-height/2} width={width} height={height} transform={rotation?`rotate(${rotation} ${p.x} ${p.y})`:undefined}/>;
}
function Arrow({x,y,angle}:{x:number;y:number;angle:number}){
  return <path d="M-22 -2H8V-8L26 0 8 8V2H-22Z" fill="#f3f2e9" transform={`translate(${x} ${y}) rotate(${angle})`}/>;
}
export const SandTableRoads=memo(function SandTableRoads(){
  const half=3.2*scale/2;
  return <g data-layer="roads" data-material="physical-asphalt">
    {scene.roads.map(r=><polyline key={r.id} points={points(r.centerline.coordinates)} fill="none" stroke="url(#sand-pavement)" strokeWidth={(r.width+2*r.sidewalk_width)*scale}/>)}
    {scene.roads.map(r=><polyline key={r.id} points={points(r.centerline.coordinates)} fill="none" stroke="#74746b" strokeWidth={r.width*scale+6}/>)}
    {scene.roads.map(r=><polyline key={r.id} points={points(r.centerline.coordinates)} fill="none" stroke="url(#sand-asphalt)" strokeWidth={r.width*scale}/>)}
    {scene.roads.map(r=><polyline key={r.id} points={points(r.centerline.coordinates)} fill="none" stroke="#e9cb27" strokeWidth="1.6"/>)}
    {scene.nodes.map(n=>{const p=P(n.center);return <g key={n.id} transform={`translate(${p.x} ${p.y})`}>
      <rect x={-half} y={-half} width={half*2} height={half*2} fill="url(#sand-asphalt)"/>
      {n.edge_ids.length>=3&&[-1,1].flatMap(sx=>[-1,1].map(sy=><g key={`${sx}-${sy}`} transform={`scale(${sx} ${sy})`}>
        <path d={`M${half} ${half}h20Q${half} ${half} ${half} ${half+20}Z`} fill="url(#sand-asphalt)"/>
        <path d={`M${half+20} ${half}Q${half} ${half} ${half} ${half+20}`} stroke="#f4f0dc" strokeWidth="5" fill="none"/>
        <path d={`M${half+21} ${half+5}Q${half+5} ${half+5} ${half+5} ${half+21}`} stroke="#d3b92c" strokeWidth="2" fill="none"/>
      </g>))}
      {n.edge_ids.length>=3&&n.edge_ids.map(id=>{const edge=scene.edges.find(e=>e.id===id)!,other=scene.nodes.find(v=>v.id===(edge.from_node===n.id?edge.to_node:edge.from_node))!,dx=other.center[0]-n.center[0],dy=other.center[1]-n.center[1];
        const angle=dx?dx>0?0:180:dy>0?-90:90;
        return <g key={id} transform={`rotate(${angle})`}>
          {Array.from({length:16},(_,i)=><rect key={i} x={half+13} y={-half+4+i*8} width="25" height="4.2" fill="#f0f0e6"/>)}
          <line x1={half+45} x2={half+45} y1="4" y2={half-5} stroke="#efeee4" strokeWidth="3"/>
        </g>;
      })}
    </g>;})}
    {scene.edges.map(e=>{const [a,b]=e.geometry.coordinates,p=P(a),q=P(b),length=Math.hypot(q.x-p.x,q.y-p.y);if(length<170)return null;
      const angle=Math.atan2(q.y-p.y,q.x-p.x)*180/Math.PI,nx=-(q.y-p.y)/length,ny=(q.x-p.x)/length;
      return <g key={e.id}><Arrow x={p.x+(q.x-p.x)*.37+nx*32} y={p.y+(q.y-p.y)*.37+ny*32} angle={angle}/><Arrow x={p.x+(q.x-p.x)*.63-nx*32} y={p.y+(q.y-p.y)*.63-ny*32} angle={angle+180}/></g>;
    })}
  </g>;
});
export const SandTableBuildings=memo(function SandTableBuildings(){
  const reserve=scene.fire_station_reserve;
  return <g data-layer="buildings" data-material="physical-miniatures">
    {scene.landscape.paths.map((path,i)=><polyline key={i} points={points(path.geometry.coordinates)} stroke="url(#sand-pavement)" strokeWidth={path.width*scale} fill="none"/>)}
    {scene.buildings.map(b=><polygon key={b.id} points={points(b.plot_geometry.coordinates[0])} fill="url(#sand-pavement)" stroke="#c6c8a6" strokeWidth="1"/>)}
    {scene.landscape.flowerbeds.map((p,i)=><Model key={`f${i}`} center={p.center} width={p.size*scale*1.35} height={p.size*scale} variant={p.variant}/>)}
    {scene.landscape.trees.map((p,i)=><Model key={`t${i}`} center={p.center} width={p.size*scale*1.35} height={p.size*scale*1.35} variant={p.variant}/>)}
    {scene.buildings.map(b=>{const ring=b.geometry.coordinates[0],width=(ring[1][0]-ring[0][0])*43.7667,height=(ring[2][1]-ring[1][1])*42;
      return <g key={b.id} data-building={b.id}><Model center={b.center} width={width*1.2} height={height*1.3} variant={b.model_variant}/></g>;
    })}
    <polygon points={points(reserve.geometry.coordinates[0])} fill="url(#sand-pavement)" stroke="#a3a58c" strokeWidth="2"/>
    <polyline points={points([reserve.access.entrance,reserve.access.road_connection])} fill="none" stroke="url(#sand-asphalt)" strokeWidth="42"/>
    {reserve.parking_spaces.map((space,i)=><polygon key={i} points={points(space.geometry.coordinates[0])} fill="url(#sand-asphalt)" stroke="#eee7cc" strokeWidth="2"/>)}
    <text x={P(reserve.center).x} y={P(reserve.center).y-77} className="city-poi-label" textAnchor="middle">消防站预留地 · 3车位</text>
  </g>;
});
