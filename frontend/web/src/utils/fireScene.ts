import { AdditiveBlending, BoxGeometry, BufferGeometry, CylinderGeometry, DoubleSide, ExtrudeGeometry, Group, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, PointLight, Quaternion, ShaderMaterial, Shape, SphereGeometry, Texture, TorusGeometry, Vector3 } from 'three';
import type { FireSceneSeverity, FireSceneStatus, SceneActorSnapshot } from '../types';
import { cityToScene, droneStationScene, isInsideScene, localToScene, PIXELS_PER_UNIT, SOURCE_SIZE, type FireSceneData } from './fireSceneData';
import { drone_station } from '../../../../city_scene/fire_resources.json';
import { fire_station_reserve, roads } from '../../../../city_scene/city_scene.json';

export function buildFireScene(data: FireSceneData, texture: Texture) {
  const root = new Group();
  root.name = data.area.id;
  const groundGeometry = new PlaneGeometry(data.bounds.maxX - data.bounds.minX, data.bounds.maxZ - data.bounds.minZ);
  groundGeometry.rotateX(-Math.PI / 2);
  groundGeometry.translate(data.center.x, 0, data.center.z);
  const positions = groundGeometry.getAttribute('position');
  const uv = groundGeometry.getAttribute('uv');
  Array.from({ length: positions.count }, (_, i) => {
    uv.setXY(i, (positions.getX(i) + SOURCE_SIZE.width / 2) / SOURCE_SIZE.width,
      (SOURCE_SIZE.height / 2 - positions.getZ(i)) / SOURCE_SIZE.height);
  });
  const ground = new Mesh(groundGeometry, new MeshBasicMaterial({ map: texture }));
  ground.name = 'original-map';
  root.add(ground);

  const station = new Group();
  station.name = drone_station.poi_id;
  station.visible = false;
  const stationGround = new Mesh(new PlaneGeometry(droneStationScene.bounds.maxX - droneStationScene.bounds.minX,
    droneStationScene.bounds.maxZ - droneStationScene.bounds.minZ), new MeshStandardMaterial({ color: '#466756', roughness: 1 }));
  stationGround.rotation.x = -Math.PI / 2;
  stationGround.position.set(droneStationScene.center.x, -.5, droneStationScene.center.z);
  station.add(stationGround);
  roads.forEach(road => {
    const a = cityToScene({ x: road.centerline.coordinates[0][0], y: road.centerline.coordinates[0][1] });
    const b = cityToScene({ x: road.centerline.coordinates[1][0], y: road.centerline.coordinates[1][1] });
    if (Math.max(a.x, b.x) < droneStationScene.bounds.minX || Math.min(a.x, b.x) > droneStationScene.bounds.maxX ||
      Math.max(a.z, b.z) < droneStationScene.bounds.minZ || Math.min(a.z, b.z) > droneStationScene.bounds.maxZ) return;
    const start = new Vector3(Math.max(droneStationScene.bounds.minX, a.x), 0, Math.min(droneStationScene.bounds.maxZ, a.z));
    const end = new Vector3(Math.min(droneStationScene.bounds.maxX, b.x), 0, Math.max(droneStationScene.bounds.minZ, b.z));
    const horizontal = Math.abs(a.x - b.x) > Math.abs(a.z - b.z);
    const surface = new Mesh(new PlaneGeometry(horizontal ? end.x - start.x : road.width * PIXELS_PER_UNIT.x,
      horizontal ? road.width * PIXELS_PER_UNIT.y : start.z - end.z), new MeshStandardMaterial({ color: '#3b4545' }));
    surface.rotation.x = -Math.PI / 2;
    surface.position.copy(start.add(end).multiplyScalar(.5));
    station.add(surface);
  });
  [fire_station_reserve.geometry, drone_station.geometry].forEach((geometry, index) => {
    const points = geometry.coordinates[0].map(p => cityToScene({ x: p[0], y: p[1] }));
    const apron = new Mesh(new BoxGeometry(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)), 2,
      Math.max(...points.map(p => p.z)) - Math.min(...points.map(p => p.z))), new MeshStandardMaterial({ color: index ? '#28636b' : '#64736d' }));
    apron.position.set((points[0].x + points[2].x) / 2, 1, (points[0].z + points[2].z) / 2);
    apron.name = index ? 'drone-station-platform' : fire_station_reserve.id;
    station.add(apron);
  });
  drone_station.bays.forEach(bay => {
    const p = cityToScene({ x: bay.center[0], y: bay.center[1] });
    const pad = new Mesh(new TorusGeometry(.72 * PIXELS_PER_UNIT.x, 1, 6, 40), new MeshStandardMaterial({ color: '#b9eee0' }));
    pad.name = `bay:${bay.drone_id}`;
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(p.x, 2.2, p.z);
    station.add(pad);
  });
  root.add(station);

  data.tanks.map(tank => {
    const model = new Group();
    model.name = tank.id;
    const p = localToScene(tank.shape.center);
    model.position.set(p.x, 0, p.z);
    const rx = tank.shape.radius_x * PIXELS_PER_UNIT.x;
    const rz = tank.shape.radius_y * PIXELS_PER_UNIT.y;
    const height = Math.min(rx, rz) * 1.12;
    const body = new Mesh(new CylinderGeometry(1, 1, height, 48), new MeshStandardMaterial({ color: '#bdcbd0', roughness: .64, metalness: .22 }));
    body.scale.set(rx, 1, rz);
    body.position.y = height / 2;
    model.add(body);
    const roof = new Mesh(new SphereGeometry(1, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2), new MeshStandardMaterial({ color: '#e5ebdf', roughness: .7, metalness: .12 }));
    roof.scale.set(rx, 5, rz);
    roof.position.y = height;
    model.add(roof);
    [2, height].map(y => {
      const rim = new Mesh(new TorusGeometry(1, .022, 6, 48), new MeshStandardMaterial({ color: '#6c858c', metalness: .4, roughness: .5 }));
      rim.rotation.x = Math.PI / 2;
      rim.scale.set(rx, rz, Math.min(rx, rz));
      rim.position.y = y;
      model.add(rim);
    });
    const hatch = new Mesh(new CylinderGeometry(5, 5, 3, 16), new MeshStandardMaterial({ color: '#758d98' }));
    hatch.position.y = height + 6;
    model.add(hatch);
    model.userData.roofHeight = height + 5;
    root.add(model);
  });

  data.pipes.map(pipe => {
    const model = new Group();
    model.name = pipe.id;
    pipe.linework.coordinates.slice(1).map((point, i) => {
      const a = localToScene(pipe.linework.coordinates[i], 9);
      const b = localToScene(point, 9);
      model.add(segment(new Vector3(a.x, a.y, a.z), new Vector3(b.x, b.y, b.z), 2.4, '#ead8aa'));
    });
    root.add(model);
  });

  data.buildings.map(building => {
    const polygon = building.geometry.coordinates[0].map(point => localToScene(point));
    const shape = new Shape();
    polygon.map((point, i) => i ? shape.lineTo(point.x, -point.z) : shape.moveTo(point.x, -point.z));
    const geometry = new ExtrudeGeometry(shape, { depth: 22, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    const model = new Mesh(geometry, new MeshStandardMaterial({ color: '#b7c5b9', roughness: .9 }));
    model.name = building.id;
    root.add(model);
  });

  const fire = new Group();
  fire.name = 'fire';
  const burningTank = root.getObjectByName(data.target.id)!;
  fire.position.copy(burningTank.position);
  fire.position.y = burningTank.userData.roofHeight;
  fire.userData.targetId = data.target.id;
  const roofScale = Math.min(data.target.shape.radius_x * PIXELS_PER_UNIT.x, data.target.shape.radius_y * PIXELS_PER_UNIT.y) / 43;
  const plume = new Group();
  plume.name = 'flame-plume';
  plume.position.set(-5, 0, 3);
  fire.add(plume);
  const flameGeometry = new PlaneGeometry(1, 1, 1, 1);
  flameGeometry.translate(0, .5, 0);
  // Art-directed local tongues: different widths/heights, shared by every tank.
  // These coefficients shape the effect; severity comes exclusively from input.
  const flames = [[-8, 2, 30, 45], [5, -4, 35, 67], [12, 5, 24, 44], [-16, -6, 18, 35],
    [-2, 8, 25, 54], [2, -10, 17, 43], [16, -3, 16, 30], [-12, 10, 15, 27]].map(([x, z, width, height], i) => {
    const flame = new Mesh(flameGeometry, new ShaderMaterial({
      uniforms: { time: { value: 0 }, seed: { value: i * 3.71 }, opacity: { value: 0 } },
      vertexShader: billboardVertexShader, fragmentShader: flameFragmentShader,
      transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false,
    }));
    flame.name = `flame-${i}`;
    flame.position.set(x, -.8, z);
    flame.scale.set(width, height, 1);
    flame.renderOrder = 2;
    plume.add(flame);
    return { mesh: flame, height };
  });
  const glow = new Mesh(new PlaneGeometry(50, 44), new ShaderMaterial({
    uniforms: { opacity: { value: 0 } }, vertexShader: surfaceVertexShader, fragmentShader: glowFragmentShader,
    transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
  }));
  glow.name = 'heat-glow';
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(0, .25, 0);
  glow.renderOrder = 1;
  plume.add(glow);
  const heatLight = new PointLight('#ff641f', 0, 100, 2);
  heatLight.name = 'heat-light';
  heatLight.position.set(0, 12, 0);
  plume.add(heatLight);
  const smokeGroup = new Group();
  smokeGroup.name = 'smoke-plume';
  smokeGroup.position.copy(plume.position);
  fire.add(smokeGroup);
  const smokeGeometry = new PlaneGeometry(1, 1);
  const smoke = Array.from({ length: 18 }, (_, i) => {
    const puff = new Mesh(smokeGeometry, new ShaderMaterial({
      uniforms: { seed: { value: i * 4.13 }, opacity: { value: 0 } },
      vertexShader: billboardVertexShader, fragmentShader: smokeFragmentShader,
      transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false,
    }));
    puff.name = `smoke-${i}`;
    puff.userData.weight = 0;
    puff.renderOrder = 3;
    smokeGroup.add(puff);
    return puff;
  });
  root.add(fire);
  const actors = new Group();
  actors.name = 'actors';
  root.add(actors);
  const actorModels = new Map<string, ReturnType<typeof createSceneActor>>();
  const localModels = root.children.filter(object => object !== station && object !== actors);
  let intensity = 0;
  let spread = 1;

  return { root,
    update(status: FireSceneStatus, snapshots: readonly SceneActorSnapshot[], dt: number, time: number, severity: FireSceneSeverity = 2, view: 'fire' | 'station' = 'fire') {
      station.visible = view === 'station';
      localModels.forEach(object => { object.visible = view === 'fire'; });
      const targetIntensity = status === 'burning' ? 1 : status === 'extinguishing' ? .18 : 0;
      intensity = status === 'normal' || status === 'extinguished' ? 0 : intensity + (targetIntensity - intensity) * (1 - Math.exp(-dt * 2));
      spread += ([.62, 1, 1.27][severity - 1] - spread) * (1 - Math.exp(-dt * 4));
      fire.visible = intensity > .001 && view === 'fire';
      fire.userData.status = status;
      fire.userData.severity = severity;
      plume.scale.setScalar(roofScale * spread * Math.pow(intensity, .45));
      flames.map((flame, i) => {
        flame.mesh.material.uniforms.time.value = time;
        flame.mesh.material.uniforms.opacity.value = intensity * .93;
        flame.mesh.scale.y = flame.height * (.95 + .05 * Math.sin(time * (2.1 + i * .13) + i * 2.4));
      });
      glow.material.uniforms.opacity.value = intensity * (.27 + .025 * Math.sin(time * 4));
      heatLight.intensity = intensity * spread * 165;
      smoke.map((puff, i) => {
        const age = (time * (.063 + (i % 4) * .005) + i * .618034) % 1;
        // Fade both ends of each cycle so recycling a puff never flashes.
        const fadeIn = Math.min(1, age / .16);
        const fadeOut = Math.min(1, (1 - age) / .3);
        puff.userData.weight += ((i < [8, 13, 18][severity - 1] ? 1 : 0) - puff.userData.weight) * (1 - Math.exp(-dt * 3));
        puff.material.uniforms.opacity.value = fadeIn * fadeIn * (3 - 2 * fadeIn) * fadeOut * fadeOut * (3 - 2 * fadeOut) *
          intensity * puff.userData.weight * (.3 + severity * .05);
        puff.visible = puff.material.uniforms.opacity.value > .0001;
        const drift = Math.sin(i * 2.4) * (5 + age * 12);
        puff.position.set((drift + age * 17) * spread, (30 + age * 88) * Math.sqrt(spread),
          (Math.cos(i * 1.7) * (6 + age * 11) + age * 7) * spread);
        const size = (29 + age * 31 + (i % 3) * 4) * roofScale * Math.sqrt(spread);
        puff.scale.set(size, size * (1.04 + (i % 4) * .08), 1);
      });
      const ids = new Set(snapshots.map(actor => actor.id));
      actorModels.forEach((model, id) => {
        if (ids.has(id)) return;
        actors.remove(model.root);
        disposeSceneObject(model.root);
        actorModels.delete(id);
      });
      snapshots.map(actor => {
        const existing = actorModels.get(actor.id);
        if (existing && existing.kind !== actor.kind) {
          actors.remove(existing.root);
          disposeSceneObject(existing.root);
          actorModels.delete(actor.id);
        }
        const model = actorModels.get(actor.id) ?? createSceneActor(actor.kind);
        if (!actorModels.has(actor.id)) { actorModels.set(actor.id, model); actors.add(model.root); }
        model.root.name = actor.id;
        const p = cityToScene(actor.position, actor.kind === 'drone' ? actor.altitude ?? 90 : 0);
        model.body.visible = isInsideScene(p, view === 'station' ? droneStationScene.bounds : data.bounds);
        model.root.position.set(p.x, p.y, p.z);
        // Nonuniform map scales apply after heading, matching the SVG transform.
        model.body.rotation.y = actor.heading;
        model.root.userData.status = actor.status;
        model.rotors.map(rotor => { rotor.rotation.y = time * 35; });
        const end = actor.waterTarget && cityToScene(actor.waterTarget, 28);
        model.water.visible = actor.kind === 'fireTruck' && actor.status === 'extinguishing' && status === 'extinguishing' &&
          view === 'fire' && !!end && isInsideScene(end, data.bounds);
        model.droplets.visible = model.water.visible;
        model.root.visible = model.body.visible || model.water.visible;
        if (!model.water.visible || !end) return;
        // The model stays at its reported coordinates. Only the visible portion of the stream enters this local scene.
        const entry = Math.max(0,
          p.x < data.bounds.minX ? (data.bounds.minX - p.x) / (end.x - p.x) : p.x > data.bounds.maxX ? (data.bounds.maxX - p.x) / (end.x - p.x) : 0,
          p.z < data.bounds.minZ ? (data.bounds.minZ - p.z) / (end.z - p.z) : p.z > data.bounds.maxZ ? (data.bounds.maxZ - p.z) / (end.z - p.z) : 0);
        const start = new Vector3(p.x, 21, p.z).lerp(new Vector3(end.x, end.y, end.z), entry);
        const direction = new Vector3(end.x, end.y, end.z).sub(start);
        const localStart = start.sub(new Vector3(p.x, p.y, p.z));
        model.water.position.copy(localStart).addScaledVector(direction, .5);
        model.water.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize());
        model.water.scale.y = direction.length();
        model.droplets.children.forEach((drop, i) => {
          const progress = (i / model.droplets.children.length + time * 1.65) % 1;
          drop.position.copy(localStart).addScaledVector(direction, progress);
          drop.scale.setScalar(2.8 + 2.4 * progress);
        });
      });
    },
  };
}

