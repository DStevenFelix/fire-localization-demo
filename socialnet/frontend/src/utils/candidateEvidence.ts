// Upstream evidence colors are a display scale. Dispatch eligibility comes from the socialnet snapshot.
import type { Candidate, SceneData } from '../types';

export type EvidenceMarker = { candidate: Candidate; strength: number; current: boolean };

// Same fixed simulation epoch as app/localization.py. Wall time does not age evidence.
const SIMULATION_EPOCH = Date.parse('2000-01-01T08:00:00+08:00');
const MINUTE_MS = 60_000;

export function evidenceStrength(candidate: Candidate): number {
  return Math.min(1, Math.max(0, Math.max(candidate.votes, candidate.score)) / 70);
}

export function evidenceColor(strength: number, currentTop1 = false): string {
  if (currentTop1) return '#8f132b';
  const stops = [[255, 222, 151], [244, 147, 55], [222, 69, 48], [153, 28, 41]];
  const value = Math.min(.9999, Math.max(0, strength)) * 3;
  const index = Math.floor(value);
  const fraction = value - index;
  return `rgb(${stops[index].map((stop, i) => Math.round(stop + (stops[index + 1][i] - stop) * fraction)).join(',')})`;
}

export function updateEvidence(history: Map<string, EvidenceMarker>, data: SceneData): Candidate | null {
  const { localization } = data;
  const prediction = localization.prediction;
  const now = SIMULATION_EPOCH + data.simulation_minute * MINUTE_MS;
  const liveClusterIds = new Set(localization.clusters
    .filter(cluster => !cluster.cold &&
      now - Date.parse(cluster.last_timestamp) < localization.cold_minutes * MINUTE_MS)
    .map(cluster => cluster.id));
  for (const marker of history.values()) marker.current = false;

  // Both the current locator and the legacy city migration publish CITY coordinates.
  if (prediction?.coordinate_system !== 'CITY90x75') return null;

  let target: Candidate | null = null;
  const usable = localization.status !== 'failed' && !localization.resume_pending;
  const knownTanks = new Set(data.entities.filter(entity => entity.kind === 'tank').map(entity => entity.id));
  for (const candidate of prediction.candidates) {
    const {x_m, y_m} = candidate.coordinates;
    if (!knownTanks.has(candidate.poi_id) ||
        !Number.isFinite(x_m) || !Number.isFinite(y_m) ||
        x_m < 0 || x_m > 90 || y_m < 0 || y_m > 75) continue;

    const current = usable && (candidate.cluster_ids ?? []).some(id => liveClusterIds.has(id));
    const strength = Math.max(history.get(candidate.poi_id)?.strength ?? 0, evidenceStrength(candidate));
    history.set(candidate.poi_id, { candidate, strength, current });
    if (current && candidate.rank === 1) target = candidate;
  }
  return target;
}
