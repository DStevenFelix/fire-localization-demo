export type Mode = 'offline' | 'live';
export type OpinionPost = Readonly<{
  id: string;
  text: string;
  timestamp?: string;
  location_poi_id?: string;
  urgency?: '低' | '中' | '高';
}>;
export type SessionPosts = Readonly<{
  session_id: string;
  post_count: number;
  posts: readonly Required<OpinionPost>[];
}>;
export type TrafficControlMode = 'normal' | 'emergency_lockdown' | 'emergency_priority';
export type SignalColor = 'red' | 'green' | 'yellow' | 'off' | 'red_flash' | 'green_flash' | 'yellow_flash';
export type HardwareSignal = Readonly<{
  connected: boolean;
  groups: readonly Readonly<{ color: SignalColor; countdown: number }>[];
}>;
export type IntersectionSignalState = Readonly<{
  intersectionId: string;
  phase: 'vehicle' | 'pedestrian' | 'all_red';
  groupId: string | null;
  emergencyPriority: boolean;
  vehicles: Readonly<Record<string, SignalColor>>;
  pedestrians: Readonly<Record<string, SignalColor>>;
  hardware?: HardwareSignal;
}>;
export interface TrafficControlService {
  setMode(mode: TrafficControlMode): void;
  getMode(): TrafficControlMode;
  getIntersectionState(intersectionId: string): IntersectionSignalState | undefined;
  getAllSignalStates(): IntersectionSignalState[];
  subscribe(listener: () => void): () => void;
  setEmergencyAccess(vehicleId: string, authorized: boolean): void;
}
export type Coordinates = { x_m: number; y_m: number };
export type FireSceneStatus = 'normal' | 'burning' | 'extinguishing' | 'extinguished';
export type FireSceneSeverity = 1 | 2 | 3;
// Positions are CITY90x75; heading is radians counterclockwise from east.
// Height is a display dimension in source-image pixels, separate from map units.
export type SceneActorSnapshot = Readonly<{
  id: string;
  kind: 'fireTruck' | 'drone';
  position: Readonly<{ x: number; y: number }>;
  heading: number;
  status: string;
  altitude?: number;
  waterTarget?: Readonly<{ x: number; y: number }>;
}>;
export type VehicleSceneSnapshot = SceneActorSnapshot & { readonly kind: 'fireTruck' };
export type SceneActorSource = { readonly current: readonly SceneActorSnapshot[] };
export type Poi = { poi_id: string; name: string; type: string; coordinates: Coordinates; can_post: boolean };
export type Candidate = Pick<Poi, 'poi_id' | 'name' | 'coordinates'> & { rank: number; votes: number; confidence: number; score: number; relative_score: number; cluster_ids?: string[]; region_name?: string; parent_name?: string };
export type Prediction = {
  coordinate_system?: 'LOCAL30x25' | 'local_cartesian_meters' | 'CITY90x75';
  candidates: Candidate[]; processed_count: number; pending_count: number;
  active_cluster_count: number; cold_cluster_count: number; status: string; current_time?: string;
};
export type Session = {
  session_id: string; mode: Mode; status: 'prepared' | 'running' | 'completed' | 'failed';
  analysis_frozen?: boolean;
  paused?: boolean;
  target_poi_id: string; seed: number; post_count: number; ground_truth: Pick<Poi, 'poi_id' | 'name' | 'coordinates'>;
  prediction: Prediction | null;
  evaluation: { top1_hit: boolean; top3_hit: boolean; target_rank: number | null; distance_m: number | null } | null;
  processed_count: number; ignored_count: number; batch_count: number;
  batch_history?: { batch_number: number; processed_count: number; ignored_count: number; prediction: Prediction }[];
  error: { error_type: string; message: string } | null;
  created_at: string; started_at: string | null; completed_at: string | null;
};
export type Health = { status: string; algorithm: string; default_mode: Mode; live_requires_confirmation: boolean };

