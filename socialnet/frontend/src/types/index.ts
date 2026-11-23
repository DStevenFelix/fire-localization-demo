export type Coordinates = { x_m: number; y_m: number };
export type Point = { x: number; y: number };
export type Entity = {
  id: string; name: string; kind: string; entity_type: string; x: number; y: number;
  width: number; height: number; position: Point; area_id: string | null; parent_id: string | null;
  aliases: string[]; path: Point[]; geometry: { points: Point[]; polygons?: Point[][] }; residents: string[];
};
export type Candidate = {
  poi_id: string; name: string; rank: number; coordinates: Coordinates; score: number;
  relative_score: number; votes: number; confidence: number; cluster_ids?: string[];
};
export type Prediction = {
  coordinate_system?: 'CITY90x75' | 'LOCAL30x25' | 'local_cartesian_meters';
  candidates: Candidate[];
};
export type SceneData = {
  simulation_minute: number;
  persistence: { activation_id: string; run_id: string };
  entities: Entity[];
  fires: {id: string; position: Point; intensity: number; area_id: string}[];
  localization: {
    session_id: string;
    status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
    resume_pending: boolean;
    cold_minutes: number;
    prediction: Prediction | null;
    clusters: {id: string; cold: boolean; last_timestamp: string}[];
  };
  map: {image_url: string};
};
