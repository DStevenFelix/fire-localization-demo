import React from 'react';
import { createRoot } from 'react-dom/client';

import SandboxMap from './components/SandboxMap';
import { SCENE_SIZE as IMAGE_SIZE, pixelToWorld, worldToPixel } from './utils/mapCoordinates';
import { updateEvidence, type EvidenceMarker } from './utils/candidateEvidence';
import type { Candidate, Entity, Point, SceneData } from './types';

type FireSelection = SceneData['fires'][number] & {
  name: string; kind: 'fire'; aliases: string[]; residents: string[];
  parent_id: string; geometry: {components: []};
};

class SceneMap {
  root;
  data: SceneData | null = null;
  zoom = 1;
  pan = {x: 0, y: 0};
  showPois = true;
  showAreas = false;
  selectedId: string | null = null;
  selectedFireId: string | null = null;
  anchor: Point | null = null;
  private activation = '';
  private history = new Map<string, EvidenceMarker>();
  private target: Candidate | null = null;

  constructor(public container: HTMLElement,
              public onSelect: (entity: Entity | FireSelection | null, anchor: Point | null) => void) {
    this.root = createRoot(container);
    this.render();
  }

  render() {
    this.root.render(<SandboxMap key={this.activation} controller={this} data={this.data}
      markers={[...this.history.values()]} target={this.target}/>);
  }

  setData(data: SceneData) {
    const activation = JSON.stringify([data.persistence.run_id, data.persistence.activation_id, data.localization.session_id]);
    this.data = data;
    if (activation !== this.activation) {
      this.activation = activation;
      this.history.clear();
      this.zoom = 1;
      this.pan = {x: 0, y: 0};
      this.selectedId = null;
      this.selectedFireId = null;
      this.anchor = null;
      this.onSelect(null, null);
      this.viewChanged();
    }
    this.target = updateEvidence(this.history, data);

    if (this.selectedFireId) {
      this.selectFire(this.selectedFireId, this.anchor);
    } else {
      if (this.selectedId) {
        const entity = data.entities.find(item => item.id === this.selectedId);
        if (!entity) this.selectedId = null;
        this.onSelect(entity ?? null, this.anchor);
      }
      this.render();
    }
  }

  typeName(entity: {kind: string}) {
    const names: Record<string, string> = {area:'区域',building:'建筑',tank:'储罐',pipeline:'管线设施',
      road:'道路',intersection:'路口',node:'内部节点',entrance:'入口',facility:'设施',reserve:'预留地',fire:'火源'};
    return names[entity.kind] || entity.kind;
  }

  screenPoint(event: {clientX: number; clientY: number}): Point | null {
    const svg = this.container.querySelector<SVGSVGElement>('svg[data-testid="sandbox-svg"]');
    const matrix = svg?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return {x: point.x, y: point.y};
  }

  eventToWorld(event: {clientX: number; clientY: number}): Point | null {
    const point = this.screenPoint(event);
    if (!point) return null;
    const world = pixelToWorld(point);
    return {x: world.x_m, y: world.y_m};
  }

  select(id: string | null, focus = false, anchor: Point | null = null) {
    const entity = this.data?.entities.find(item => item.id === id) ?? null;
    this.selectedId = entity?.id ?? null;
    this.selectedFireId = null;
    this.anchor = anchor ?? (entity ? worldToPixel({x_m: entity.position.x, y_m: entity.position.y}) : null);
    if (focus && entity) this.focus(entity.position);
    this.onSelect(entity, this.anchor);
    this.render();
    if (entity) this.container.dispatchEvent(new CustomEvent('map-entity-select', {detail: {id: entity.id}}));
  }

  selectFire(id: string, anchor: Point | null = null) {
    const fire = this.data?.fires.find(item => item.id === id);
    if (!fire) {
      this.select(null);
      return;
    }
    this.selectedFireId = id;
    this.selectedId = null;
    this.anchor = anchor ?? worldToPixel({x_m: fire.position.x, y_m: fire.position.y});
    this.onSelect({...fire, name: '储罐火源', kind: 'fire', aliases: [], residents: [],
      parent_id: fire.area_id, geometry: {components: []}}, this.anchor);
    this.render();
  }

  setPan(point: Point) {
    const x = (IMAGE_SIZE.width - IMAGE_SIZE.width / this.zoom) / 2;
    const y = (IMAGE_SIZE.height - IMAGE_SIZE.height / this.zoom) / 2;
    this.pan = {x: Math.max(-x, Math.min(x, point.x)), y: Math.max(-y, Math.min(y, point.y))};
    this.render();
    this.viewChanged();
  }

  setZoom(zoom: number, anchor?: Point) {
    const previousScale = this.zoom;
    this.zoom = Math.min(9, Math.max(1, zoom));
    if (!anchor) {
      this.setPan(this.pan);
      return;
    }
    const ratio = previousScale / this.zoom;
    const anchorX = anchor.x - IMAGE_SIZE.width / 2;
    const anchorY = anchor.y - IMAGE_SIZE.height / 2;
    this.setPan({x: anchorX + (this.pan.x - anchorX) * ratio, y: anchorY + (this.pan.y - anchorY) * ratio});
  }

  fit() {
    this.zoom = 1;
    this.setPan({x: 0, y: 0});
  }

  focus(point: Point) {
    this.zoom = Math.max(this.zoom, 4.8);
    const position = worldToPixel({x_m: point.x, y_m: point.y});
    this.setPan({x: position.x - IMAGE_SIZE.width / 2, y: position.y - IMAGE_SIZE.height / 2});
  }

  setLayers(pois: boolean, areas: boolean) {
    this.showPois = pois;
    this.showAreas = areas;
    this.render();
  }

  viewChanged() {
    const label = document.getElementById('map-zoom-value');
    if (label) label.textContent = Math.round(this.zoom * 100) + '%';
    this.container.dispatchEvent(new Event('map-view-change'));
  }
}

export type { SceneMap };
(window as Window & { SceneMap?: typeof SceneMap }).SceneMap = SceneMap;
