import animation from '../../../../city_scene/pedestrian_animation.json';
import { distance, type Point } from './roadNetwork';
import { originalCrosswalks } from './trafficSignalGeometry';
import type { TrafficSignalController } from './trafficSignalController';

const nodes = new Map(animation.nodes.map(n => [n.id, n.center as Point]));
const edges = new Map(animation.edges.map(e => [e.id, e]));
const routes = [
  ...animation.routes.map(r => ({ ...r, segments: r.edge_ids.map((id, i) => ({
    id, a: nodes.get(r.node_ids[i])!, b: nodes.get(r.node_ids[i + 1])!, crosswalk: edges.get(id)!.crosswalk_id,
  })) })),
  ...originalCrosswalks.map(c => ({ id: `WALK:${c.id}`, speed: .3, phase: 0,
    length: distance(c.points[0], c.points[1]) * 2,
    segments: [{ id: c.id, a: c.points[0], b: c.points[1], crosswalk: c.id },
      { id: c.id, a: c.points[1], b: c.points[0], crosswalk: c.id }],
  })),
].map(r => ({ ...r, segments: r.segments.map(s => ({ ...s, length: distance(s.a, s.b) })) }));

export const pedestrianIds = routes.map(r => r.id);
export class PedestrianSimulation {
  readonly actors = routes.map(route => {
    let remaining = route.phase * route.length, index = 0;
    while (remaining >= route.segments[index].length && index < route.segments.length - 1) remaining -= route.segments[index++].length;
    return { id: route.id, route, index, distance: remaining, waiting: false,
      point: [...route.segments[index].a] as Point, angle: 0 };
  });
  constructor(private signals: TrafficSignalController) { this.actors.forEach(actor => this.update(actor)); }
  tick(seconds: number) {
    this.actors.forEach(actor => {
      let remaining = actor.route.speed * seconds;
      actor.waiting = false;
      while (remaining > 1e-8) {
        const segment = actor.route.segments[actor.index];
        if (segment.crosswalk && actor.distance <= 1e-8 && !this.signals.canEnterPedestrian(segment.crosswalk)) {
          actor.waiting = true; break;
        }
        const step = Math.min(remaining, segment.length - actor.distance);
        actor.distance += step; remaining -= step;
        if (actor.distance < segment.length - 1e-8) break;
        if (segment.crosswalk) this.signals.release(this.signals.getCrosswalkControl(segment.crosswalk)!.intersection.id, actor.id);
        actor.index = (actor.index + 1) % actor.route.segments.length; actor.distance = 0;
      }
      this.update(actor);
    });
  }
  private update(actor: typeof this.actors[number]) {
    const segment = actor.route.segments[actor.index], t = actor.distance / segment.length;
    actor.point = [segment.a[0] + (segment.b[0] - segment.a[0]) * t, segment.a[1] + (segment.b[1] - segment.a[1]) * t];
    actor.angle = Math.atan2(segment.b[1] - segment.a[1], segment.b[0] - segment.a[0]) * 180 / Math.PI;
    if (segment.crosswalk && actor.distance > 1e-8) this.signals.occupy(
      this.signals.getCrosswalkControl(segment.crosswalk)!.intersection.id, actor.id, 'pedestrian', segment.crosswalk);
  }
}
