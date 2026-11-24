import { List } from 'lucide-react';
import type { LogEntry } from '../services/dashboardInput';

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export default function DispatchLog({ entries }: { entries: readonly LogEntry[] }) {
  return <section className="log-card" aria-label="智能体调度记录">
    <div className="card-heading"><span><List size={16} /><h2>智能体调度记录</h2></span><span className="tag-muted">{entries.length} 条</span></div>
    <div className="log-body" role="region" aria-label="事件时间线" tabIndex={0}>
      {entries.length ? <ol>{entries.map(entry => <li key={entry.id} data-event-id={entry.id} data-event-type={entry.type}
        data-incident-id={entry.incidentId} data-task-id={entry.taskId} data-device-id={entry.deviceId}>
        <time dateTime={new Date(entry.time).toISOString()}>{timeFormat.format(entry.time)}</time>
        <div><strong>{entry.source}</strong><p>{entry.summary}{[...new Set([entry.incidentId, entry.taskId, entry.deviceId === entry.source ? undefined : entry.deviceId, entry.object])].filter(Boolean).map((value, i) => <small key={i}>{value}</small>)}</p></div>
        <span>{entry.status}</span>
      </li>)}</ol> : <p>等待本轮事件</p>}
    </div>
  </section>;
}
