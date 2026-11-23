import { Layers, Pause, Play, RotateCcw, Truck } from 'lucide-react';

import type { Candidate } from '../types';
import type { ResetMode, Severity } from '../utils/trafficSimulation';

export const layerLabels = {
  roads: '道路', buildings: '建筑', pois: 'POI', vehicles: '车辆', pedestrians: '行人', prediction: '预测',
};
export type Layer = keyof typeof layerLabels;
export type LayersState = Record<Layer, boolean>;

type Props = {
  layers: LayersState;
  toggleLayer: (layer: Layer) => void;
  severity: Severity;
  setSeverity: (value: Severity) => void;
  resetMode: ResetMode;
  setResetMode: (value: ResetMode) => void;
  resetVehicles: () => void;
  focusStation: () => void;
  paused: boolean;
  togglePaused: () => void;
  speed: number;
  setSpeed: (value: number) => void;
  target: Candidate | null;
};

export default function DispatchControls(props: Props) {
  return <div className="dispatch-controls" role="group" aria-label="地图动画和消防车调度">
    <strong><Truck size={16} aria-hidden="true"/>消防车调度</strong>
    <span className="dispatch-target" role="status">
      {props.target ? `预测 Top 1 · ${props.target.name}` : '等待有效定位'}
    </span>
    <label>火情等级<select aria-label="消防车火情等级" value={props.severity}
      onChange={event => props.setSeverity(Number(event.target.value) as Severity)}>
      <option value={1}>小火 · 1 辆</option><option value={2}>中火 · 2 辆</option><option value={3}>大火 · 3 辆</option>
    </select></label>
    <label>重置位置<select aria-label="消防车重置位置" value={props.resetMode}
      onChange={event => props.setResetMode(event.target.value as ResetMode)}>
      <option value="garage">消防站车位</option><option value="roads">道路随机位置</option>
    </select></label>
    <button type="button" onClick={props.resetVehicles}><RotateCcw size={14} aria-hidden="true"/>重置消防车</button>
    <button type="button" onClick={props.focusStation}>查看消防站</button>
    <button type="button" onClick={props.togglePaused}>
      {props.paused ? <Play size={14} aria-hidden="true"/> : <Pause size={14} aria-hidden="true"/>}
      {props.paused ? '继续地图动画' : '暂停地图动画'}
    </button>
    <label>动画倍速<select aria-label="地图动画倍速" value={props.speed}
      onChange={event => props.setSpeed(Number(event.target.value))}>
      <option value={.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option>
    </select></label>
    <details className="dispatch-layers">
      <summary><Layers size={14} aria-hidden="true"/>地图图层</summary>
      <div>{(Object.keys(layerLabels) as Layer[]).map(layer =>
        <label key={layer}><input type="checkbox" checked={props.layers[layer]}
          onChange={() => props.toggleLayer(layer)}/>{layerLabels[layer]}</label>)}</div>
    </details>
  </div>;
}
