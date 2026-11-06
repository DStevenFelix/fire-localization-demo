import original from '../../../../fire_poi/fire_sandbox_spatial_model.json';
import extended from '../../../../city_scene/poi_catalog.json';
import type { Candidate, Coordinates, Prediction, Session } from '../types';
import { toCity, type CoordinateSystem } from './mapCoordinates';

type RawPoi = { id: string; name: string; aliases?: string[]; entity_type?: string; parent_id?: string | null; center?: number[]; geometry?: unknown; centerline?: { coordinates: number[][] } };
export type RegisteredPoi = { id: string; name: string; aliases: string[]; type: string; parent_id: string | null; region_id: string | null; center: number[]; geometry: unknown; coordinate_system: CoordinateSystem; can_post: boolean; source: string };
function midpoint(ps: number[][]): number[] {
  const lengths = ps.slice(1).map((p,i)=>Math.hypot(p[0]-ps[i][0],p[1]-ps[i][1]));
  let rest=lengths.reduce((a,b)=>a+b,0)/2;
  for(let i=0;i<lengths.length;i++){if(rest<=lengths[i])return ps[i].map((v,k)=>v+(ps[i+1][k]-v)*(lengths[i]?rest/lengths[i]:0));rest-=lengths[i];}
  return ps.at(-1)!;
}
const originals = ['pois','areas','roads','nodes'].flatMap(key=>(original as unknown as Record<string,RawPoi[]>)[key]).map(p=>({
  id:p.id,name:p.name,aliases:p.aliases??[],type:p.entity_type??'unknown',parent_id:p.parent_id??null,region_id:'A-CITY',center:p.center??midpoint(p.centerline!.coordinates),geometry:p.geometry??p.centerline,
  coordinate_system:'LOCAL30x25' as const,can_post:p.entity_type!=='Tank',source:'fire_poi/fire_sandbox_spatial_model.json',
}));
export const poiRegistry = new Map<string,RegisteredPoi>([...originals,...extended.map(p=>({...p,coordinate_system:'CITY90x75' as const,source:p.source.file}))].map(p=>[p.id,p]));
export function resolveCandidate(candidate: Candidate, system: CoordinateSystem = 'LOCAL30x25'): Candidate {
  const poi=poiRegistry.get(candidate.poi_id);
  const coordinates: Coordinates=poi?toCity({x_m:poi.center[0],y_m:poi.center[1]},poi.coordinate_system):toCity(candidate.coordinates,system);
  return {...candidate,coordinates,...(poi?{name:poi.name,region_name:poi.region_id?poiRegistry.get(poi.region_id)?.name:undefined,parent_name:poi.parent_id?poiRegistry.get(poi.parent_id)?.name:undefined}:{})};
}
export function normalizePrediction(prediction: Prediction): Prediction {
  return {...prediction,coordinate_system:'CITY90x75',candidates:prediction.candidates.map(c=>resolveCandidate(c,prediction.coordinate_system??'LOCAL30x25'))};
}
export function normalizeSession(session: Session): Session {
  return {...session,prediction:session.prediction?normalizePrediction(session.prediction):null,batch_history:session.batch_history?.map(b=>({...b,prediction:normalizePrediction(b.prediction)}))};
}
