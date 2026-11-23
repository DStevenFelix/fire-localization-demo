import { useEffect, useState } from 'react';
import { nodes } from '../../../../fire_poi/fire_sandbox_spatial_model.json';
import { original_map_placement } from '../../../../city_scene/city_scene.json';
import type { HardwareSignal, SignalColor } from '../types';
import { crossingNodes, junctionKey } from './trafficSignalGeometry';

// The installation map lists the controllers from east to west on the south
// avenue and from west to east on the north avenue.
export const deviceIntersections = Object.fromEntries([
  ['111', 'J04'], ['112', 'R-02'], ['113', 'J03'],
  ['114', 'J01'], ['115', 'R-01'], ['116', 'J02'],
].map(([suffix, control]) => {
  const local = nodes.find(node => node.id === control)?.center;
  const city = local?.map((value, axis) => value + original_map_placement.offset[axis])
    ?? crossingNodes.find(crossing => crossing.road === control)!.point;
  return [`192.168.1.${suffix}`, junctionKey(city)];
}));

export const signalDirections = ['东', '南', '西', '北'];
export const signalMovements = ['左转', '直行', '右转', '人行'];
export const approachDirection = (x: number, y: number) => Math.abs(x) >= Math.abs(y) ? x >= 0 ? 0 : 2 : y < 0 ? 1 : 3;
const northCrossing = deviceIntersections['192.168.1.115'];

export function pedestrianSignalDirection(intersectionId: string, x: number, y: number) {
  // The single crossing at .115 uses the east/west pedestrian phase. Both groups
  // report the same lamp color in the field capture, so use the east group for both ends.
  return intersectionId === northCrossing ? 0 : approachDirection(x, y);
}

export const signalColorLabels: Record<SignalColor, string> = {
  red: '红灯', green: '绿灯', yellow: '黄灯', off: '灭灯',
  red_flash: '红闪', green_flash: '绿闪', yellow_flash: '黄闪',
};

export type HardwareSignals = Readonly<Record<string, HardwareSignal>>;

export function useLiveTrafficSignals() {
  const [signals, setSignals] = useState<HardwareSignals>({});
  useEffect(() => {
    const source = new EventSource('/api/traffic-signals/stream');
    const disconnected = (previous: HardwareSignals) => Object.fromEntries(
      Object.entries(previous).map(([id, state]) => [id, { ...state, connected: false }]));
    source.onmessage = event => {
      const { devices } = JSON.parse(event.data) as { devices: HardwareSignals };
      setSignals(previous => {
        const next = disconnected(previous);
        for (const [ip, id] of Object.entries(deviceIntersections)) {
          if (devices[ip]?.groups.length === 16) next[id] = devices[ip];
        }
        return next;
      });
    };
    source.onerror = () => setSignals(disconnected);
    return () => source.close();
  }, []);
  return signals;
}
