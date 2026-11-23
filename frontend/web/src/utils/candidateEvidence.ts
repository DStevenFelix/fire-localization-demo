import type { Candidate, Session } from '../types';
import type { CoordinateSystem } from './mapCoordinates';

export type EvidenceMarker = { candidate: Candidate; strength: number; current: boolean; final: boolean; system: CoordinateSystem };
// 采用固定的票数/得分尺度，避免每批归一化使首批直接饱和；只表示展示强度。
export function evidenceStrength(candidate: Candidate): number {
  return Math.min(1, Math.max(0, Math.max(candidate.votes, candidate.score)) / 70);
}
export function evidenceColor(strength: number, final = false): string {
  if (final) return '#8f132b';
  const stops = [[255,222,151],[244,147,55],[222,69,48],[153,28,41]];
  const value = Math.min(.9999, Math.max(0,strength))*3;
  const index = Math.floor(value), t = value-index;
  return `rgb(${stops[index].map((n,i) => Math.round(n+(stops[index+1][i]-n)*t)).join(',')})`;
}
export function candidateMarkers(session: Session | null): EvidenceMarker[] {
  if (!session) return [];
  const markers = new Map<string,EvidenceMarker>();
  const predictions = [...(session.batch_history ?? []).map(b=>b.prediction), ...(session.prediction?[session.prediction]:[])];
  for (const prediction of predictions) for (const candidate of prediction.candidates) {
    const previous = markers.get(candidate.poi_id);
    markers.set(candidate.poi_id,{candidate,strength:Math.max(previous?.strength??0,evidenceStrength(candidate)),current:false,final:false,system:prediction.coordinate_system??'LOCAL30x25'});
  }
  for (const candidate of session.prediction?.candidates ?? []) {
    const marker = markers.get(candidate.poi_id)!;
    marker.current = true; marker.candidate = candidate;
    marker.final = (session.status === 'completed' || session.analysis_frozen === true) && candidate.rank === 1;
  }
  return [...markers.values()];
}
