import { expect, test, vi } from 'vitest';
import { Mesh, PointLight, ShaderMaterial, Texture, Vector3 } from 'three';
import { buildFireScene, disposeSceneObject } from './fireScene';
import { cityToScene, getFireScene, localToScene, sceneTanks, SOURCE_SIZE } from './fireSceneData';
import { TrafficSimulation } from './trafficSimulation';
import { scenePixelToCity, sceneToPixel } from './mapCoordinates';
import type { SceneActorSnapshot } from '../types';

test.each(sceneTanks.map(p => p.id))('%s builds only the correct group and puts fire on its target', id => {
  const data = getFireScene(id)!;
  const scene = buildFireScene(data, new Texture());
  expect(scene.root.name).toBe(data.area.id);
  data.tanks.map(tank => {
    const model = scene.root.getObjectByName(tank.id)!;
    const p = localToScene(tank.center);
    expect(model.position.toArray()).toEqual([p.x, 0, p.z]);
  });
  [...data.pipes, ...data.buildings].map(p => expect(scene.root.getObjectByName(p.id)).toBeDefined());
  expect(scene.root.children.filter(p => p.name.startsWith('T-'))).toHaveLength(2);
  const fire = scene.root.getObjectByName('fire')!;
  expect(fire.userData.targetId).toBe(id);
  expect(fire.position.x).toBeCloseTo(localToScene(data.target.center).x);
  expect(fire.position.z).toBeCloseTo(localToScene(data.target.center).z);
  const ground = scene.root.getObjectByName('original-map') as Mesh;
  const vertices = ground.geometry.getAttribute('position');
  const uv = ground.geometry.getAttribute('uv');
  Array.from({ length: vertices.count }, (_, i) => {
    expect(uv.getX(i) * SOURCE_SIZE.width - .5 - 656).toBeCloseTo(vertices.getX(i), 3);
    expect(524.5 - ((1 - uv.getY(i)) * SOURCE_SIZE.height - .5)).toBeCloseTo(-vertices.getZ(i), 3);
  });
  disposeSceneObject(scene.root);
});

test('fire states are externally controlled; arrival and elapsed time never extinguish the fire', () => {
  const scene = buildFireScene(getFireScene('T-SW-01')!, new Texture());
  const fire = scene.root.getObjectByName('fire')!;
  scene.update('normal', [], 1, 1);
  expect(fire.visible).toBe(false);
  scene.update('burning', [], 1, 2);
  expect(fire.visible).toBe(true);
  const burningScale = fire.children[0].scale.x;
  scene.update('extinguishing', [], .1, 2);
  const early = fire.children[0].scale.x;
  scene.update('extinguishing', [], 2, 2);
  expect(early).toBeLessThan(burningScale);
  expect(fire.children[0].scale.x).toBeLessThan(early);
  expect(fire.visible).toBe(true);
  scene.update('extinguished', [], .1, 4);
  expect(fire.visible).toBe(false);
  scene.update('burning', [], 10, 1000);
  expect(fire.visible).toBe(true);
  expect(fire.userData.status).toBe('burning');
  disposeSceneObject(scene.root);
});

test('snapshot is detached; live simulation positions and status feed both views', () => {
  const sim = new TrafficSimulation(() => .5);
  const saved = sim.sceneSnapshot;
  expect(saved).toHaveLength(3);
  expect(saved[0].position).not.toBe(sim.trucks[0].pose.point);
  const initial = { ...saved[0].position };
  sim.setIncident([39.717988, 33.984747], 1);
  sim.tick(.08);
  expect(saved[0].position).toEqual(initial);
  const scene = buildFireScene(getFireScene('T-SW-01')!, new Texture());
  scene.update('burning', sim.sceneSnapshot, 1, 1);
  sim.sceneSnapshot.map(actor => {
    const truck = sim.trucks.find(t => t.id === actor.id)!;
    expect(actor.position).toEqual({ x: truck.pose.point[0], y: truck.pose.point[1] });
    expect(actor.status).toBe(truck.status);
    expect(actor.heading).toBe(truck.pose.angle);
    const model = scene.root.getObjectByName(actor.id)!;
    const svg = sceneToPixel({ x_m: truck.pose.point[0], y_m: truck.pose.point[1] }, 'CITY90x75');
    const city = scenePixelToCity(svg);
    const p = cityToScene({ x: city.x_m, y: city.y_m });
    expect(model.position.x).toBeCloseTo(p.x, 8);
    expect(model.position.z).toBeCloseTo(p.z, 8);
    expect(model.visible).toBe(false);
  });
  disposeSceneObject(scene.root);
});

