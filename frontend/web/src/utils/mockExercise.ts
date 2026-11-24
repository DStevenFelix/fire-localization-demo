import type { OpinionPost, Poi, Prediction, Session } from '../types';
import { DashboardInput, mediaSlots, type DashboardMessage } from '../services/dashboardInput';
import { phaseLabels, type EmergencyService } from './emergency';
import type { EmergencyDemo } from './emergencyDemo';
import config from '../config/emergency.json';
import { normalizePrediction, poiRegistry } from './poiRegistry';
import { pose } from './roadNetwork';

// Evidence fixtures are separate from the world state displayed on the map.
const worldFire = 'T-NW-01';
const mockEvidence = [
  ['T-NW-02', 'T-NW-02', 'T-NE-01', 'T-NE-01', 'T-NW-01'],
  ['T-NW-02', 'T-NW-01', 'T-NW-01'],
];
export function observeSimulatedWorld(firePoiId: string) {
  return (candidatePoiId: string) => candidatePoiId === firePoiId ?
    { confirmedFirePoiId: candidatePoiId, result: '模拟现场观测：发现火点' } :
    { result: '模拟现场观测：未发现火点' };
}
export const localPois: Poi[] = [...poiRegistry.values()].filter(poi => poi.coordinate_system === 'LOCAL30x25').map(poi => ({
  poi_id: poi.id, name: poi.name, type: ({ Tank: 'tank', Building: 'building', Facility: 'facility' })[poi.type] ?? poi.type.toLowerCase(),
  coordinates: { x_m: poi.center[0], y_m: poi.center[1] }, can_post: poi.can_post,
}));

export function prepareMockSession(): Session {
  return { session_id: `mock:${crypto.randomUUID()}`, mode: 'offline', seed: 42, status: 'prepared',
    target_poi_id: worldFire, ground_truth: localPois.find(poi => poi.poi_id === worldFire)!,
    prediction: null, evaluation: null, post_count: 0, processed_count: 0, ignored_count: 0, batch_count: 0,
    batch_history: [], error: null, created_at: new Date().toISOString(), started_at: null, completed_at: null };
}

type ScopedMessage<T = DashboardMessage> = T extends DashboardMessage ? Omit<T, 'eventId' | 'occurredAt' | 'sourceMode' | 'sessionId'> : never;

export function connectSimulatedResponders(input: DashboardInput, service: EmergencyService) {
  const { traffic } = service;
  const lastRoutes = new Map<string, { path: unknown; stop?: number }>();
  const lastTasks = new Map<string, string>();
  let sequence = 0, previousPhase: string | undefined;
  const send = (message: ScopedMessage) => input.consume({ ...message, sourceMode: 'simulation',
    occurredAt: Date.now(), eventId: `responders:${++sequence}` });
  const draw = () => input.batch(() => {
    const incident = service.getSnapshot().incident;
    if (incident && incident.phase !== previousPhase) {
      previousPhase = incident.phase;
      send({ eventType: 'agent.event', incidentId: incident.id, payload: { agent: 'dispatch', type: '处置阶段',
        phase: phaseLabels[incident.phase], summary: incident.assessment?.status === 'completed' ? incident.assessment.result : phaseLabels[incident.phase] } });
    }
    const actors = [...traffic.sceneSnapshot, ...service.getSnapshot().drones.map(drone => ({ ...drone, kind: 'drone' as const }))];
    for (const actor of actors) {
      const current = input.getSnapshot().devices[actor.id];
      const water = actor.kind === 'fireTruck' && actor.status === 'extinguishing' ? actor.waterTarget : undefined;
      const waterChanged = current.waterTarget?.x !== water?.x || current.waterTarget?.y !== water?.y;
      if (!current.locatedAt || actor.status !== current.status || actor.position.x !== current.position.x || waterChanged ||
        actor.position.y !== current.position.y || actor.heading !== current.heading || 'altitude' in actor && actor.altitude !== current.altitude) {
        send({ eventType: 'device.telemetry', payload: { deviceId: actor.id, kind: actor.kind,
          coordinateSystem: 'CITY90x75', position: actor.position, headingRadians: actor.heading, status: actor.status,
          ...('altitude' in actor && { renderAltitude: actor.altitude }),
          waterTarget: water } });
      }
      if (!incident || !incident.droneIds.length) continue;
      const truck = traffic.trucks.find(truck => truck.id === actor.id);
      const drone = service.getDrone(actor.id);
      const assigned = truck ? incident.confirmed && (incident.plan?.dispatches.some(dispatch => dispatch.vehicleId === actor.id) || current.task?.incidentId === incident.id) :
        incident.droneIds.includes(actor.id);
      if (!assigned) continue;
      const taskId = `${incident.id}:${actor.id}`;
      const result = drone && incident.observedIds.includes(drone.id) ? '模拟侦察反馈已收到' : undefined;
      const phase = drone?.status === 'observing' && incident.observedIds.includes(drone.id) ? '火场观察中' :
        devicePhase(actor.status, incident.phase === 'completed');
      const taskKey = `${taskId}:${phase}:${result}`;
      if (lastTasks.get(actor.id) !== taskKey) {
        lastTasks.set(actor.id, taskKey);
        send({ eventType: 'device.task', incidentId: incident.id, payload: { deviceId: actor.id, taskId, phase, result } });
      }
      const path = truck?.path ?? drone?.path;
      const stop = truck?.stop;
      const previous = lastRoutes.get(actor.id);
      if (previous?.path !== path || previous?.stop !== stop) {
        lastRoutes.set(actor.id, { path, stop });
        const route = truck && ['en-route', 'returning'].includes(truck.status) ? truck.path.slice(truck.index).flatMap((piece, index, remaining) => {
          const start = index === 0 ? truck.cursor.distance : 0;
          const end = index === remaining.length - 1 ? truck.stop : piece.length;
          if (end < start) return [];
          const points = [pose({ piece, distance: start }).point,
            ...piece.points.filter((_, i) => piece.cumulative[i] > start && piece.cumulative[i] < end),
            pose({ piece, distance: end }).point];
          return points.map(([x, y]) => ({ x, y }));
        }) : drone?.path ?? [];
        send({ eventType: 'device.route', incidentId: incident.id, payload: { deviceId: actor.id, taskId, route,
          coordinateSystem: 'CITY90x75', purpose: ['returning', 'return-waiting'].includes(actor.status) ? 'return' : 'outbound' } });
      }
    }
  });
  draw();
  const unwatch = service.subscribe(draw);
  const untick = traffic.subscribe(draw);
  return () => { unwatch(); untick(); };
}

