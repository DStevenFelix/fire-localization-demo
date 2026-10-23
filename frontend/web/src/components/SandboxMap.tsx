import { useEffect, useRef, useState } from 'react';
import { Crosshair, Layers, Minus, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { Candidate, Poi, Session } from '../types';
import { DEFAULT_CALIBRATION, IMAGE_SIZE, pixelToWorld, worldToPixel } from '../utils/mapCoordinates';
import baseMap from '../../../../fire_poi/map_original.png';

type Props = { pois: Poi[]; session: Session | null; highlighted: Candidate | null };

export default function SandboxMap({ pois, session, highlighted }: Props) {
  const [showPois, setShowPois] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const calibration = DEFAULT_CALIBRATION;
  const [debug, setDebug] = useState(false);
  const [hover, setHover] = useState<Poi | null>(null);
  const [cursor, setCursor] = useState<{ x_m: number; y_m: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const truth = session?.ground_truth;
  const top1 = session?.status === 'completed' ? session.prediction?.candidates[0] : null;
  const viewWidth = IMAGE_SIZE.width / zoom, viewHeight = IMAGE_SIZE.height / zoom;
  const maxPanX = (IMAGE_SIZE.width-viewWidth)/2, maxPanY = (IMAGE_SIZE.height-viewHeight)/2;
  const viewLeft = maxPanX + Math.max(-maxPanX, Math.min(maxPanX, pan.x)), viewTop = maxPanY + Math.max(-maxPanY, Math.min(maxPanY, pan.y));
  const toPoint = (coordinates: Poi['coordinates']) => worldToPixel(coordinates, calibration);
  const truthPoint = truth ? toPoint(truth.coordinates) : null;
  const predictionPoint = top1 ? toPoint(top1.coordinates) : null;
  const candidatePoint = highlighted && highlighted.rank !== 1 ? toPoint(highlighted.coordinates) : null;

  function resetView() { setZoom(1); setPan({ x: 0, y: 0 }); }

  useEffect(() => {
    const element = svg.current;
    const wheel = (event: WheelEvent) => { event.preventDefault(); setZoom(z => Math.min(3, Math.max(1, z+(event.deltaY < 0 ? .15 : -.15)))); };
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => element?.removeEventListener('wheel', wheel);
  }, []);

  return <section className="map-card" aria-label="火情沙盘地图">
    <div className="map-heading">
      <div><div className="eyebrow">DIGITAL TWIN · SPATIAL LOCALIZATION</div><h2>城市火情空间态势<span className="tag-muted">云港新区</span></h2></div>
      <div className="map-heading-meta"><span className="tiny-dot" />本地米制坐标<span className="divider" />30 × 25 m</div>
    </div>
    <div className="map-canvas" style={{ aspectRatio: `${IMAGE_SIZE.width}/${IMAGE_SIZE.height}` }}>
      <svg ref={svg} viewBox={`${viewLeft} ${viewTop} ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet"
        role="img" aria-label="云港新区沙盘，真实火点与算法预测叠加地图" data-testid="sandbox-svg"
        onPointerDown={event => { if ((event.target as Element).closest('[data-poi]')) return;
          drag.current = { clientX: event.clientX, clientY: event.clientY, ...pan }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }}
        onPointerMove={event => {
          if (drag.current && svg.current) { const box = svg.current.getBoundingClientRect();
            const nextX = drag.current.x-(event.clientX-drag.current.clientX)/box.width*viewWidth;
            const nextY = drag.current.y-(event.clientY-drag.current.clientY)/box.height*viewHeight;
            setPan({ x: Math.max(-(IMAGE_SIZE.width-viewWidth)/2, Math.min((IMAGE_SIZE.width-viewWidth)/2, nextX)),
              y: Math.max(-(IMAGE_SIZE.height-viewHeight)/2, Math.min((IMAGE_SIZE.height-viewHeight)/2, nextY)) }); }
          if (debug && svg.current) { const matrix = svg.current.getScreenCTM(); if (matrix) {
            const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); setCursor(pixelToWorld(p, calibration)); } }
        }}>
        <image href={baseMap} width={IMAGE_SIZE.width} height={IMAGE_SIZE.height} className="base-map" />
        {debug && <g className="calibration-grid" pointerEvents="none">
          <rect x={calibration.left} y={calibration.top} width={calibration.width} height={calibration.height} fill="none" stroke="#e7cf75" strokeWidth="2" />
          {[0, 5, 10, 15, 20, 25, 30].map(x => { const p = toPoint({ x_m: x, y_m: 0 }); return <line key={`x${x}`} x1={p.x} x2={p.x} y1={calibration.top} y2={calibration.top+calibration.height} stroke="#e7cf75" strokeWidth="1" strokeDasharray="6 10" />; })}
          {[0, 5, 10, 15, 20, 25].map(y => { const p = toPoint({ x_m: 0, y_m: y }); return <line key={`y${y}`} x1={calibration.left} x2={calibration.left+calibration.width} y1={p.y} y2={p.y} stroke="#e7cf75" strokeWidth="1" strokeDasharray="6 10" />; })}
        </g>}
        {showPois && pois.filter(p => ['tank', 'building', 'facility'].includes(p.type)).map(poi => { const point = toPoint(poi.coordinates); return <g key={poi.poi_id} data-poi={poi.poi_id}
          tabIndex={0} onMouseEnter={() => setHover(poi)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(poi)} onBlur={() => setHover(null)}
          aria-label={`${poi.name}，坐标 ${poi.coordinates.x_m}，${poi.coordinates.y_m}`}>
          <circle cx={point.x} cy={point.y} r={poi.type === 'tank' ? 5 : 3.5} fill={poi.type === 'tank' ? '#e4b869' : '#c7d5e3'} stroke="#152132" strokeWidth="1.5" className="poi-dot" />
          <circle cx={point.x} cy={point.y} r="11" fill="transparent" />
          <title>{poi.name} · {poi.poi_id} · ({poi.coordinates.x_m}, {poi.coordinates.y_m}) m</title>
        </g>; })}
        {candidatePoint && highlighted && <g data-testid="candidate-marker" pointerEvents="none">
          <circle cx={candidatePoint.x} cy={candidatePoint.y} r="22" fill="none" stroke="#e4b869" strokeWidth="3" strokeDasharray="5 5" />
          <g transform={`translate(${Math.min(IMAGE_SIZE.width-120, candidatePoint.x+35)},${candidatePoint.y+60})`}>
            <rect x="-6" y="-20" width="115" height="31" rx="6" fill="#242c31" fillOpacity=".96" stroke="#e4b869" />
            <text x="51" y="2" textAnchor="middle" className="map-label">候选 #{highlighted.rank}</text>
          </g>
        </g>}
        {truthPoint && truth && <g data-testid="truth-marker" data-poi-id={truth.poi_id} pointerEvents="none">
          <circle cx={truthPoint.x} cy={truthPoint.y} r="11" fill="#222831" stroke="#f1f5f9" strokeWidth="3" />
          <path d={`M ${truthPoint.x} ${truthPoint.y+14} v 25`} stroke="#f1f5f9" strokeWidth="2" />
          <g transform={`translate(${Math.max(90, Math.min(IMAGE_SIZE.width-90, truthPoint.x))},${truthPoint.y+57})`}>
            <rect x="-87" y="-18" width="174" height="32" rx="6" fill="#18212d" fillOpacity=".96" stroke="#91a4b9" strokeWidth="1" />
            <text x="0" y="4" textAnchor="middle" className="map-label truth-label">Ground Truth</text>
          </g>
        </g>}
        {predictionPoint && top1 && <g data-testid="prediction-marker" data-poi-id={top1.poi_id} pointerEvents="none" className="prediction-ring">
          <circle cx={predictionPoint.x} cy={predictionPoint.y} r="22" fill="none" stroke="#ff5a5f" strokeWidth="4" />
          <circle cx={predictionPoint.x} cy={predictionPoint.y} r="32" fill="none" stroke="#ff5a5f" strokeOpacity=".55" strokeWidth="2" className="prediction-breath" />
          <path d={`M ${predictionPoint.x-36} ${predictionPoint.y} h 9 M ${predictionPoint.x+27} ${predictionPoint.y} h 9 M ${predictionPoint.x} ${predictionPoint.y-36} v 9 M ${predictionPoint.x} ${predictionPoint.y+27} v 9`} stroke="#ff5a5f" strokeWidth="2" />
          <path d={`M ${predictionPoint.x} ${predictionPoint.y-38} v -13`} stroke="#ff5a5f" strokeWidth="2" />
          <g transform={`translate(${Math.max(90, Math.min(IMAGE_SIZE.width-90, predictionPoint.x))},${predictionPoint.y-70})`}>
            <rect x="-87" y="-18" width="174" height="32" rx="6" fill="#321c29" fillOpacity=".96" stroke="#ff5a5f" strokeWidth="1.5" />
            <text x="0" y="4" textAnchor="middle" className="map-label prediction-label">AI Prediction</text>
          </g>
        </g>}
      </svg>
      <div className="north-compass" aria-label="地图北向"><span>N</span><span>↑</span></div>
      <div className="map-tools">
        <button className={showPois ? 'icon-button selected' : 'icon-button'} title="显示或隐藏 POI" aria-label="显示或隐藏 POI" aria-pressed={showPois} onClick={() => setShowPois(v => !v)}><Layers size={17} /></button>
        <span className="tool-divider" />
        <button className="icon-button" aria-label="放大地图" onClick={() => setZoom(z => Math.min(3, z+.25))}><Plus size={18} /></button>
        <span className="zoom-level">{zoom.toFixed(2)}×</span>
        <button className="icon-button" aria-label="缩小地图" onClick={() => setZoom(z => Math.max(1, z-.25))}><Minus size={18} /></button>
        <button className="icon-button" aria-label="重置地图视图" onClick={resetView}><RotateCcw size={16} /></button>
        <span className="tool-divider" />
        <button className={debug ? 'icon-button selected' : 'icon-button'} aria-label="坐标网格" aria-expanded={debug} onClick={() => setDebug(v => !v)}><SlidersHorizontal size={17} /></button>
      </div>
      <div className="map-scale" style={{ width: `${calibration.width/30*5/viewWidth*100}%` }}><span /><p>5 m</p></div>
      {hover && <div className="poi-tooltip" role="status"><strong>{hover.name}</strong><span>{hover.poi_id}</span><span>X {hover.coordinates.x_m.toFixed(3)} · Y {hover.coordinates.y_m.toFixed(3)} m</span></div>}
      {debug && <div className="calibration-panel"><strong><Crosshair size={14} /> 坐标网格 · 30 × 25 m</strong>
        <small>{cursor ? `光标 X ${cursor.x_m.toFixed(3)} · Y ${cursor.y_m.toFixed(3)} m` : '移动鼠标查看地图米制坐标'}</small>
        <small>整幅原图映射 · 1 仿真单位 = 1 m</small>
      </div>}
    </div>
    <div className="map-legend"><span><i className="legend-truth" />Ground Truth · 真实火点</span><span><i className="legend-prediction" />AI Prediction · Top1</span><span><i className="legend-poi" />储罐 POI</span><span><i className="legend-node" />建筑 / 节点</span><small>西南原点 · X 向东 · Y 向北</small></div>
  </section>;
}