test.each(sceneTanks.map(p => p.id))('%s shows all three arriving trucks from the existing simulation at their actual positions', id => {
  const sim = new TrafficSimulation(() => .5);
  const data = getFireScene(id)!;
  sim.setIncident([data.target.center[0] + 30, data.target.center[1] + 25], 3);
  Array.from({ length: 1600 }).some(() => {
    sim.tick(.05);
    return sim.trucks.every(truck => truck.status === 'arrived');
  });
  expect(sim.sceneSnapshot.map(truck => truck.status)).toEqual(['arrived', 'arrived', 'arrived']);
  const scene = buildFireScene(data, new Texture());
  scene.update('burning', sim.sceneSnapshot, 1, 100);
  sim.sceneSnapshot.map(arrived => {
    const model = scene.root.getObjectByName(arrived.id)!;
    expect(model.visible, JSON.stringify({ position: arrived.position, bounds: data.bounds })).toBe(true);
    expect(model.getObjectByName('water')!.visible).toBe(true);
    expect(model.position.x).toBeCloseTo(cityToScene(arrived.position).x, 9);
    expect(model.position.z).toBeCloseTo(cityToScene(arrived.position).z, 9);
  });
  expect(scene.root.getObjectByName('fire')!.visible).toBe(true);
  disposeSceneObject(scene.root);
});

test('actors enter and leave the scene; water aims at the simulation goal; drones require an input snapshot', () => {
  const scene = buildFireScene(getFireScene('T-SW-01')!, new Texture());
  expect(scene.root.getObjectByName('actors')!.children).toHaveLength(0);
  const actor: SceneActorSnapshot = { id: 'test-truck', kind: 'fireTruck', position: { x: 40, y: 33 }, heading: .5, status: 'arrived', waterTarget: { x: 50, y: 34 } };
  scene.update('burning', [actor], 1, 1);
  const model = scene.root.getObjectByName(actor.id)!;
  expect(model.visible).toBe(true);
  const water = model.getObjectByName('water')!;
  expect(water.visible).toBe(true);
  const end = new Vector3(0, .5, 0).applyMatrix4(water.matrix.clone().compose(water.position, water.quaternion, water.scale)).add(model.position);
  expect(end.x).toBeCloseTo(cityToScene(actor.waterTarget!).x, 6);
  expect(end.z).toBeCloseTo(cityToScene(actor.waterTarget!).z, 6);
  scene.update('burning', [{ ...actor, position: { x: 65, y: 60 } }], 1, 2);
  expect(model.visible).toBe(false);
  expect(water.visible).toBe(false);
  scene.update('burning', [{ id: 'test-drone', kind: 'drone', position: { x: 40, y: 34 }, heading: .3, status: 'hovering', altitude: 120 }], 1, 3);
  expect(scene.root.getObjectByName('test-truck')).toBeUndefined();
  const drone = scene.root.getObjectByName('test-drone')!;
  expect(drone.position.y).toBe(120);
  expect(drone.visible).toBe(true);
  scene.update('burning', [], 1, 4);
  expect(scene.root.getObjectByName('actors')!.children).toHaveLength(0);
  expect(scene.root.getObjectByName('fire')!.visible).toBe(true);
  disposeSceneObject(scene.root);
});