export type CityPosition = Readonly<{ x: number; y: number }>;
export type DroneStatus = 'idle' | 'dispatched' | 'flying' | 'observing' | 'returning' | 'charging';
// altitude follows SceneActorSnapshot: source-image pixels above ground.
export type DroneSnapshot = Readonly<{
  id: string; position: CityPosition; heading: number; altitude: number; status: DroneStatus;
  targetPoiId?: string; path?: readonly CityPosition[]; updatedAt: number;
}>;
export type FireAssessment = { targetPoiId: string; source?: string; assessedAt?: number } & (
  { status: 'completed'; severity: FireSceneSeverity; result: string } |
  { status: 'pending' | 'failed'; message?: string }
);
// IDs refer to exported road pieces, including legal turn connectors; no client routing.
export type FireTruckRoute = Readonly<{ pieceIds: readonly string[]; stop: number }>;
export type FireTruckDispatch = Readonly<{
  vehicleId: string; targetPoiId: string; targetPosition: CityPosition;
  route?: FireTruckRoute; path?: readonly CityPosition[];
  status: 'dispatched' | 'en_route' | 'arrived' | 'extinguishing' | 'returning' | 'idle';
}>;
export type EmergencyPlan = Readonly<{
  id: string; targetPoiId: string; trafficLockdown: boolean;
  dispatches: readonly FireTruckDispatch[]; summary: string;
}>;
export type EmergencyPhase = 'idle' | 'fire_detected' | 'drone_dispatched' | 'observing' |
  'assessment_completed' | 'awaiting_confirmation' | 'traffic_lockdown' | 'fire_trucks_dispatched' |
  'fire_trucks_en_route' | 'fire_trucks_arrived' | 'extinguishing' | 'extinguished' |
  'traffic_restored' | 'returning' | 'completed' | 'failed';
export type EmergencyEvent = Readonly<{ messageId: string; incidentId: string; occurredAt: number }> & (
  { type: 'fire.detected'; targetPoiId: string } |
  { type: 'drone.update'; drone: DroneSnapshot } |
  { type: 'drone.observed'; droneId: string } |
  { type: 'fire.assessed'; assessment: FireAssessment } |
  { type: 'plan.proposed'; plan: EmergencyPlan } |
  { type: 'plan.revised'; assessment: Extract<FireAssessment, { status: 'completed' }>; plan: EmergencyPlan } |
  { type: 'truck.position'; vehicleId: string; position: CityPosition; updatedAt: number } |
  { type: 'truck.route'; vehicleId: string; route: FireTruckRoute } |
  { type: 'truck.arrived' | 'truck.extinguishing'; vehicleId: string } |
  { type: 'fire.extinguished' } |
  { type: 'truck.return'; vehicleId: string; route?: FireTruckRoute } |
  { type: 'drone.return'; drone: DroneSnapshot } |
  { type: 'operation.failed'; operation: 'drone' | 'assessment' | 'dispatch' | 'extinguish'; message: string }
);
export type EmergencyCommand = Readonly<{ commandId: string; incidentId: string }> & (
  { type: 'plan.confirm'; plan: EmergencyPlan } |
  { type: 'responders.return'; vehicleIds: readonly string[]; droneIds: readonly string[] } |
  { type: 'operation.retry'; operation: string }
);
export interface EmergencyAdapter {
  readonly source?: string;
  subscribe(receive: (event: unknown) => void): () => void;
  execute(command: EmergencyCommand, signal: AbortSignal): Promise<void>;
  resolveRoute?(dispatch: FireTruckDispatch, from: CityPosition, signal: AbortSignal): Promise<FireTruckRoute>;
  /** Optional executor for adapters backed by the local traffic simulator. */
  readonly simulatedFleet?: { apply(plan: EmergencyPlan): void; isHome(): boolean };
}
export type EmergencyIncident = Readonly<{
  id: string; targetPoiId: string; phase: EmergencyPhase; fireStatus: FireSceneStatus;
  assessment?: FireAssessment; plan?: EmergencyPlan; confirmed: boolean; cancelled: boolean;
  droneIds: readonly string[]; observedIds: readonly string[]; arrivedIds: readonly string[]; returningIds: readonly string[];
  error?: string; failedOperation?: string;
}>;
export type EmergencySnapshot = Readonly<{
  incident: EmergencyIncident | null; drones: readonly DroneSnapshot[];
  connected: boolean; pending: boolean; inputError?: string;
  source?: string;
}>;
