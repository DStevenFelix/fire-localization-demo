// Adapted from the upstream SandboxMap: the city layers and dispatch run locally in the browser.
// The host supplies fire truth, prediction, selection and the shared CITY90x75 viewport.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fire_station_reserve } from '../../../city_scene/city_scene.json';
import type { SceneMap } from '../main';
import type { Candidate, Entity, Point, SceneData } from '../types';
import { SCENE_SIZE, ORIGINAL_PLACEMENT, worldToPixel } from '../utils/mapCoordinates';
import { evidenceColor, type EvidenceMarker } from '../utils/candidateEvidence';
import type { ResetMode, Severity } from '../utils/trafficSimulation';
import DispatchControls, { type Layer, type LayersState } from './DispatchControls';
import { CityBuildings, CityMotion, CityRoads } from './CityLayers';
import { VehicleLayer } from './VehicleLayer';

const initialLayers: LayersState = {
  roads: true, buildings: true, pois: true, vehicles: true, pedestrians: true, prediction: true,
};
const station = {x: fire_station_reserve.center[0], y: fire_station_reserve.center[1]};
const point = (p: Point) => worldToPixel({x_m: p.x, y_m: p.y});

function path(points: Point[], closed = true) {
  return points.map((vertex, i) => {
    const pixel = point(vertex);
    return `${i ? 'L' : 'M'}${pixel.x},${pixel.y}`;
  }).join(' ') + (closed ? ' Z' : '');
}

type Props = {
  controller: SceneMap; data: SceneData | null; markers: EvidenceMarker[]; target: Candidate | null;
};