test('scene releases every geometry and material; caller retains the shared map texture', () => {
  const texture = new Texture();
  const scene = buildFireScene(getFireScene('T-NE-02')!, texture);
  const releases: ReturnType<typeof vi.spyOn>[] = [];
  scene.root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    releases.push(vi.spyOn(object.geometry, 'dispose'));
    (Array.isArray(object.material) ? object.material : [object.material]).map(material => releases.push(vi.spyOn(material, 'dispose')));
  });
  const mapRelease = vi.spyOn(texture, 'dispose');
  const lightRelease = vi.spyOn(scene.root.getObjectByName('heat-light') as PointLight, 'dispose');
  disposeSceneObject(scene.root);
  releases.map(release => expect(release).toHaveBeenCalledOnce());
  expect(mapRelease).not.toHaveBeenCalled();
  expect(lightRelease).toHaveBeenCalledOnce();
  expect(scene.root.children).toHaveLength(0);
});

test('severity changes coverage, height and smoke independently of the lifecycle without allocating resources', () => {
  const scene = buildFireScene(getFireScene('T-SW-01')!, new Texture());
  const fire = scene.root.getObjectByName('fire')!;
  const plume = scene.root.getObjectByName('flame-plume')!;
  const smoke = scene.root.getObjectByName('smoke-plume')!;
  const resources: unknown[] = [];
  scene.root.traverse(object => {
    if (object instanceof Mesh) resources.push(object.geometry, object.material);
  });
  const levels = ([1, 2, 3] as const).map(severity => {
    scene.update('burning', [], 8, 5, severity);
    expect(fire.userData.status).toBe('burning');
    expect(fire.userData.severity).toBe(severity);
    return { size: plume.scale.x, smoke: smoke.children.filter(puff => puff.visible).length };
  });
  expect(levels.map(level => level.smoke)).toEqual([8, 13, 18]);
  expect(levels[1].size).toBeGreaterThan(levels[0].size * 1.5);
  expect(levels[2].size).toBeGreaterThan(levels[1].size * 1.2);
  Array.from({ length: 360 }, (_, i) => scene.update('burning', [], 1 / 60, i / 60, 3));
  const after: unknown[] = [];
  scene.root.traverse(object => {
    if (object instanceof Mesh) {
      after.push(object.geometry, object.material);
      expect(object.geometry.type).not.toBe('ConeGeometry');
    }
  });
  expect(after).toEqual(resources);
  scene.update('normal', [], 1 / 60, 20, 3);
  expect(fire.visible).toBe(false);
  expect((scene.root.getObjectByName('heat-light') as PointLight).intensity).toBe(0);
  scene.update('burning', [], 1, 21);
  expect(fire.userData.severity).toBe(2);
  disposeSceneObject(scene.root);
});

test('smoke cycles fade at both ends, stay bounded over time, and disappear with controlled extinction', () => {
  const scene = buildFireScene(getFireScene('T-NE-02')!, new Texture());
  const puff = scene.root.getObjectByName('smoke-0') as Mesh;
  const material = puff.material as ShaderMaterial;
  scene.update('burning', [], 8, 1 / .063 - .001, 3);
  expect(material.uniforms.opacity.value).toBeLessThan(.001);
  scene.update('burning', [], 1 / 60, 1 / .063 + .001, 3);
  expect(material.uniforms.opacity.value).toBeLessThan(.001);
  [0, 100, 10000].map(time => {
    scene.update('burning', [], 1 / 60, time, 3);
    expect(puff.position.y).toBeLessThan(135);
    expect(puff.scale.x).toBeLessThan(80);
  });
  scene.update('extinguished', [], 1 / 60, 10001, 3);
  expect(scene.root.getObjectByName('fire')!.visible).toBe(false);
  expect(material.uniforms.opacity.value).toBe(0);
  disposeSceneObject(scene.root);
});
