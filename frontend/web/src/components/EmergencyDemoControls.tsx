import { useState } from 'react';
import type { Candidate, FireSceneSeverity, Session } from '../types';
import { severityLabels } from '../utils/emergency';
import type { EmergencyDemo } from '../utils/emergencyDemo';

type Props = {
  demo: EmergencyDemo;
  handoff?: { sessionId: string; groundTruth: Session['ground_truth']; candidates: readonly Candidate[] };
  active: boolean;
  pending: boolean;
};

export default function EmergencyDemoControls({ demo, handoff, active, pending }: Props) {
  const [applied, setApplied] = useState(demo.getSeverity());
  const [draft, setDraft] = useState(applied);
  const [error, setError] = useState<string>();
  const dirty = draft !== applied;
  const perform = (action: () => void) => {
    try { action(); setError(undefined); }
    catch (error) { setError(error instanceof Error ? error.message : '操作失败，请重试'); }
  };

  return <div className="emergency-demo-controls" aria-label="演示参数">
    <label htmlFor="demo-severity">模拟火情等级</label>
    <div className="emergency-demo-settings">
      <select id="demo-severity" value={draft} onChange={event => setDraft(Number(event.target.value) as FireSceneSeverity)}>
        {([1, 2, 3] as const).map(level => <option key={level} value={level}>{severityLabels[level]} · {level} 辆消防车</option>)}
      </select>
      <button type="button" className="secondary-button" disabled={!dirty || pending}
        onClick={() => perform(() => { demo.applySettings(draft); setApplied(draft); })}>确认设置</button>
    </div>
    <p role="status">已生效：{severityLabels[applied]}{dirty ? ' · 有待确认修改' : ''}</p>
    {handoff && !active && !demo.hasStarted(handoff.sessionId) ? <>
      <p>按候选排名巡查，最后到真实火点 · {handoff.groundTruth.name}</p>
      <button type="button" className="primary-button" disabled={dirty || pending}
        onClick={() => perform(() => demo.start(handoff.sessionId, handoff.groundTruth.poi_id, handoff.candidates))}>移交应急处置</button>
    </> : !active && !handoff && <p>完成帖子定位并获得 Top1 后，可移交应急处置。</p>}
    <button type="button" className="secondary-button" disabled={!demo.canConfirmExtinction()}
      onClick={() => perform(() => demo.confirmExtinction())}>确认已灭火</button>
    {error && <p className="emergency-error" role="alert">{error}</p>}
  </div>;
}
