import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('orthographic overhead models align with source pixel centers in all four groups', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    // Vite resolves the same modules and source image used by the real component.
    const threePath = '/node_modules/.vite/deps/three.js';
    const dataPath = '/src/utils/fireSceneData.ts';
    const scenePath = '/src/utils/fireScene.ts';
    const { OrthographicCamera, Scene, WebGLRenderer, TextureLoader, SRGBColorSpace, AmbientLight, Vector3 } = await import(threePath);
    const { getFireScene, localToScene, sceneTanks } = await import(dataPath);
    const { buildFireScene, disposeSceneObject } = await import(scenePath);
    const texture = await new TextureLoader().loadAsync(document.querySelector('[data-layer="original-map"]')!.getAttribute('href'));
    texture.colorSpace = SRGBColorSpace;
    const comparison = document.createElement('div');
    comparison.id = 'overhead-comparison';
    comparison.style.cssText = 'position:absolute;left:0;top:0;z-index:100;background:#142333;padding:16px;display:grid;grid-template-columns:420px 420px;gap:14px;color:white';
    document.body.append(comparison);
    const checked = [];
    for (const id of ['T-NW-01', 'T-NE-01', 'T-SW-01', 'T-SE-01']) {
      const data = getFireScene(id);
      const width = data.bounds.maxX - data.bounds.minX;
      const height = data.bounds.maxZ - data.bounds.minZ;
      const label = document.createElement('div');
      label.textContent = `${data.area.id} · 原始底图 / 三维俯视`;
      label.style.gridColumn = '1 / -1';
      comparison.append(label);
      const reference = document.createElement('canvas');
      reference.width = 420;
      reference.height = Math.round(420 * height / width);
      reference.getContext('2d')!.drawImage(texture.image, data.bounds.minX + texture.image.width / 2, data.bounds.minZ + texture.image.height / 2, width, height, 0, 0, reference.width, reference.height);
      comparison.append(reference);
      const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.setSize(reference.width, reference.height);
      const scene = new Scene();
      scene.add(new AmbientLight('#ffffff', 2.5));
      const models = buildFireScene(data, texture);
      models.update('normal', [], 1, 0);
      scene.add(models.root);
      const camera = new OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 1, 2000);
      camera.position.set(data.center.x, 1000, data.center.z);
      camera.up.set(0, 0, -1);
      camera.lookAt(data.center.x, 0, data.center.z);
      camera.updateMatrixWorld();
      renderer.render(scene, camera);
      const projected = data.tanks.map((tank: { id: string; center: number[]; geometry: { coordinates: number[][][] } }) => {
        const model = models.root.getObjectByName(tank.id);
        const point = new Vector3(model.position.x, model.userData.roofHeight, model.position.z).project(camera);
        const u = tank.center[0] * 1312 / 30;
        const v = (25 - tank.center[1]) * 1049 / 25;
        return { id: tank.id, renderedX: (point.x + 1) / 2 * reference.width,
          renderedY: (1 - point.y) / 2 * reference.height,
          sourceX: (u - (data.bounds.minX + 656)) / width * reference.width,
          sourceY: (v - (data.bounds.minZ + 524.5)) / height * reference.height,
          outlineError: Math.max(...tank.geometry.coordinates[0].map(vertex => {
            const p = localToScene(vertex);
            const screen = new Vector3(p.x, 0, p.z).project(camera);
            return Math.abs((screen.x + 1) / 2 * width - (vertex[0] * 1312 / 30 - 656 - data.bounds.minX));
          })) };
      });
      checked.push(...projected);
      const capture = document.createElement('canvas');
      capture.width = reference.width;
      capture.height = reference.height;
      capture.getContext('2d')!.drawImage(renderer.domElement, 0, 0);
      comparison.append(capture);
      disposeSceneObject(models.root);
      renderer.dispose();
      renderer.forceContextLoss();
    }
    texture.dispose();
    return { checked, tankCount: sceneTanks.length };
  });
  expect(results.tankCount).toBe(8);
  expect(results.checked).toHaveLength(8);
  results.checked.map(point => {
    expect(point.renderedX).toBeCloseTo(point.sourceX, 5);
    expect(point.renderedY).toBeCloseTo(point.sourceY, 5);
    expect(point.outlineError).toBeLessThan(.001);
  });
  const directory = process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/existing/` : fileURLToPath(new URL('../screenshots/', import.meta.url));
  await mkdir(directory, { recursive: true });
  await page.locator('#overhead-comparison').screenshot({ path: `${directory}/fire-scene-overhead-alignment.png` });
});
