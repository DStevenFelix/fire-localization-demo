import { useEffect, useRef, useState } from 'react';
import { AmbientLight, Color, DirectionalLight, PerspectiveCamera, Scene, SRGBColorSpace, TextureLoader, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RotateCcw } from 'lucide-react';
import type { FireSceneSeverity, FireSceneStatus, SceneActorSource } from '../types';
import { droneStationScene, getFireScene } from '../utils/fireSceneData';
import { buildFireScene, disposeSceneObject } from '../utils/fireScene';
import baseMap from '../../../../fire_poi/map_original.png';

export type FireScene3DProps = { targetId: string | null; status: FireSceneStatus; actors: SceneActorSource; severity?: FireSceneSeverity };

export default function FireScene3D(props: FireScene3DProps) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'fire' | 'station'>('fire');
  const latest = useRef({ ...props, view });
  latest.current = { ...props, view };
  const reset = useRef(() => {});
  const [error, setError] = useState('');

  useEffect(() => {
    const element = container.current!;
    let renderer: WebGLRenderer;
    // Unsupported WebGL is an actionable display failure, not an app failure.
    try { renderer = new WebGLRenderer({ antialias: true, alpha: false }); }
    catch { setError('三维显示不可用，请检查浏览器 WebGL 支持。'); return; }
    const scene = new Scene();
    scene.background = new Color('#142333');
    const camera = new PerspectiveCamera(42, 1, 1, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minPolarAngle = .12;
    controls.maxPolarAngle = Math.PI * .44;
    scene.add(new AmbientLight('#e0f4ff', 2));
    const sun = new DirectionalLight('#fff0d1', 2.4);
    sun.position.set(-250, 700, 300);
    scene.add(sun);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.domElement.setAttribute('aria-label', '可旋转缩放的局部三维火场');
    element.append(renderer.domElement);
    let disposed = false;
    const texture = new TextureLoader().load(baseMap, () => {
      if (disposed) { texture.dispose(); return; }
      element.dataset.texture = 'ready';
    }, undefined, () => { if (!disposed) setError('沙盘底图加载失败，请刷新页面。'); });
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    let current: ReturnType<typeof buildFireScene> | null = null;
    let target: string | null | undefined;
    let currentView = latest.current.view;
    let frame = 0;
    let last = 0;
    let time = 0;
    let transitioning = false;
    const cameraGoal = new Vector3();
    const focusGoal = new Vector3();
    const focus = () => {
      const data = getFireScene(latest.current.targetId);
      if (!data) return;
      const viewport = latest.current.view === 'station' ? droneStationScene : data;
      focusGoal.set(viewport.center.x, 12, viewport.center.z);
      const span = Math.max(viewport.bounds.maxX - viewport.bounds.minX, (viewport.bounds.maxZ - viewport.bounds.minZ) * camera.aspect);
      const distance = span / Math.max(.6, camera.aspect) * 1.14;
      cameraGoal.copy(focusGoal).add(new Vector3(distance * .25, distance * .78, distance * .8));
      controls.minDistance = span * .65;
      controls.maxDistance = span * 2.1;
      transitioning = true;
    };
    reset.current = focus;
    const cancelTransition = () => { transitioning = false; };
    controls.addEventListener('start', cancelTransition);
    const observer = new ResizeObserver(() => {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return;
      camera.aspect = box.width / box.height;
      camera.updateProjectionMatrix();
      renderer.setSize(box.width, box.height);
      focus();
    });
    observer.observe(element);
    const render = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, .08) : 1 / 60;
      last = now;
      time += dt;
      if (target !== latest.current.targetId) {
        const first = current === null;
        target = latest.current.targetId;
        if (current) { scene.remove(current.root); disposeSceneObject(current.root); current = null; }
        const data = getFireScene(target);
        if (data) {
          current = buildFireScene(data, texture);
          scene.add(current.root);
          focus();
          if (first || camera.position.lengthSq() === 0) { camera.position.copy(cameraGoal); controls.target.copy(focusGoal); }
        }
      }
      if (transitioning) {
        camera.position.lerp(cameraGoal, 1 - Math.exp(-dt * 7));
        controls.target.lerp(focusGoal, 1 - Math.exp(-dt * 7));
        if (camera.position.distanceTo(cameraGoal) < .1) transitioning = false;
      }
      if (currentView !== latest.current.view) { currentView = latest.current.view; focus(); }
      current?.update(latest.current.status, latest.current.actors.current, dt, time, latest.current.severity, currentView);
      controls.update();
      renderer.render(scene, camera);
      element.dataset.rendered = current ? 'true' : 'false';
      frame = requestAnimationFrame(render);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      last = 0;
      if (!document.hidden) frame = requestAnimationFrame(render);
    };
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      controls.removeEventListener('start', cancelTransition);
      controls.dispose();
      if (current) disposeSceneObject(current.root);
      texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      reset.current = () => {};
    };
  }, []);

  return <div className="fire-scene-viewport">
    <div className="fire-scene-canvas" ref={container} data-testid="fire-scene-canvas" data-target-id={props.targetId ?? ''} data-status={props.status} data-view={view} />
    <div className="fire-scene-view-controls" role="group" aria-label="三维场景视区">
      <button type="button" aria-pressed={view === 'fire'} onClick={() => setView('fire')}>火场</button>
      <button type="button" aria-pressed={view === 'station'} onClick={() => setView('station')}>无人机站</button>
    </div>
    {!props.targetId && !error && <div className="fire-scene-message">等待火情场景准备</div>}
    {error && <div className="fire-scene-message" role="status">{error}</div>}
    <button type="button" className="fire-scene-reset" aria-label="复位三维视角" disabled={!props.targetId || !!error} onClick={() => reset.current()}><RotateCcw size={13} />复位视角</button>
    <span className="fire-scene-hint">拖动旋转 · 滚轮缩放</span>
  </div>;
}
