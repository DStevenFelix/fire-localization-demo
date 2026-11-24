import { intersections, type TrafficSignalController } from '../utils/trafficSignalController';
import { point } from './CityLayers';
import type { SignalColor } from '../types';
import { signalColorLabels, signalDirections, signalMovements } from '../utils/liveTrafficSignals';

const colors: Record<SignalColor, string> = {
  red: '#ff5866', green: '#47ff9b', yellow: '#ffdf5b', off: '#a0aeb3',
  red_flash: '#ff5866', green_flash: '#47ff9b', yellow_flash: '#ffdf5b',
};
const lampHousing = '#10212a';
export default function TrafficSignalLayer({ signals, viewWidth, select }: {
  signals: TrafficSignalController; viewWidth: number; select: (id: string) => void;
}) {
  const size = Math.max(.85, Math.min(2.1, viewWidth / 1313));
  const detail = viewWidth < 2100;
  return <g data-layer="traffic-signals">{intersections.map(intersection => {
    const state = signals.getIntersectionState(intersection.id)!;
    return <g key={intersection.id} data-intersection={intersection.id} data-region={intersection.region} data-emergency-priority={state.emergencyPriority}
      data-hardware-status={state.hardware && (state.hardware.connected ? 'online' : 'offline')}
      role="button" tabIndex={0} aria-label={`路口 ${intersection.id} 信号详情`}
      onClick={event => { event.stopPropagation(); select(intersection.id); }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(intersection.id); } }}>
      {state.emergencyPriority && <circle cx={point(intersection.point).x} cy={point(intersection.point).y} r={14 * size} fill="none" stroke="#f5bf6b" strokeWidth="2" />}
      {intersection.entries.map(entry => {
        const p = point(entry.lamp), color = state.vehicles[entry.id];
        const angle = -Math.atan2(entry.heading[1], entry.heading[0]) * 180 / Math.PI;
        const lenses = state.hardware ? [-5.7, 0, 5.7] : [-3, 3];
        const active = color.startsWith('red') ? lenses[0] : color.startsWith('green') ? lenses.at(-1)
          : color.startsWith('yellow') ? 0 : undefined;
        return <g key={entry.id} transform={`translate(${p.x} ${p.y}) rotate(${angle}) scale(${size})`}
          data-vehicle-signal={entry.id} data-signal-state={color}>
          <circle r="10" fill="transparent"/>
          <rect x={state.hardware ? -9.5 : -7} y="-4.2" width={state.hardware ? 19 : 14} height="8.4"
            rx="4" fill={lampHousing} stroke="#e6f0ec" strokeWidth=".65"/>
          {lenses.map(lens => <circle key={lens} cx={lens}
            r={lens === active ? 2.7 : 2.1} fill={lens === active ? colors[color] : '#415158'}
            stroke={lens === active ? '#fffcee' : 'none'} strokeWidth=".45"/>)}
          {detail && <path aria-hidden="true" d="M-7 9H1V6L8 10.5 1 15V12H-7Z" fill="#72e9ff"
            stroke={lampHousing} strokeWidth="2.2" strokeLinejoin="round" paintOrder="stroke fill"/>}
        </g>;
      })}
      {intersection.crosswalks.flatMap(crossing => crossing.points.map((end, i) => {
        const p = point(end);
        const color = state.pedestrians[crossing.id];
        return <g key={`${crossing.id}:${i}`} transform={`translate(${p.x} ${p.y}) scale(${size})`}
          data-pedestrian-signal={crossing.id} data-signal-end={i} data-signal-state={color} color={colors[color]}>
          <circle r="7" fill={lampHousing} stroke="currentColor" strokeWidth=".8"/>
          <circle cy="-3" r="1.6" fill="currentColor"/>
          <path d="M0 -1V3M-3 1 0 0 3 2M0 3-2 6M0 3 2 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </g>;
      }))}
    </g>;
  })}</g>;
}

export function TrafficSignalDetails({ signals, id, close }: { signals: TrafficSignalController; id: string; close: () => void }) {
  const intersection = intersections.find(i => i.id === id)!;
  const state = signals.getIntersectionState(id)!;
  const direction = (heading: number[]) => Math.abs(heading[0]) > .9 ? heading[0] > 0 ? '西 → 东' : '东 → 西'
    : Math.abs(heading[1]) > .9 ? heading[1] > 0 ? '南 → 北' : '北 → 南' : '其他入口';
  return <aside className="traffic-signal-details" aria-label="路口信号详情" onPointerDown={event => event.stopPropagation()}>
    <div><strong>路口 {id}</strong><button type="button" aria-label="关闭路口详情" onClick={close}>×</button></div>
    {state.hardware ? <>
      <p>{state.hardware.connected ? '实机同步' : '信号机离线 · 保留最后灯色'}</p>
      <dl>{state.hardware.groups.map(({ color, countdown }, index) =>
        <div key={index}><dt>{signalDirections[Math.floor(index / 4)]}进口 · {signalMovements[index % 4]}</dt>
          <dd data-state={color}>{signalColorLabels[color]}{state.hardware!.connected && countdown > 0 ? ` · ${countdown} 秒` : ''}</dd></div>)}</dl>
    </> : <>
      <p>{signals.getMode() === 'emergency_lockdown' ? '应急全红管制' : state.emergencyPriority ? '消防沿线信号优先' : '正常运行'} · {state.phase === 'all_red' ? '全红清空' : state.phase === 'vehicle' ? '机动车通行' : '行人过街'}</p>
      <dl>{intersection.groups.filter(g => g.kind === 'vehicle').map(group => {
      const entries = intersection.entries.filter(e => group.members.includes(e.id));
      return <div key={group.id}><dt>{entries.every(e => !e.lane.road) ? '消防站出口' : [...new Set(entries.map(e => direction(e.heading)))].join(' / ')}</dt>
        <dd data-state={state.vehicles[entries[0].id]}>{state.vehicles[entries[0].id] === 'green' ? '绿灯' : '红灯'}</dd></div>;
    })}
    {intersection.crosswalks.map((c, i) => <div key={c.id}><dt title={c.id}>斑马线 {i + 1} · {c.id}</dt>
      <dd data-state={state.pedestrians[c.id]}>{state.pedestrians[c.id] === 'green' ? '允许过街' : '等待'}</dd></div>)}</dl>
    </>}
  </aside>;
}
