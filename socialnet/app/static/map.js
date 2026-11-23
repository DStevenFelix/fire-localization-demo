// 保留的旧版 SVG/伪立体地图实现。当前 index.html 加载 spatial/map.js，不加载本文件。
// 当前地图源码位于 frontend/src/；阅读本文件不能据此推断线上地图的缩放范围和绘制规则。

(() => {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const SCALE = 40;
  const TYPE_NAMES = {
    residential_building: "居民楼", office_building: "综合楼", workshop: "检修车间",
    utility_building: "动力控制楼", public_service_building: "应急服务中心",
    fire_station: "消防站", tank: "储罐", tank_group: "工艺罐组",
    city_district: "仿真片区", residential_area: "社区", industrial_park: "储运园",
    industrial_zone: "作业区", tank_zone: "储罐区", mixed_use_area: "生活服务区",
    emergency_service_area: "消防站片区", east_west: "东西向道路",
    north_south: "南北向道路", intersection: "路口", connector: "连接路段",
    campus_ring: "园区环形通道", pipeline: "工艺管线", fire: "火源",
  };
  const AREA_COLORS = { A10: "#e5a04f", A20: "#8c6caf", A21: "#138c78", A22: "#cb628f", A23: "#658a36", A24: "#2582ae", A30: "#be5360", A40: "#b5a43d" };
  // 创建 SVG 命名空间节点并赋属性/文本，供旧地图绘制工具复用。
  function node(tag, attrs = {}, text = "") {
    const result = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) => result.setAttribute(key, value));
    if (text) result.textContent = text;
    return result;
  }
  // 向指定 SVG 图层追加文字标签。
  function label(parent, x, y, text, attrs = {}) {
    const result = node("text", { x, y, class: "scene-label", ...attrs }, text);
    parent.append(result);
    return result;
  }

  // 旧地图控制器：维护视口、实体选择与分层绘制，对外暴露同名 SceneMap 接口。
  class SceneMap {
    // 初始化旧 SVG 视口及鼠标、拖动、键盘交互；此类当前未由主页面加载。
    constructor(element, onSelect) {
      this.svg = element;
      this.onSelect = onSelect;
      this.selectedId = null;
      this.selectedFireId = null;
      this.anchor = null;
      this.zoom = 1;
      this.showLabels = true;
      this.showBoundaries = true;
      this.signature = "";
      this.frame = { x: -34, y: -34, width: 1268, height: 1078 };
      this.view = { ...this.frame };
      this.svg.setAttribute("viewBox", Object.values(this.view).join(" "));
      this.svg.addEventListener("wheel", (event) => {
        event.preventDefault();
        this.setZoom(this.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), this.screenPoint(event));
      }, { passive: false });
      this.svg.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...this.view } };
        this.dragged = false;
      });
      this.svg.addEventListener("pointermove", (event) => {
        if (!this.pointer || this.pointer.id !== event.pointerId) return;
        const dx = event.clientX - this.pointer.x;
        const dy = event.clientY - this.pointer.y;
        if (!this.dragged && Math.hypot(dx, dy) < 5) return;
        this.dragged = true;
        this.svg.setPointerCapture(event.pointerId);
        const rect = this.svg.getBoundingClientRect();
        const ratio = Math.max(this.pointer.view.width / rect.width, this.pointer.view.height / rect.height);
        this.view.x = this.pointer.view.x - dx * ratio;
        this.view.y = this.pointer.view.y - dy * ratio;
        this.applyView();
      });
      const finish = (event) => {
        if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
        this.pointer = null;
      };
      this.svg.addEventListener("pointerup", finish);
      this.svg.addEventListener("pointercancel", finish);
      this.svg.addEventListener("pointerover", (event) => {
        const entity = event.target.closest("[data-id]");
        this.setHovered(entity?.dataset.id || null);
      });
      this.svg.addEventListener("pointerleave", () => this.setHovered(null));
      this.svg.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this.select(null);
        if (event.key === "Enter" || event.key === " ") {
          const fireId = event.target.closest("[data-fire-id]")?.dataset.fireId;
          if (fireId) { event.preventDefault(); this.selectFire(fireId); return; }
          const id = event.target.closest("[data-id]")?.dataset.id;
          if (id) { event.preventDefault(); this.select(id); }
        }
      });
    }

    // 旧绘图按每仿真单位 40 像素换算 X。
    px(x) { return x * SCALE; }
    // 反转北向为正的世界 Y，使其符合 SVG 向下为正的坐标。
    py(y) { return (this.data.map.height - y) * SCALE; }
    // 在旧设施图层中切换悬停高亮，避免重复刷新同一目标。
    setHovered(id) {
      if (this.hoveredId === id) return;
      this.hoveredId = id;
      this.svg.querySelectorAll(".facility-hover").forEach((element) => element.classList.remove("facility-hover"));
      const entity = this.data?.entities.find((item) => item.id === id);
      if (entity && ["building", "tank", "tank_group"].includes(entity.kind)) {
        this.svg.querySelector('#scene-features [data-id="' + id + '"]')?.classList.add("facility-hover");
      }
    }
    // 由世界坐标的矩形包围盒构造 SVG 矩形。
    rect(entity, attrs = {}) {
      return node("rect", { x: this.px(entity.x), y: this.py(entity.y + entity.height), width: this.px(entity.width), height: this.px(entity.height), ...attrs });
    }
    // 给实体绘制组附带 ID、类型和键盘访问属性，供委托点击和详情选取。
    group(entity) {
      const result = node("g", {
        "data-id": entity.id, "data-kind": entity.kind, "data-source": entity.source,
        tabindex: entity.id === "A00" ? -1 : 0, role: "button", "aria-label": entity.name,
      });
      result.append(node("title", {}, entity.id + " · " + entity.name));
      return result;
    }
    // 通过屏幕变换矩阵把鼠标坐标转换到 SVG 内部坐标。
    screenPoint(event) {
      const point = this.svg.createSVGPoint();
      point.x = event.clientX; point.y = event.clientY;
      return point.matrixTransform(this.svg.getScreenCTM().inverse());
    }
    // 把非拖动点击换算回沙盘坐标，过滤超出地图范围的点。
    eventToWorld(event) {
      if (this.dragged) { this.dragged = false; return null; }
      const p = this.screenPoint(event);
      const x = p.x / SCALE;
      const y = this.data.map.height - p.y / SCALE;
      if (x < 0 || x > this.data.map.width || y < 0 || y > this.data.map.height) return null;
      return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
    }
    // 约束视口边界并更新缩放显示，通过事件通知详情浮层重新定位。
    applyView() {
      this.view.x = Math.max(this.frame.x, Math.min(this.frame.x + this.frame.width - this.view.width, this.view.x));
      this.view.y = Math.max(this.frame.y, Math.min(this.frame.y + this.frame.height - this.view.height, this.view.y));
      this.svg.setAttribute("viewBox", [this.view.x, this.view.y, this.view.width, this.view.height].join(" "));
      document.getElementById("map-zoom-value").textContent = Math.round(this.zoom * 100) + "%";
      this.svg.dispatchEvent(new CustomEvent("map-view-change"));
    }
    // 以给定锚点缩放旧地图视口，并保留锚点在屏幕中的相对位置。
    setZoom(value, anchor = null) {
      const zoom = Math.max(1, Math.min(5, value));
      const point = anchor || { x: this.view.x + this.view.width / 2, y: this.view.y + this.view.height / 2 };
      const rx = (point.x - this.view.x) / this.view.width;
      const ry = (point.y - this.view.y) / this.view.height;
      this.zoom = zoom;
      this.view = { width: this.frame.width / zoom, height: this.frame.height / zoom, x: 0, y: 0 };
      this.view.x = point.x - this.view.width * rx;
      this.view.y = point.y - this.view.height * ry;
      this.applyView();
    }
    // 恢复旧地图的完整初始视口。
    fit() { this.zoom = 1; this.view = { ...this.frame }; this.applyView(); }
    // 以实体中心移动视口，并为非区域/道路对象适度放大。
    focus(entity) {
      const p = entity.position || { x: entity.x + entity.width / 2, y: entity.y + entity.height / 2 };
      this.setZoom(Math.max(this.zoom, entity.kind === "area" || entity.kind === "road" ? 1 : 1.8));
      this.view.x = this.px(p.x) - this.view.width / 2;
      this.view.y = this.py(p.y) - this.view.height / 2;
      this.applyView();
    }
    // 选取地图实体、更新高亮与详情，并广播选取事件。
    select(id, focus = false, anchor = null) {
      this.selectedId = id;
      this.selectedFireId = null;
      this.renderHighlights();
      const entity = this.data?.entities.find((item) => item.id === id) || null;
      if (focus && entity) this.focus(entity);
      const p = entity?.position || (entity ? { x: entity.x + entity.width / 2, y: entity.y + entity.height / 2 } : null);
      this.anchor = anchor || (p ? { x: this.px(p.x), y: this.py(p.y) } : null);
      this.onSelect(entity, this.anchor);
      this.svg.dispatchEvent(new CustomEvent("map-entity-select", { detail: { id } }));
    }
    // 选取真实仿真火源并构造详情对象，不执行定位推断。
    selectFire(id, anchor = null) {
      const fire = this.data?.fires.find((item) => item.id === id);
      if (!fire) { this.select(null); return; }
      this.selectedId = null;
      this.selectedFireId = id;
      this.anchor = anchor || { x: this.px(fire.position.x), y: this.py(fire.position.y) };
      this.renderHighlights();
      this.onSelect({ ...fire, name: "园区火源", entity_type: "fire", kind: "fire", aliases: [] }, this.anchor);
    }
    // 通过样式类开关旧地图标签及区域边界。
    setLayers(labels, boundaries) {
      this.showLabels = labels;
      this.showBoundaries = boundaries;
      this.svg.classList.toggle("hide-poi-labels", !labels);
      this.svg.classList.toggle("hide-area-boundaries", !boundaries);
    }
    // 几何签名变化才重建底图，其余更新火源和选取状态。
    setData(data) {
      this.data = data;
      const signature = JSON.stringify([data.map, data.entities]);
      if (signature !== this.signature) {
        this.signature = signature;
        this.renderScene();
      }
      this.renderHighlights();
      this.renderFire();
      if (this.selectedId) this.onSelect(data.entities.find((e) => e.id === this.selectedId), this.anchor);
      if (this.selectedFireId) this.selectFire(this.selectedFireId, this.anchor);
    }
    // 绘制旧场景的装饰树列，不构成定位空间数据。
    trees(parent, x, y, count, dx = 0, dy = 0) {
      for (let i = 0; i < count; i++) {
        const px = this.px(x + i * dx), py = this.py(y + i * dy);
        parent.append(node("path", { d: "M " + px + " " + (py + 5) + " v -9", stroke: "#467148", "stroke-width": 2 }));
        parent.append(node("path", { d: "M " + px + " " + (py - 8) + " l -5 6 h 10 Z M " + px + " " + (py - 4) + " l -6 6 h 12 Z", fill: "#2f9154", stroke: "#35874f", "stroke-width": 0.6 }));
      }
    }
    // 按区域类型绘制旧版地块、绿化和区域标识。
    drawArea(entity) {
      const group = this.group(entity);
      if (entity.id === "A00") {
        group.append(this.rect(entity, { fill: "#50ba60", stroke: "#f5f7ed", "stroke-width": 4 }));
        [[0.6, 23.0, 7], [7.9, 23.0, 12], [16.2, 23.0, 12], [26.5, 23.0, 6],
          [7.9, 1.9, 12], [16.2, 1.9, 12], [26.5, 1.9, 6]].forEach(([x, y, count]) => this.trees(group, x, y, count, 0.5));
        return group;
      }
      const industrial = ["A21", "A22", "A23", "A24"].includes(entity.id);
      group.append(this.rect(entity, { fill: industrial ? "#c2c9c5" : "#50ba60", rx: industrial ? 5 : entity.id === "A20" ? 22 : 0 }));
      if (entity.id === "A20") {
        group.append(this.rect({ x: entity.x + 0.45, y: entity.y + 0.45, width: entity.width - 0.9, height: entity.height - 0.9 }, { fill: "#505452", rx: 14 }));
        this.trees(group, entity.x + 0.20, entity.y + 0.5, 23, 0, 0.5);
        this.trees(group, entity.x + entity.width - 0.20, entity.y + 0.5, 23, 0, 0.5);
        this.trees(group, entity.x + 0.5, entity.y + 0.2, 29, 0.5);
        this.trees(group, entity.x + 0.5, entity.y + entity.height - 0.2, 29, 0.5);
      }
      if (entity.id === "A10") this.trees(group, entity.x + entity.width - 0.18, entity.y + 0.35, 24, 0, 0.5);
      if (entity.id === "A30") {
        this.trees(group, entity.x + 0.18, entity.y + 0.35, 24, 0, 0.5);
        group.append(node("polygon", { points: [this.px(25.9) + "," + this.py(13.70), this.px(28.0) + "," + this.py(13.1), this.px(28.0) + "," + this.py(11.95), this.px(25.9) + "," + this.py(11.10)].join(" "), fill: "#ba9e94" }));
      }
      if (entity.id === "A40") {
        group.append(node("polygon", { points: [this.px(0.5) + "," + this.py(2.45), this.px(2.8) + "," + this.py(2.45), this.px(2.0) + "," + this.py(1.2), this.px(1.25) + "," + this.py(1.2)].join(" "), fill: "#b99b90" }));
      }
      group.append(this.rect(entity, { class: "area-boundary", fill: "none", stroke: AREA_COLORS[entity.id] || "#777", "stroke-width": 2.5, "stroke-opacity": 0.85, "pointer-events": "none" }));
      return group;
    }
    // 绘制旧道路样式及标线，不计算道路寻路或传播模型。
    drawRoad(entity) {
      const group = this.group(entity);
      if (entity.geometry.shape === "polyline") {
        group.append(node("polyline", { points: entity.path.map((p) => this.px(p.x) + "," + this.py(p.y)).join(" "), fill: "none", stroke: "#505452", "stroke-width": 30, "stroke-linejoin": "round" }));
        return group;
      }
      group.append(this.rect(entity, { fill: "#505452", stroke: "#dddcd5", "stroke-width": entity.geometry.style === "boulevard" ? 2 : 0 }));
      if (entity.geometry.style !== "boulevard") return group;
      const horizontal = entity.width > entity.height;
      const midpoint = horizontal ? this.py(entity.y + entity.height / 2) : this.px(entity.x + entity.width / 2);
      if (horizontal) {
        group.append(node("line", { x1: 0, y1: midpoint, x2: 1200, y2: midpoint, stroke: "#c9c26a", "stroke-width": 2 }));
        [2, 10, 19, 28].forEach((x) => {
          this.arrow(group, this.px(x), this.py(entity.y + entity.height * 0.74), 180);
          this.arrow(group, this.px(x + 0.2), this.py(entity.y + entity.height * 0.24), 0);
        });
      } else {
        const divider = { x: entity.x + entity.width / 2 - 0.11, y: 7.1, width: 0.22, height: 11.4 };
        group.append(this.rect(divider, { fill: "#50ba60", stroke: "#eee", "stroke-width": 2 }));
        this.arrow(group, this.px(entity.x + entity.width * 0.23), this.py(16.5), 90);
        this.arrow(group, this.px(entity.x + entity.width * 0.77), this.py(8.3), 270);
      }
      return group;
    }
    // 向旧地图图层添加旋转箭头符号。
    arrow(parent, x, y, rotation) {
      parent.append(node("path", { d: "M -19 -2 H 10 V -6 L 23 0 L 10 6 V 2 H -19 Z", transform: "translate(" + x + " " + y + ") rotate(" + rotation + ")", fill: "#f2f3ec", "pointer-events": "none" }));
    }
    // 绘制旧版路口及连接标识。
    drawIntersection(entity) {
      const group = this.group(entity);
      if (entity.geometry.style === "crosswalk") {
        const x = this.px(entity.x + entity.width / 2), y = this.py(entity.y + entity.height / 2);
        const narrow = entity.id === "J02" || entity.id === "J08";
        const halfWidth = narrow ? 39 : 60;
        const halfHeight = 66;
        group.append(node("rect", { x: x - halfWidth, y: y - halfHeight, width: halfWidth * 2, height: halfHeight * 2, fill: "#505452" }));
        for (let dx = -halfWidth + 5; dx < halfWidth - 4; dx += 10) {
          [-halfHeight - 5, halfHeight - 11].forEach((dy) => group.append(node("rect", { x: x + dx, y: y + dy, width: 5, height: 24, fill: "#f3f4ec" })));
        }
        [-halfWidth - 18, halfWidth - 6].forEach((dx) => {
          for (let dy = -halfHeight + 10; dy < halfHeight - 6; dy += 10) group.append(node("rect", { x: x + dx, y: y + dy, width: 24, height: 5, fill: "#f3f4ec" }));
        });
        [[-halfWidth - 20, -halfHeight - 10], [halfWidth + 10, halfHeight + 16]].forEach(([dx, dy]) => {
          group.append(node("path", { d: "M " + (x + dx) + " " + (y + dy + 10) + " v -26 h 18", stroke: "#d1d8cf", "stroke-width": 3, fill: "none" }));
          group.append(node("rect", { x: x + dx + 12, y: y + dy - 20, width: 12, height: 7, fill: "#424844", rx: 2 }));
          group.append(node("circle", { cx: x + dx + 19, cy: y + dy - 16.5, r: 2, fill: "#7fc66c" }));
        });
      }
      return group;
    }
    // 按几何组件绘制旧版管线折线。
    drawPipeline(entity) {
      const group = this.group(entity);
      entity.geometry.components.forEach((component) => {
        const points = component.points.map((p) => this.px(p.x) + "," + this.py(p.y)).join(" ");
        group.append(node("polyline", { points, fill: "none", stroke: "#aecac7", "stroke-width": 9, "stroke-linejoin": "miter" }));
        group.append(node("polyline", { points, fill: "none", stroke: "#e0e8dc", "stroke-width": 1.5 }));
      });
      return group;
    }
    // 绘制单个储罐的旧版外观与缓冲样式，不更新仿真真值。
    tank(parent, x, y, radius, buffer = false) {
      const r = radius, ry = radius * 0.83, depth = Math.max(7, radius * 0.47);
      const cylinder = node("g", { class: "tank-solid" });
      cylinder.append(node("ellipse", { class: "facility-shadow", cx: x + 5, cy: y + depth + 5, rx: r + 3, ry, fill: "#3e504e", opacity: 0.22, filter: "url(#solid-shadow)", "pointer-events": "none" }));
      cylinder.append(node("path", { class: "tank-wall", d: `M ${x-r} ${y} V ${y+depth} A ${r} ${ry} 0 0 0 ${x+r} ${y+depth} V ${y} A ${r} ${ry} 0 0 1 ${x-r} ${y} Z`, fill: "url(#tank-metal)", stroke: "#899b9c", "stroke-width": 1 }));
      cylinder.append(node("ellipse", { class: "tank-roof", cx: x, cy: y, rx: r, ry, fill: "url(#tank-roof)", stroke: buffer ? "#be9270" : "#91a4a7", "stroke-width": buffer ? 2.5 : 1.5 }));
      cylinder.append(node("ellipse", { cx: x, cy: y, rx: Math.max(r-3, 1), ry: Math.max(ry-3, 1), fill: "none", stroke: "#ffffff", "stroke-width": 1.2, opacity: 0.85 }));
      if (r > 15) {
        cylinder.append(node("path", { d: `M ${x+r*.64} ${y+ry*.65} v ${depth} m -4 0 v ${-depth}`, stroke: "#697e82", "stroke-width": 1.3, fill: "none" }));
        for (let dy = 2; dy < depth; dy += 4) cylinder.append(node("path", { d: `M ${x+r*.64-4} ${y+ry*.65+dy} h 4`, stroke: "#697e82", "stroke-width": 1 }));
        cylinder.append(node("path", { d: `M ${x-r*.35} ${y-ry*.40} L ${x+r*.35} ${y+ry*.4}`, stroke: "#cad4d6", "stroke-width": 1 }));
      }
      parent.append(cylinder);
    }
    // 按建筑、储罐及设施类型绘制旧版伪立体外观。
    drawFacility(entity) {
      const group = this.group(entity);
      const style = entity.geometry.style;
      if (entity.geometry.shape === "circle") {
        this.tank(group, this.px(entity.x + entity.width / 2), this.py(entity.y + entity.height / 2), this.px(entity.width / 2), style === "buffer_tank");
      } else if (entity.geometry.shape === "compound") {
        entity.geometry.components.forEach((part) => this.tank(group, this.px(part.x), this.py(part.y), this.px(part.radius)));
      } else {
        const roof = style === "service" ? "#c0cbd1" : style === "fire_station" ? "#f4eae0" : style === "workshop" ? "#559aa9" : "#7ab5c6";
        const left = this.px(entity.x), top = this.py(entity.y + entity.height);
        const w = this.px(entity.width), h = this.px(entity.height);
        const dx = 7;
        const depth = style === "fire_station" || style === "residential" ? 19 : style === "office" ? 16 : 11;
        const bottom = top + h;
        group.append(node("rect", { class: "facility-shadow", x: left + dx + 5, y: top + depth + 6, width: w, height: h, fill: "#3e504e", opacity: 0.22, filter: "url(#solid-shadow)", "pointer-events": "none" }));
        group.append(node("polygon", { class: "building-facade", points: `${left},${bottom} ${left+w},${bottom} ${left+w+dx},${bottom+depth} ${left+dx},${bottom+depth}`, fill: "#dbe4e5", stroke: "#7d9399", "stroke-width": 1 }));
        group.append(node("polygon", { class: "building-side", points: `${left+w},${top} ${left+w+dx},${top+depth} ${left+w+dx},${bottom+depth} ${left+w},${bottom}`, fill: "#8dabb4", stroke: "#7d9399", "stroke-width": 1 }));
        for (let x = 10; x < w-5; x += 14) {
          group.append(node("path", { d: `M ${left+x+2} ${bottom+5} l 2 ${Math.max(4,depth-10)} h 6 l -2 ${-Math.max(4,depth-10)} Z`, fill: "#537d8c", opacity: 0.8 }));
        }
        group.append(this.rect(entity, { class: "building-roof", fill: roof, stroke: "#e7f1f2", "stroke-width": 2 }));
        group.append(node("rect", { x: left+5, y: top+5, width: w-10, height: h-10, fill: "none", stroke: "#ffffff", "stroke-opacity": 0.3, "stroke-width": 1 }));
        if (style === "workshop") {
          for (let x = 14; x < w-8; x += 18) group.append(node("path", { d: `M ${left+x} ${top+4} v ${h-8}`, stroke: "#c5e0e3", "stroke-width": 1, opacity: 0.65 }));
        } else if (style !== "fire_station") {
          group.append(node("rect", { x: left+9, y: top+8, width: Math.min(w*.22,26), height: 8, fill: "#d8e5e8", stroke: "#567d87", "stroke-width": 1 }));
          group.append(node("path", { d: `M ${left+12} ${top+10} h ${Math.min(w*.22,26)-6} m 0 3 h ${-Math.min(w*.22,26)+6}`, stroke: "#7a969d", "stroke-width": 1 }));
        }
        if (style === "fire_station") {
          [12, 28, 44].forEach((offset) => group.append(node("path", { class: "fire-station-door", d: `M ${left+offset} ${bottom+4} h 10 l 4 12 h -10 Z`, fill: "#bd6556", stroke: "#98574d", "stroke-width": .8 })));
          group.append(node("rect", { x: left+4, y: top+4, width: w-8, height: 5, fill: "#d9705d" }));
        }
        if (style === "service") group.append(this.rect({ x: entity.x, y: entity.y, width: 0.28, height: entity.height }, { fill: "#949d94", stroke: "none" }));
      }
      group.querySelectorAll(".facility-shadow").forEach((shadow) => shadow.setAttribute("clip-path", "url(#facility-clip-" + entity.area_id + ")"));
      return group;
    }
    // 为旧地图实体添加名称及辅助标签。
    drawLabels(parent) {
      this.data.entities.forEach((entity) => {
        if (entity.kind === "area" && entity.id !== "A00") {
          label(parent, this.px(entity.x) + 6, this.py(entity.y + entity.height) + (entity.id === "A40" ? 10 : 16), entity.id + " " + entity.name, { class: "scene-label area-name", fill: "#263d2d", "font-size": entity.id === "A20" ? 13 : 11.5 });
        }
        if (entity.kind === "road" && entity.source === "workbook") {
          const horizontal = entity.width > entity.height;
          let x, y, rotation = 0;
          if (horizontal) {
            x = this.px(entity.id === "R05" ? 20.2 : entity.id === "R01" ? 11.8 : 17.5);
            y = this.py(entity.path[0].y) + (entity.id === "R01" ? 19 : entity.id === "R05" ? 14 : 33);
          } else {
            x = this.px(entity.id === "R03" ? 6.28 : entity.id === "R04" ? 23.20 : 14.946);
            y = this.py(entity.id === "R06" ? 15.65 : 12.0);
            rotation = entity.id === "R06" ? 0 : -90;
          }
          label(parent, x, y, entity.id + " " + entity.name, { class: "scene-label road-name", transform: "rotate(" + rotation + " " + x + " " + y + ")", "text-anchor": "middle", "font-size": 12 });
        }
        if (!entity.position) return;
        const x = this.px(entity.position.x), y = this.py(entity.position.y);
        const marker = this.group(entity);
        if (entity.id.startsWith("POI-")) {
          marker.setAttribute("class", "poi-marker");
          marker.append(node("circle", { cx: x, cy: y, r: 11, fill: "transparent" }));
          marker.append(node("circle", { cx: x, cy: y, r: 4.5, fill: "#d53e42", stroke: "#fff", "stroke-width": 1.5 }));
          const south = ["POI-HA-SW-04", "POI-HA-SW-05", "POI-HA-SW-06", "POI-HA-SW-07", "POI-HA-SE-04", "POI-HA-SE-05"].includes(entity.id);
          label(marker, x, y + (south ? 17 : -10), entity.id.replace("POI-", ""), { class: "scene-label poi-code", "text-anchor": "middle", "font-size": 10 });
        } else if (entity.kind === "intersection") {
          marker.setAttribute("class", "intersection-marker");
          marker.append(node("rect", { x: x - 4, y: y - 4, width: 8, height: 8, fill: "#2586cc", stroke: "#fff", "stroke-width": 1.3 }));
          label(marker, x + 9, y - 7, entity.id, { class: "scene-label poi-code", "font-size": 9 });
        }
        parent.append(marker);
      });
    }
    // 绘制旧沙盘坐标刻度与轴标识。
    drawAxes(parent) {
      for (let x = 0; x <= this.data.map.width; x += 5) {
        label(parent, this.px(x), 1025, String(x), { "text-anchor": "middle", "font-size": 11, fill: "#365247" });
        parent.append(node("path", { d: "M " + this.px(x) + " 1004 v 6", stroke: "#416756", "stroke-width": 1.5 }));
      }
      for (let y = 0; y <= this.data.map.height; y += 5) {
        label(parent, -13, this.py(y) + 4, String(y), { "text-anchor": "end", "font-size": 11, fill: "#365247" });
      }
      label(parent, 1170, 1027, "m", { "font-size": 11, fill: "#365247" });
      const north = node("g", { transform: "translate(1160 50)", "pointer-events": "none" });
      north.append(node("path", { d: "M 0 34 V 2 M -8 14 L 0 0 L 8 14", fill: "#243f33", stroke: "#243f33", "stroke-width": 2 }));
      label(north, 0, -8, "N", { "text-anchor": "middle", "font-size": 15 });
      parent.append(north);
      parent.append(node("path", { d: "M 330 47 H 530 M 330 42 V 52 M 530 42 V 52", stroke: "#3d584c", "stroke-width": 3 }));
      label(parent, 330, 34, "0", { "font-size": 10 });
      label(parent, 530, 34, "5 m", { "text-anchor": "end", "font-size": 10 });
    }
    // 重建旧 SVG 场景图层及实体图形，区别于当前原图叠加式 React 地图。
    renderScene() {
      this.svg.replaceChildren();
      const defs = node("defs");
      const clip = node("clipPath", { id: "scene-clip" });
      clip.append(node("rect", { x: 0, y: 0, width: 1200, height: 1000 }));
      defs.append(clip);
      [["solid-shadow", 2.5], ["flame-soft", 1.1], ["smoke-soft", 4]].forEach(([id, blur]) => {
        const filter = node("filter", { id, x: "-60%", y: "-60%", width: "220%", height: "240%" });
        filter.append(node("feGaussianBlur", { stdDeviation: blur })); defs.append(filter);
      });
      [["tank-metal", ["#dce5e7", "#9cafb5", "#6e8993"]], ["tank-roof", ["#ffffff", "#eef3f3", "#cedbdd"]]].forEach(([id, colors]) => {
        const gradient = node("linearGradient", { id, x1: "0%", y1: "0%", x2: "100%", y2: "35%" });
        colors.forEach((color, i) => gradient.append(node("stop", { offset: (i*50)+"%", "stop-color": color })));
        defs.append(gradient);
      });
      this.data.entities.filter((e) => ["A21", "A22", "A23", "A24"].includes(e.id)).forEach((area) => {
        const areaClip = node("clipPath", { id: "fire-clip-" + area.id });
        areaClip.append(this.rect(area)); defs.append(areaClip);
      });
      this.data.entities.filter((e) => e.kind === "area" && e.id !== "A00").forEach((area) => {
        const areaClip = node("clipPath", { id: "facility-clip-" + area.id });
        areaClip.append(this.rect(area)); defs.append(areaClip);
      });
      this.svg.append(defs);
      const ground = node("g", { "clip-path": "url(#scene-clip)", id: "scene-ground" });
      const roads = node("g", { id: "scene-roads" });
      const areas = node("g", { id: "scene-areas" });
      const campus = node("g", { id: "scene-campus-roads" });
      const features = node("g", { id: "scene-features" });
      const labels = node("g", { id: "scene-labels" });
      ground.append(this.drawArea(this.data.entities.find((e) => e.id === "A00")));
      const roadEntities = this.data.entities.filter((e) => e.kind === "road");
      roadEntities.filter((e) => ["boulevard", "connector"].includes(e.geometry.style)).forEach((e) => roads.append(this.drawRoad(e)));
      this.data.entities.filter((e) => e.kind === "area" && e.id !== "A00").forEach((e) => areas.append(this.drawArea(e)));
      roadEntities.filter((e) => !["boulevard", "connector"].includes(e.geometry.style)).forEach((e) => campus.append(this.drawRoad(e)));
      this.data.entities.filter((e) => e.kind === "intersection").forEach((e) => features.append(this.drawIntersection(e)));
      this.data.entities.filter((e) => e.kind === "pipeline").forEach((e) => features.append(this.drawPipeline(e)));
      this.data.entities.filter((e) => ["building", "tank", "tank_group"].includes(e.kind)).forEach((e) => features.append(this.drawFacility(e)));
      this.svg.append(ground, roads, areas, campus, features, labels);
      this.drawLabels(labels);
      const axes = node("g", { id: "scene-axes", "pointer-events": "none" });
      this.drawAxes(axes); this.svg.append(axes);
      this.highlights = node("g", { id: "scene-highlights", "pointer-events": "none" });
      this.fireLayer = node("g", { id: "scene-fire" });
      this.svg.append(this.highlights, this.fireLayer);
      this.setLayers(this.showLabels, this.showBoundaries);
    }
    // 按实体几何生成高亮轮廓，供选取及真实火源关联标记使用。
    outline(entity, color, className) {
      const group = node("g", { class: className, "data-highlight-id": entity.id });
      const inset = 0.08;
      if (entity.geometry.shape === "circle") {
        group.append(node("circle", { cx: this.px(entity.x + entity.width / 2), cy: this.py(entity.y + entity.height / 2), r: this.px(entity.width / 2 + inset), fill: "none", stroke: color, "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
      } else {
        group.append(this.rect({ x: entity.x - inset, y: entity.y - inset, width: entity.width + inset * 2, height: entity.height + inset * 2 }, { fill: "none", stroke: color, "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
      }
      return group;
    }
    // 刷新选中实体/火源的轮廓高亮。
    renderHighlights() {
      if (!this.highlights) return;
      this.highlights.replaceChildren();
      const selected = this.data.entities.find((e) => e.id === this.selectedId);
      const fire = this.data.fires.find((item) => item.id === this.selectedFireId);
      const nearest = this.data.entities.find((e) => e.id === fire?.nearest_building_id);
      const poi = this.data.entities.find((e) => e.id === fire?.nearest_poi_id);
      if (selected && !["building", "tank", "tank_group"].includes(selected.kind)) this.highlights.append(this.outline(selected, "#497795", "selected-entity"));
      this.svg.querySelectorAll(".fire-poi, .nearest-building").forEach((element) => element.classList.remove("fire-poi", "nearest-building"));
      if (poi) this.svg.querySelector('#scene-features [data-id="' + poi.id + '"]')?.classList.add("fire-poi");
      if (nearest) this.svg.querySelector('#scene-features [data-id="' + nearest.id + '"]')?.classList.add("nearest-building");
    }
    // 按真实火源位置与强度绘制旧版火焰标记，不显示后台预测排名。
    renderFire() {
      if (!this.fireLayer) return;
      this.fireLayer.replaceChildren();
      this.data.fires.forEach((fire) => {
        const x = this.px(fire.position.x), y = this.py(fire.position.y);
        const group = node("g", { "data-fire-id": fire.id, "data-area-id": fire.area_id, tabindex: 0, role: "button", "aria-label": "火源 · " + fire.area_id, "clip-path": "url(#fire-clip-" + fire.area_id + ")" });
        group.append(node("title", {}, "火源 · 强度 " + fire.intensity));
        const cluster = node("g", { transform: `translate(${x} ${y}) scale(${0.8+fire.intensity*.07})` });
        cluster.append(node("circle", { r: 24, fill: "transparent", "pointer-events": "all" }));
        [[-10,-11,11], [5,-22,13], [13,-6,9]].forEach(([dx,dy,r]) => cluster.append(node("ellipse", { cx: dx, cy: dy, rx: r, ry: r*.8, fill: "#53605c", opacity: 0.24, filter: "url(#smoke-soft)", "pointer-events": "none" })));
        [[-14,7,.68], [-5,-2,1], [10,6,.85], [2,12,.62]].forEach(([dx,dy,size], i) => {
          const flame = node("g", { class: "flame-cluster", transform: `translate(${dx} ${dy}) scale(${size})`, style: `animation-delay: ${-i*.37}s`, filter: "url(#flame-soft)" });
          flame.append(node("path", { d: "M 0 -22 C 4 -11 14 -7 12 4 C 11 17 -11 19 -12 5 C -13 -5 -3 -9 0 -22 Z", fill: "#e35432", opacity: .84 }));
          flame.append(node("path", { d: "M 1 -13 C 2 -5 8 0 6 7 C 3 14 -5 13 -6 6 C -7 -1 -1 -5 1 -13 Z", fill: "#ffc459", opacity: .94 }));
          cluster.append(flame);
        });
        group.append(cluster); this.fireLayer.append(group);
      });
    }
    // 把旧实体类型映射为详情面板可读名称。
    typeName(entity) { return TYPE_NAMES[entity.entity_type] || entity.kind; }
  }
  window.SceneMap = SceneMap;
})();