function devicePhase(status: string, completed: boolean) {
  if (completed) return '处置完成';
  const phases: Readonly<Record<string, string>> = { idle: '待命', 'en-route': '前往火场', arrived: '抵达火场',
    extinguishing: '灭火作业', flying: '巡查飞行', observing: '侦察反馈', returning: '返回中', charging: '已返航' };
  return phases[status] ?? status;
}

export function runMockExercise(
  prepared: Session, count: number, input: DashboardInput, service: EmergencyService, demo: EmergencyDemo,
  onSession: (session: Session) => void, onPost: (post: OpinionPost) => void,
) {
  let session = { ...prepared, status: 'running' as Session['status'], started_at: new Date().toISOString() };
  let sequence = 0, elapsed = 0, spraying = 0, batch = 0;
  const votes = new Map<string, number>();
  const send = (message: ScopedMessage) => input.consume({ ...message, sourceMode: 'simulation', sessionId: session.session_id,
    eventId: `${session.session_id}:${++sequence}`, occurredAt: Date.now() });
  onSession(session);
  send({ eventType: 'source.connection', payload: { sourceId: '演练场景', state: 'online' } });
  const updateMedia = (status: 'connecting' | 'disconnected') => {
    for (const slot of mediaSlots) {
      if (input.getSnapshot().media[slot.id] && status === 'disconnected' && !input.getSnapshot().media[slot.id].feedId.startsWith('mock:')) continue;
      send({ eventType: 'media.feed', payload: { slotId: slot.id, feedId: `mock:${slot.id}`, kind: slot.kind, status } });
    }
  };
  updateMedia('connecting');
  send({ eventType: 'agent.event', payload: { agent: 'opinion', type: '监测启动', phase: '监测中', summary: '等待模拟火情帖' } });
  send({ eventType: 'agent.event', payload: { agent: 'location', type: '定位启动', phase: '等待线索', summary: '等待首批证据' } });
  const unsubscribe = service.traffic.subscribe(seconds => {
    elapsed += seconds;
    if (batch < mockEvidence.length && elapsed >= 2.5 * (batch + 1)) {
      const evidence = mockEvidence[batch];
      evidence.forEach((id, i) => {
        const poi = localPois.find(poi => poi.poi_id === id)!;
        votes.set(id, (votes.get(id) ?? 0) + 1);
        const post = { id: `演练-${batch + 1}-${i + 1}`, text: `${poi.name}附近有人报告浓烟，需核实火源。`,
          timestamp: new Date().toISOString(), urgency: '高' as const };
        onPost(post);
        send({ eventType: 'agent.event', payload: { agent: 'opinion', type: '收到帖子', phase: '监测中', summary: post.text, object: post.id } });
      });
      const processed = session.post_count + evidence.length;
      const prediction: Prediction = normalizePrediction({ candidates: [...votes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, count], i, ranked) => ({
        ...localPois.find(poi => poi.poi_id === id)!, rank: i + 1, votes: count, confidence: count / processed, score: count, relative_score: count / ranked[0][1],
      })), processed_count: processed, pending_count: 0, active_cluster_count: votes.size, cold_cluster_count: 0, status: 'mock' });
      session = { ...session, post_count: processed, processed_count: processed, batch_count: ++batch, prediction,
        batch_history: [...session.batch_history!, { batch_number: batch, processed_count: processed, ignored_count: 0, prediction }] };
      if (batch === mockEvidence.length) {
        const hit = prediction.candidates.find(candidate => candidate.poi_id === worldFire);
        session = { ...session, analysis_frozen: true, evaluation: {
          top1_hit: hit?.rank === 1, top3_hit: !!hit, target_rank: hit?.rank ?? null, distance_m: null,
        } };
      }
      onSession(session);
      send({ eventType: 'agent.event', payload: { agent: 'location', type: '候选更新',
        phase: session.analysis_frozen ? '定位完成' : '得到候选', summary: `第 ${batch} 批 · Top1 ${prediction.candidates[0].name}` } });
      if (session.analysis_frozen) demo.start(session.session_id, prediction.candidates, observeSimulatedWorld(worldFire), count);
    }
    const incident = service.getSnapshot().incident;
    if (incident?.phase === 'extinguishing' && incident.plan?.dispatches.every(dispatch =>
      service.traffic.sceneSnapshot.some(actor => actor.id === dispatch.vehicleId && actor.waterTarget))) {
      spraying += seconds;
      if (spraying >= config.mockSuppressionSeconds) demo.confirmExtinction();
    } else spraying = 0;
    if (incident?.phase !== 'completed') return;
    onSession({ ...session, status: 'completed', completed_at: new Date().toISOString() });
    send({ eventType: 'agent.event', payload: { agent: 'opinion', type: '监测结束', phase: '已完成', summary: '本轮演练结束' } });
    updateMedia('disconnected');
    unsubscribe();
  }, 'update');
  return unsubscribe;
}
