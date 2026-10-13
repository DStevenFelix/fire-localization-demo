export type Mode = 'offline' | 'live';
export type Coordinates = { x_m: number; y_m: number };
export type Poi = { poi_id: string; name: string; type: string; coordinates: Coordinates; can_post: boolean };
export type Candidate = Poi & { rank: number; votes: number; confidence: number; score: number; relative_score: number };
export type Prediction = {
  candidates: Candidate[]; processed_count: number; pending_count: number;
  active_cluster_count: number; cold_cluster_count: number; status: string; current_time: string;
};
export type Session = {
  session_id: string; mode: Mode; status: 'prepared' | 'running' | 'completed' | 'failed';
  target_poi_id: string; seed: number; post_count: number; ground_truth: Pick<Poi, 'poi_id' | 'name' | 'coordinates'>;
  prediction: Prediction | null;
  evaluation: { top1_hit: boolean; top3_hit: boolean; target_rank: number | null; distance_m: number | null } | null;
  processed_count: number; ignored_count: number; batch_count: number;
  error: { error_type: string; message: string } | null;
  created_at: string; started_at: string | null; completed_at: string | null;
};
export type Health = { status: string; algorithm: string; default_mode: Mode; live_requires_confirmation: boolean };