function segment(a: Vector3, b: Vector3, radius: number, color: string) {
  const direction = b.clone().sub(a);
  const mesh = new Mesh(new CylinderGeometry(radius, radius, direction.length(), 8), new MeshStandardMaterial({ color, roughness: .5 }));
  mesh.position.copy(a.clone().add(b).multiplyScalar(.5));
  mesh.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()));
  return mesh;
}

export function createSceneActor(kind: SceneActorSnapshot['kind']) {
  const root = new Group();
  const scaled = new Group();
  scaled.scale.set(PIXELS_PER_UNIT.x, 1, PIXELS_PER_UNIT.y);
  const body = new Group();
  if (kind === 'drone') body.position.y = 7;
  scaled.add(body);
  root.add(scaled);
  const water = new Mesh(new CylinderGeometry(2.4, 1.6, 1, 8), new MeshBasicMaterial({ color: '#42bdf5', transparent: true, opacity: .9, depthWrite: false }));
  water.name = 'water';
  water.visible = false;
  root.add(water);
  const droplets = new Group();
  droplets.visible = false;
  root.add(droplets);
  const rotors: Mesh<BufferGeometry, MeshStandardMaterial>[] = [];
  if (kind === 'fireTruck') {
    const geometry = new SphereGeometry(1, 8, 6);
    const material = new MeshBasicMaterial({ color: '#d6faff' });
    for (let i = 0; i < 12; i++) droplets.add(new Mesh(geometry, material));
    const chassis = new Mesh(new BoxGeometry(1.66, 15, .57), new MeshStandardMaterial({ color: '#cc253d' }));
    chassis.position.y = 9;
    body.add(chassis);
    const cabin = new Mesh(new BoxGeometry(.5, 9, .52), new MeshStandardMaterial({ color: '#e84a45' }));
    cabin.position.set(.5, 20, 0);
    body.add(cabin);
    const windscreen = new Mesh(new BoxGeometry(.02, 5, .4), new MeshStandardMaterial({ color: '#284c61' }));
    windscreen.position.set(.76, 21, 0);
    body.add(windscreen);
    const ladder = new Mesh(new BoxGeometry(.85, 3, .3), new MeshStandardMaterial({ color: '#dae5e4' }));
    ladder.position.set(-.32, 18, 0);
    body.add(ladder);
    [-.51, .51].flatMap(x => [-.3, .3].map(z => {
      const wheel = new Mesh(new BoxGeometry(.24, 7, .09), new MeshStandardMaterial({ color: '#1a2734' }));
      wheel.position.set(x, 4, z);
      body.add(wheel);
    }));
    const beacon = new Mesh(new BoxGeometry(.12, 3, .4), new MeshStandardMaterial({ color: '#67ccff', emissive: '#2477cc', emissiveIntensity: .8 }));
    beacon.position.set(.45, 26, 0);
    body.add(beacon);
    return { root, body, water, droplets, rotors, kind };
  }
  const fuselage = new Mesh(new BoxGeometry(.42, 7, .32), new MeshStandardMaterial({ color: '#d9e9ec' }));
  body.add(fuselage);
  [-1, 1].flatMap(x => [-1, 1].map(z => {
    const arm = new Mesh(new BoxGeometry(.68, 3, .07), new MeshStandardMaterial({ color: '#628892' }));
    arm.rotation.y = -Math.atan2(z, x);
    arm.position.set(x * .22, 0, z * .22);
    body.add(arm);
    const rotor = new Mesh(new BoxGeometry(.52, 1, .055), new MeshStandardMaterial({ color: '#a5e4e6' }));
    rotor.position.set(x * .45, 3, z * .45);
    rotors.push(rotor);
    body.add(rotor);
  }));
  return { root, body, water, droplets, rotors, kind };
}

