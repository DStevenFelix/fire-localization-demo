import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Maximize2, Minus, Pause, Play, Plus, RotateCcw, Truck } from 'lucide-react';
import type { Candidate, Poi, Session } from '../types';
import { clampView, FULL_VIEW, IMAGE_SIZE, ORIGINAL_PLACEMENT, ORIGINAL_VIEW, sceneToPixel, toCity, zoomView, type MapView } from '../utils/mapCoordinates';
import { candidateMarkers, evidenceColor } from '../utils/candidateEvidence';
import { CityBuildings, CityMotion, CityPois, CityRoads } from './CityLayers';
import { SandTableDefs } from './SandTableTextures';
import { VehicleLayer } from './VehicleLayer';
import type { ResetMode, Severity } from '../utils/trafficSimulation';
import type { Point } from '../utils/roadNetwork';
import { fire_station_reserve } from '../../../../city_scene/city_scene.json';
import baseMap from '../../../../fire_poi/map_original.png';

type Props = { pois: Poi[]; session: Session | null; highlighted: Candidate | null };
const layerNames = {roads:'城市道路',buildings:'建筑与设施',pois:'POI',vehicles:'车辆',pedestrians:'行人',prediction:'火灾预测'};
const stationPoint=sceneToPixel({x_m:fire_station_reserve.center[0],y_m:fire_station_reserve.center[1]});
const stationView=zoomView({...ORIGINAL_VIEW,x:stationPoint.x-ORIGINAL_VIEW.width/2,y:stationPoint.y-ORIGINAL_VIEW.height/2},2.1);
export default function SandboxMap({ pois, session, highlighted }: Props) {
  const [layers,setLayers]=useState({roads:true,buildings:true,pois:true,vehicles:true,pedestrians:true,prediction:true});
  const [layerPanel,setLayerPanel]=useState(false);
  const [view,setView]=useState<MapView>(ORIGINAL_VIEW);
  const [hover,setHover]=useState<Poi|null>(null);
  const [info,setInfo]=useState<string|null>(null);
  const [severity,setSeverity]=useState<Severity>(1);
  const [paused,setPaused]=useState(false);
  const [speed,setSpeed]=useState(1);
  const [resetMode,setResetMode]=useState<ResetMode>('garage');
  const [vehicleReset,setVehicleReset]=useState({mode:'garage' as ResetMode,version:0});
  const svg=useRef<SVGSVGElement>(null);
  const drag=useRef<{clientX:number;clientY:number;view:MapView}|null>(null);
  const markers=useMemo(()=>candidateMarkers(session),[session]);
  const showInfo=useCallback((message:string)=>setInfo(message),[]);
  const truth=session?.ground_truth;
  const truthPoint=truth?sceneToPixel(truth.coordinates,'LOCAL30x25'):null;
  const finalTop1=session?.status==='completed'?session.prediction?.candidates.find(c=>c.rank===1):null;
  const finalPoint=finalTop1?sceneToPixel(finalTop1.coordinates,session?.prediction?.coordinate_system??'LOCAL30x25'):null;
  const incident=useMemo<Point|null>(()=>{
    if(!finalTop1)return null;
    const position=toCity(finalTop1.coordinates,session?.prediction?.coordinate_system??'LOCAL30x25');
    return [position.x_m,position.y_m];
  },[finalTop1,session?.prediction?.coordinate_system]);
  const highlightedPoint=highlighted&&highlighted.rank!==1?sceneToPixel(highlighted.coordinates,session?.prediction?.coordinate_system??'LOCAL30x25'):null;
  useEffect(()=>{setInfo(null);},[session?.session_id]);
  useEffect(()=>{
    const element=svg.current;
    const wheel=(event:WheelEvent)=>{event.preventDefault();const matrix=element?.getScreenCTM();if(!matrix)return;
      const anchor=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
      setView(v=>zoomView(v,Math.exp(-event.deltaY*.002),anchor));};
    element?.addEventListener('wheel',wheel,{passive:false});return()=>element?.removeEventListener('wheel',wheel);
  },[]);
  return <section className="map-card" aria-label="火情沙盘地图">
    <div className="map-heading"><div><div className="eyebrow">DIGITAL TWIN · URBAN EMERGENCY</div><h2>城市火情空间态势<span className="tag-muted">云港新区</span></h2></div><div className="map-heading-meta"><span className="tiny-dot"/>城市仿真坐标<span className="divider"/>90 × 75</div></div>
    <div className="dispatch-controls" role="group" aria-label="消防车调度">
      <strong><Truck size={17}/>消防车调度</strong>
      <label>火情等级<select aria-label="火情等级" value={severity} onChange={e=>setSeverity(Number(e.target.value) as Severity)}><option value={1}>小火 · 1 辆</option><option value={2}>中火 · 2 辆</option><option value={3}>大火 · 3 辆</option></select></label>
      <label>消防车位置<select aria-label="消防车位置" value={resetMode} onChange={e=>setResetMode(e.target.value as ResetMode)}><option value="garage">在车位中</option><option value="roads">随机分布在道路上</option></select></label>
      <button type="button" aria-label="重置消防车位置" onClick={()=>setVehicleReset(v=>({mode:resetMode,version:v.version+1}))}><RotateCcw size={14}/>重置</button>
      <button type="button" onClick={()=>setView(stationView)}>查看消防站</button>
      <button type="button" onClick={()=>setPaused(value=>!value)}>{paused?<Play size={14}/>:<Pause size={14}/>} {paused?'继续仿真':'全局暂停'}</button>
      <label>仿真倍速<select value={speed} onChange={event=>setSpeed(Number(event.target.value))}>
        <option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option>
      </select></label>
    </div>
    <div className="map-canvas" style={{aspectRatio:`${IMAGE_SIZE.width}/${IMAGE_SIZE.height}`}}>
      <svg ref={svg} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="云港新区城市地图，真实火点与逐批候选预测" data-testid="sandbox-svg" data-simulation-paused={paused} data-simulation-speed={speed}
        onPointerDown={e=>{if(e.button!==0||(e.target as Element).closest('[data-poi],[data-city-poi],[data-candidate]'))return;drag.current={clientX:e.clientX,clientY:e.clientY,view};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
        onPointerCancel={()=>{drag.current=null;}}
        onPointerMove={e=>{if(!drag.current||!svg.current)return;const box=svg.current.getBoundingClientRect(),d=drag.current;setView(clampView({...d.view,x:d.view.x-(e.clientX-d.clientX)/box.width*d.view.width,y:d.view.y-(e.clientY-d.clientY)/box.height*d.view.height}));}}>
        <SandTableDefs/>
        <rect width={FULL_VIEW.width} height={FULL_VIEW.height} fill="url(#sand-grass)"/>
        {layers.roads&&<CityRoads/>}
        {layers.buildings&&<CityBuildings/>}
        <image href={baseMap} {...ORIGINAL_PLACEMENT} className="base-map" data-layer="original-map"/>
        {layers.pois&&<>
          <CityPois select={showInfo}/>
          <g data-layer="original-pois">{pois.filter(p=>['tank','building','facility'].includes(p.type)).map(poi=>{const p=sceneToPixel(poi.coordinates,'LOCAL30x25');return <g key={poi.poi_id} data-poi={poi.poi_id} tabIndex={0} role="button" aria-label={poi.name} onMouseEnter={()=>setHover(poi)} onMouseLeave={()=>setHover(null)} onFocus={()=>setHover(poi)} onBlur={()=>setHover(null)} onClick={()=>setInfo(`${poi.name} · ${poi.poi_id} · LOCAL30x25 (${poi.coordinates.x_m}, ${poi.coordinates.y_m})`)}>
            <circle cx={p.x} cy={p.y} r={poi.type==='tank'?5:3.5} fill={poi.type==='tank'?'#e4b869':'#d8e5dd'} stroke="#152132" strokeWidth="1.5"/><circle cx={p.x} cy={p.y} r="11" fill="transparent"/><title>{poi.name}</title>
          </g>;})}</g>
        </>}
        <CityMotion pedestrians={layers.pedestrians} paused={paused} speed={speed}/>
        {layers.prediction&&<g data-layer="predictions">{markers.map(marker=>{const c=marker.candidate,p=sceneToPixel(c.coordinates,marker.system),color=evidenceColor(marker.strength,marker.final);return <g key={c.poi_id} data-candidate={c.poi_id} data-testid="evidence-marker" data-strength={marker.strength} data-current={marker.current} data-final={marker.final} tabIndex={0} role="button" aria-label={`${marker.current?'当前':'历史'}候选 ${c.name} 得分 ${c.score} 票数 ${c.votes}`}
          onClick={()=>setInfo(`${marker.current?'当前 Top'+c.rank:'历史候选'} · ${c.name} · 得分 ${c.score.toFixed(3)} · 票数 ${c.votes} · 展示强度不代表概率`)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' ')setInfo(`${c.name} · 得分 ${c.score.toFixed(3)} · 票数 ${c.votes}`);}}>
          <circle cx={p.x} cy={p.y} r="22" fill={color} fillOpacity={marker.current?.65:.2} stroke={color} strokeWidth={marker.current?4:2} strokeDasharray={marker.current?undefined:'5 6'} className="evidence-circle"/>
          <text x={p.x+27} y={p.y+8} fill={color} stroke="#192a34" paintOrder="stroke" strokeWidth="3" fontSize="24" fontWeight="700">{marker.current?`#${c.rank}`:'历史'}</text>
          <title>{c.name} · 得分 {c.score} · 票数 {c.votes}</title>
        </g>;})}</g>}
        {highlightedPoint&&highlighted&&layers.prediction&&<g data-testid="candidate-marker" pointerEvents="none"><circle cx={highlightedPoint.x} cy={highlightedPoint.y} r="31" fill="none" stroke="#f8ce70" strokeWidth="3" strokeDasharray="6 5"/><g transform={`translate(${highlightedPoint.x+95} ${highlightedPoint.y+66})`}><rect x="-65" y="-22" width="130" height="32" rx="5" fill="#1c3037" stroke="#f8ce70"/><text textAnchor="middle" className="map-label">候选 #{highlighted.rank}</text></g></g>}
        {truthPoint&&truth&&<g data-testid="truth-marker" data-poi-id={truth.poi_id} pointerEvents="none"><circle cx={truthPoint.x} cy={truthPoint.y} r="10" fill="#222831" stroke="#f1f5f9" strokeWidth="3"/><path d={`M${truthPoint.x} ${truthPoint.y+14}v25`} stroke="#f1f5f9" strokeWidth="2"/><g transform={`translate(${truthPoint.x} ${truthPoint.y+57})`}><rect x="-87" y="-18" width="174" height="32" rx="6" fill="#18212d" stroke="#91a4b9"/><text textAnchor="middle" y="4" className="map-label truth-label">Ground Truth</text></g></g>}
        {layers.prediction&&finalPoint&&finalTop1&&<g data-testid="prediction-marker" data-poi-id={finalTop1.poi_id} pointerEvents="none"><circle cx={finalPoint.x} cy={finalPoint.y} r="29" fill="none" stroke="#8f132b" strokeWidth="5"/><circle cx={finalPoint.x} cy={finalPoint.y} r="37" fill="none" stroke="#ee786e" strokeWidth="2" className="prediction-breath"/><path d={`M${finalPoint.x-44} ${finalPoint.y}h12 M${finalPoint.x+32} ${finalPoint.y}h12 M${finalPoint.x} ${finalPoint.y-44}v12`} stroke="#8f132b" strokeWidth="3"/><g transform={`translate(${finalPoint.x} ${finalPoint.y-70})`}><rect x="-99" y="-18" width="198" height="32" rx="6" fill="#461f2a" stroke="#ed7779"/><text textAnchor="middle" y="4" className="map-label prediction-label">最终定位 · Top1</text></g></g>}
        <VehicleLayer visible={layers.vehicles} target={incident} severity={severity} reset={vehicleReset} paused={paused} speed={speed}/>
      </svg>
      <div className="north-compass" aria-label="地图北向"><span>N</span><span>↑</span></div>
      <div className="map-tools"><button className="icon-button" aria-label="地图图层" aria-expanded={layerPanel} onClick={()=>setLayerPanel(v=>!v)}><Layers size={17}/></button><span className="tool-divider"/>
        <button className="icon-button" aria-label="放大地图" onClick={()=>setView(v=>zoomView(v,1.25))}><Plus size={18}/></button><span className="zoom-level">{(IMAGE_SIZE.width/view.width).toFixed(2)}×</span><button className="icon-button" aria-label="缩小地图" onClick={()=>setView(v=>zoomView(v,.8))}><Minus size={18}/></button>
        <button className="map-text-button" aria-label="全图" onClick={()=>setView(FULL_VIEW)}><Maximize2 size={14}/>全图</button><button className="map-text-button" aria-label="重置地图视图" onClick={()=>setView(ORIGINAL_VIEW)}><RotateCcw size={14}/>重置视图</button>
      </div>
      {layerPanel&&<div className="map-layer-panel" aria-label="地图图层控制">{Object.entries(layerNames).map(([key,label])=><label key={key}><input type="checkbox" checked={layers[key as keyof typeof layers]} onChange={()=>setLayers(v=>({...v,[key]:!v[key as keyof typeof layers]}))}/>{label}</label>)}</div>}
      <div className="map-scale" style={{width:`${IMAGE_SIZE.width/30*5/view.width*100}%`}}><span/><p>5 仿真单位</p></div>
      {hover&&<div className="poi-tooltip" role="status"><strong>{hover.name}</strong><span>{hover.poi_id}</span><span>局部 X {hover.coordinates.x_m.toFixed(3)} · Y {hover.coordinates.y_m.toFixed(3)}</span></div>}
      {info&&<div className="candidate-info" role="status"><span>{info}</span><button aria-label="关闭地图信息" onClick={()=>setInfo(null)}>×</button></div>}
      <div className="map-progress">{session?.batch_count??0} 批 · {session?.processed_count??0} / {session?.post_count??100} 条</div>
    </div>
    <div className="map-legend"><span><i className="legend-truth"/>真实火点</span><span><i className="legend-prediction"/>当前 Top3 / 最终定位</span><span><i className="legend-history"/>历史候选</span><span className="evidence-legend">弱 <i/> 强</span><small>西南原点 · X 向东 · Y 向北 · 颜色表示证据强度</small></div>
  </section>;
}
