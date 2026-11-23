import { useLayoutEffect, useRef } from 'react';
import { MapPin, X } from 'lucide-react';
import type { Mode, Poi, Session } from '../types';

type Props = {
  scenarios: Poi[];
  targetId: string;
  groundTruth: Session['ground_truth'] | undefined;
  mode: Mode;
  preparing: boolean;
  busy: boolean;
  connected: boolean;
  activeIncident: boolean;
  onTargetChange: (targetId: string) => void;
  onModeChange: (mode: Mode) => void;
  onClose: () => void;
};

export default function SimulationSettingsModal(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  function close() {
    dialog.current?.close();
    props.onClose();
  }

  return <dialog className="simulation-settings" ref={dialog} aria-labelledby="simulation-settings-title"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="simulation-settings-content">
      <div className="simulation-settings-heading">
        <h2 id="simulation-settings-title">仿真设置</h2>
        <button type="button" className="icon-button" aria-label="关闭仿真设置" onClick={close}><X size={18} /></button>
      </div>
      <label className="field-label" htmlFor="scenario">火情场景<span>{props.activeIncident ? '处置中 · 目标锁定' : `${props.scenarios.length} 个储罐`}</span></label>
      <select id="scenario" value={props.targetId} disabled={props.busy || !props.connected || props.activeIncident} onChange={event => props.onTargetChange(event.target.value)}>
        {!props.scenarios.length && <option value="">等待场景加载</option>}
        {props.scenarios.map(poi => <option value={poi.poi_id} key={poi.poi_id}>{poi.name}</option>)}
      </select>
      <div className="ground-truth-box"><MapPin size={16} /><div>
        <small>GROUND TRUTH · 真实着火位置</small>
        <strong>{props.groundTruth?.name ?? (props.preparing ? '正在准备场景…' : '尚未准备')}</strong>
        <span>{props.groundTruth?.poi_id ?? '等待场景准备'}</span>
      </div></div>
      <div className="mode-switch" role="group" aria-label="运行模式">
        <button type="button" className={props.mode === 'offline' ? 'chosen' : ''} disabled={props.busy || props.activeIncident} onClick={() => props.onModeChange('offline')}>Offline <span>离线模拟</span></button>
        <button type="button" className={props.mode === 'live' ? 'chosen live' : ''} disabled={props.busy || props.activeIncident} onClick={() => props.onModeChange('live')}>Live <span>付费模型</span></button>
      </div>
      <p className={`mode-note ${props.mode}`}>{props.mode === 'offline' ? '定位使用本地规则和向量，SocialNet 发帖仍使用模型' : 'SocialNet 发帖及 Chat / Embedding 定位均使用模型'}</p>
    </div>
  </dialog>;
}
