import { connectDashboardSource, type InputResult } from './dashboardInput';
import { tabletopCalibration } from '../utils/deviceCoordinates';

const topics: Readonly<Record<string, string>> = {
  source: 'source.connection', link: 'device.connection', fix: 'device.telemetry', plan: 'device.route',
  task: 'device.task', dispatch: 'agent.event', camera: 'media.feed', candidate: 'recon.candidate', confirmation: 'recon.confirmed',
};

// 这个函数使用内存传输，便于联调人员在浏览器中验证原始消息到实际界面的整条路径。
export function connectExampleDashboardSource() {
  let deliver: ((packet: unknown) => InputResult) | undefined;
  const disconnect = connectDashboardSource(receive => {
    deliver = receive;
    return () => { deliver = undefined; };
  }, raw => {
    if (!raw || typeof raw !== 'object' || !('topic' in raw) || typeof raw.topic !== 'string' ||
      !Object.hasOwn(topics, raw.topic) || !('serial' in raw) || typeof raw.serial !== 'string' ||
      !('sampled' in raw) || !('body' in raw) || !raw.body || typeof raw.body !== 'object') {
      throw new RangeError('示例传输消息格式无效');
    }
    const body = raw.body;
    const payload = raw.topic === 'fix' ? {
      ...body,
      position: { x: 'east' in body ? body.east : undefined, y: 'north' in body ? body.north : undefined },
      headingRadians: 'yaw' in body && typeof body.yaw === 'number' ? body.yaw * Math.PI / 180 : undefined,
      coordinateSystem: tabletopCalibration.sourceCoordinateSystem,
      calibrationVersion: 'calibration' in body ? body.calibration : tabletopCalibration.version,
    } : body;
    return { sourceMode: 'physical', eventId: `example:${raw.serial}`, occurredAt: raw.sampled,
      incidentId: 'incident' in raw ? raw.incident : undefined, eventType: topics[raw.topic], payload };
  }, {
    idMap: { 'rig-1': 'EXT-FIRE-VEHICLE-01', 'rig-2': 'EXT-FIRE-VEHICLE-02',
      'rig-3': 'EXT-FIRE-VEHICLE-03', 'rig-4': 'EXT-FIRE-VEHICLE-04', 'aircraft-1': 'DRONE-01', 'aircraft-2': 'DRONE-02' },
    calibrations: [tabletopCalibration],
  });
  return {
    disconnect,
    publish: (packet: unknown): InputResult => deliver?.(packet) ?? { accepted: false, error: '示例传输未订阅' },
  };
}