export function disposeSceneObject(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse(object => {
    if (object instanceof PointLight) object.dispose();
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    (Array.isArray(object.material) ? object.material : [object.material]).map(material => materials.add(material));
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  root.clear();
}

// The planes face the camera in view space, keeping tongues and smoke readable
// while orbiting without another animation loop or per-frame geometry updates.
const billboardVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 size = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
    center.xy += position.xy * size;
    gl_Position = projectionMatrix * center;
  }
`;

const surfaceVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const noiseShader = `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), u.x), u.y);
  }
  float clouds(vec2 p) {
    return .57 * noise(p) + .28 * noise(p * 2.07 + 11.3) + .15 * noise(p * 4.13 + 23.7);
  }
`;

const flameFragmentShader = `
  uniform float time, seed, opacity;
  varying vec2 vUv;
  ${noiseShader}
  void main() {
    float y = vUv.y;
    float x = (vUv.x - .5) * 2.0;
    float flow = clouds(vec2(x * 2.8 + seed, y * 5.5 - time * 1.6));
    float sway = sin(y * 7.0 - time * 2.7 + seed) * .22 * y;
    float width = pow(max(0.0, 1.0 - y), .66) * (.64 + .3 * flow);
    float edge = abs(x - sway - (flow - .5) * .5 * y);
    float silhouette = 1.0 - smoothstep(width * .52, width, edge);
    float tips = smoothstep(.2, .65, flow + .45 - y * .72);
    float alpha = silhouette * tips * (1.0 - smoothstep(.76, 1.0, y)) * opacity;
    float heat = clamp(.9 - y * .65 - edge * .85 + flow * .15, 0.0, 1.0);
    vec3 color = mix(vec3(.75, .025, .002), vec3(1.0, .17, .008), smoothstep(.12, .65, heat));
    color = mix(color, vec3(1.0, .65, .07), smoothstep(.68, .97, heat));
    if (alpha < .005) discard;
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

const smokeFragmentShader = `
  uniform float seed, opacity;
  varying vec2 vUv;
  ${noiseShader}
  void main() {
    vec2 p = (vUv - .5) * 2.0;
    float billow = clouds(p * 3.2 + seed);
    float radius = min(length(p + vec2(.24, .03)) / .72,
      min(length(p - vec2(.22, .23)) / .63, length(p - vec2(.18, -.24)) / .66));
    radius += (billow - .5) * .23;
    float alpha = (1.0 - smoothstep(.4, 1.0, radius)) * (.64 + billow * .36) * opacity;
    float shade = clamp((billow - .2) * 1.25 + vUv.y * .18, 0.0, 1.0);
    vec3 color = mix(vec3(.055, .065, .078), vec3(.25, .27, .29), shade);
    if (alpha < .001) discard;
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

const glowFragmentShader = `
  uniform float opacity;
  varying vec2 vUv;
  void main() {
    float radius = length((vUv - .5) * 2.0);
    float glow = pow(max(0.0, 1.0 - radius), 2.2);
    gl_FragColor = vec4(1.0, .16, .012, glow * opacity);
    #include <colorspace_fragment>
  }
`;