export default function SandboxMap({controller, data, markers, target}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{x: number; y: number; pan: Point; moved: boolean} | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [layers, setLayers] = useState(initialLayers);
  const [severity, setSeverity] = useState<Severity>(1);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [resetMode, setResetMode] = useState<ResetMode>('garage');
  const [reset, setReset] = useState({mode: 'garage' as ResetMode, version: 0});
  const [targetPoint, setTargetPoint] = useState<HTMLElement | null>(null);

  const zoom = controller.zoom;
  const viewWidth = SCENE_SIZE.width / zoom;
  const viewHeight = SCENE_SIZE.height / zoom;
  const left = (SCENE_SIZE.width - viewWidth) / 2 + controller.pan.x;
  const top = (SCENE_SIZE.height - viewHeight) / 2 + controller.pan.y;
  const entities = data?.entities ?? [];
  const pois = entities.filter(entity => !['area', 'road'].includes(entity.kind));
  const areas = entities.filter(entity => entity.kind === 'area' && entity.id !== 'A-CITY')
    .sort((a, b) => b.width * b.height - a.width * a.height);

  useEffect(() => {
    setTargetPoint(document.getElementById('map-motion-controls'));
    const element = svg.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const anchor = controller.screenPoint(event) ?? undefined;
      controller.setZoom(controller.zoom * Math.exp(-event.deltaY * .002), anchor);
    };
    element?.addEventListener('wheel', wheel, {passive: false});
    return () => element?.removeEventListener('wheel', wheel);
  }, [controller]);

  // Publish the new viewport after React applies it, so the host can re-anchor its inspector.
  useEffect(() => {
    controller.container.dispatchEvent(new Event('map-view-change'));
  }, [left, top, zoom, controller]);

  function select(id: string, event: React.MouseEvent, fire = false) {
    if (drag.current?.moved) return;
    const anchor = controller.screenPoint(event);
    if (fire) controller.selectFire(id, anchor);
    else controller.select(id, false, anchor);
  }

  function outline(entity: Entity) {
    const polygons = entity.geometry.polygons?.length ? entity.geometry.polygons : [entity.geometry.points];
    const active = hover === entity.id || controller.selectedId === entity.id;
    return <path d={polygons.map(vertices => path(vertices)).join(' ')}
      fill={active ? '#20ae9d' : 'transparent'} fillOpacity={active ? .18 : 0}
      stroke={active ? '#08756f' : controller.showAreas ? '#3d6e6644' : 'transparent'}
      strokeWidth={active ? 2 : 1} vectorEffect="non-scaling-stroke"/>;
  }

  function toggleLayer(layer: Layer) {
    setLayers(previous => ({...previous, [layer]: !previous[layer]}));
  }

  return <>
    {targetPoint && createPortal(<DispatchControls layers={layers} toggleLayer={toggleLayer}
      severity={severity} setSeverity={setSeverity} resetMode={resetMode} setResetMode={setResetMode}
      resetVehicles={() => setReset(previous => ({mode: resetMode, version: previous.version + 1}))}
      focusStation={() => controller.focus(station)} paused={paused} togglePaused={() => setPaused(value => !value)}
      speed={speed} setSpeed={setSpeed} target={target}/>, targetPoint)}
    <svg ref={svg} className="map-react-svg" data-testid="sandbox-svg"
      viewBox={`${left} ${top} ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet"
      role="group" aria-label="云港新区动态地图" tabIndex={0}
      data-simulation-paused={paused} data-simulation-speed={speed}
      data-dispatch-target={target?.poi_id ?? ''}
      onPointerDown={event => {
        if (event.button !== 0) return;
        drag.current = {x: event.clientX, y: event.clientY, pan: {...controller.pan}, moved: false};
        if (!(event.target as Element).closest('[data-id], [data-fire-id], [data-map-candidate]')) {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || !svg.current) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) start.moved = true;
        if (!start.moved) return;
        const box = svg.current.getBoundingClientRect();
        controller.setPan({x: start.pan.x - dx / box.width * viewWidth, y: start.pan.y - dy / box.height * viewHeight});
      }}
      onPointerUp={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
      onClick={event => {
        if (!(event.target as Element).closest('[data-id], [data-fire-id], [data-map-candidate]') && !drag.current?.moved) {
          controller.select(null);
        }
        drag.current = null;
      }}>
      <defs>
        <filter id="source-glow"><feGaussianBlur stdDeviation="1.5"/></filter>
        <pattern id="city-grass" width="160" height="160" patternUnits="userSpaceOnUse">
          <rect width="160" height="160" fill="#8ca66d"/>
          <image href="/city-assets/physical-material-atlas.png" x="-320" y="0" width="480" height="160" opacity=".4"/>
        </pattern>
      </defs>
      <rect width={SCENE_SIZE.width} height={SCENE_SIZE.height} fill="url(#city-grass)"/>
      {layers.roads && <CityRoads/>}
      {layers.buildings && <CityBuildings/>}
      <image href={data?.map.image_url ?? '/map-assets/map_original.png'} {...ORIGINAL_PLACEMENT} data-testid="map-image"/>
      {layers.pois && <>
        {areas.map(entity => <g key={entity.id} data-id={entity.id} tabIndex={0} role="button" aria-label={entity.name}
          onMouseEnter={() => setHover(entity.id)} onMouseLeave={() => setHover(null)}
          onClick={event => select(entity.id, event)}
          onKeyDown={event => { if (event.key === 'Enter') controller.select(entity.id, true); }}>
          {outline(entity)}<title>{entity.name}</title>
        </g>)}
        {entities.filter(entity => entity.kind === 'road').map(entity => <path key={entity.id} data-id={entity.id}
          d={path(entity.path, false)} stroke="transparent" strokeWidth="18" fill="none"
          onClick={event => select(entity.id, event)}><title>{entity.name}</title></path>)}
        {pois.map(entity => {
          const p = point(entity.position);
          return <g key={entity.id} data-id={entity.id} tabIndex={0} role="button" aria-label={entity.name}
            onMouseEnter={() => setHover(entity.id)} onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(entity.id)} onBlur={() => setHover(null)}
            onClick={event => select(entity.id, event)}
            onKeyDown={event => { if (event.key === 'Enter') controller.select(entity.id, true); }}>
            {outline(entity)}
            <circle cx={p.x} cy={p.y} r="10" fill="transparent"/>
            {controller.showPois && <>
              <circle cx={p.x} cy={p.y} r={entity.kind === 'tank' ? 5 : 3.5}
                fill={entity.kind === 'tank' ? '#c37c23' : '#08756f'} stroke="white" strokeWidth="1.5"/>
              {(zoom >= 3 || controller.selectedId === entity.id) &&
                <text x={p.x + 8} y={p.y - 9} className="spatial-poi-label">{entity.id}</text>}
            </>}
            <title>{entity.name} · {entity.id}</title>
          </g>;
        })}
      </>}
      <CityMotion pedestrians={layers.pedestrians} paused={paused} speed={speed}/>
      <VehicleLayer visible={layers.vehicles} target={target ? [target.coordinates.x_m, target.coordinates.y_m] : null}
        severity={severity} reset={reset} paused={paused} speed={speed}/>
      {layers.prediction && <g data-layer="predictions">{markers.map(({candidate, strength, current}) => {
        const p = worldToPixel(candidate.coordinates);
        const top1 = current && candidate.rank === 1;
        const color = evidenceColor(strength, top1);
        const label = current ? `预测 #${candidate.rank}` : '历史';
        return <g key={candidate.poi_id} data-map-candidate={candidate.poi_id} data-current={current}
          data-testid={top1 ? 'prediction-marker' : current ? 'candidate-marker' : 'historical-candidate-marker'}
          data-poi-id={candidate.poi_id} tabIndex={0} role="button" aria-label={`${label} ${candidate.name}`}
          onClick={event => select(candidate.poi_id, event)} opacity={current ? 1 : .42}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              controller.select(candidate.poi_id, true);
            }
          }}>
          <circle cx={p.x} cy={p.y} r={top1 ? 33 : 27} stroke={color} strokeWidth={top1 ? 5 : 3}
            pointerEvents="stroke" fill="none" strokeDasharray={current ? undefined : '6 4'}/>
          <text x={p.x} y={p.y - 42} className="spatial-prediction-label" style={{fill: color}}>{label}</text>
          <title>{candidate.name} · 得分 {candidate.score} · 票数 {candidate.votes}</title>
        </g>;
      })}</g>}
      {data?.fires.map(fire => {
        const p = point(fire.position);
        return <g key={fire.id} data-fire-id={fire.id} tabIndex={0} role="button" aria-label={`真实火源 ${fire.id}`}
          onClick={event => select(fire.id, event, true)}
          onKeyDown={event => { if (event.key === 'Enter') controller.selectFire(fire.id); }}>
          <circle cx={p.x} cy={p.y} r="24" fill="#e9551733" filter="url(#source-glow)"/>
          {[-9, 0, 10].map((offset, i) => <g key={offset} transform={`translate(${p.x + offset},${p.y + (i === 1 ? -3 : 5)})`}>
            <path d="M0,-17 C9,-5 12,0 8,7 C4,15 -8,12 -9,4 C-10,-2 -3,-8 0,-17Z"
              fill="#ed5e23" fillOpacity=".85" filter="url(#source-glow)"/>
            <path d="M0,-8 C6,0 6,8 0,8 C-5,8 -4,2 0,-8Z" fill="#ffdc71"/>
          </g>)}
          <title>真实火源 · 强度 {fire.intensity}/5</title>
        </g>;
      })}
      <g pointerEvents="none" transform={`translate(${left + viewWidth - 35 / zoom},${top + 35 / zoom}) scale(${1 / zoom})`}>
        <text textAnchor="middle" fontSize="15" fill="#123331">N</text>
        <path d="M0,7 L-7,23 L0,20 L7,23Z" fill="#123331"/>
      </g>
    </svg>
  </>;
}
