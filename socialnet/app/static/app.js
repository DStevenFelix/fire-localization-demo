// 页面控制层：HTTP 控制和历史查询、WebSocket 状态同步、群聊与报告渲染；地图由 window.SceneMap 提供。

// data 保存服务端快照；history* 是当前激活的浏览历史缓存，不能作为后端恢复依据。
const state = { data: null, socket: null, busy: false, popupAnchor: null,
  activeCommunity: null, members: false, seenTotals: {}, roomScroll: {}, chatSignature: "", memberSignature: "",
  historyMessages: {}, historyReports: {}, messageBefore: {}, reportBefore: null, historyLoading: {},
  archivePage: 1, archiveData: null, archiveBusy: false, archiveRequest: 0, deleteTarget: null };
const discoveryLabels = {fire:"火灾",gas:"燃气",traffic:"交通",flood:"积水",facility:"建筑及公共设施",security:"治安",rescue:"人员求助"};
const discoveryFlags = {uncertain:"不确定",hearsay:"转述／待核实",contextual_reply:"回复上下文"};
state.discoveryView = {category:"",community:"",mode:"live",items:[],nextBefore:null,hasMore:true,loading:false,request:0,error:""};
function resetDiscoveryView() {
  const request = state.discoveryView.request + 1;
  Object.assign(state.discoveryView,{category:"",community:"",mode:"live",items:[],nextBefore:null,hasMore:true,loading:false,request,error:""});
}
const el = (id) => document.getElementById(id);
const map = el("community-map");
const icons = () => window.lucide?.createIcons();
const scene = new SceneMap(map, showEntity);
window.sceneMap = scene;

// 把动态内容转义后写入 HTML 模板；聊天、引文、实体名称不能直接拼成标签。
function escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}
// 仿真从 08:00 开始，用分钟偏移显示时刻；不表示模型请求完成的真实时间。
function clock(minutes) {
  const total = 8 * 60 + minutes;
  return String(Math.floor(total / 60) % 24).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}
// 把真实事件时间戳格式化为页面显示时间。
function eventTime(value) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
// 将地图 SVG 锚点转换为面板坐标，并限制实体浮层在可见范围内。
function positionPopup() {
  const popup = el("entity-inspector");
  if (popup.hidden || !state.popupAnchor) return;
  const shell = el("map-shell").getBoundingClientRect();
  const svg = map.querySelector("svg");
  if (!svg?.getScreenCTM()) return;
  const point = svg.createSVGPoint();
  point.x = state.popupAnchor.x; point.y = state.popupAnchor.y;
  const screen = point.matrixTransform(svg.getScreenCTM());
  const x = screen.x - shell.left, y = screen.y - shell.top;
  const width = popup.offsetWidth, height = popup.offsetHeight;
  const left = x + 12 + width < shell.width - 8 ? x + 12 : x - width - 12;
  const top = y + 12 + height < shell.height - 8 ? y + 12 : y - height - 12;
  popup.style.left = Math.max(8, Math.min(shell.width - width - 8, left)) + "px";
  popup.style.top = Math.max(8, Math.min(shell.height - height - 8, top)) + "px";
}
// 显示地图实体或真实火源的详情；住宅来源位置和定位候选含义不同。
function showEntity(entity, anchor) {
  const inspector = el("entity-inspector");
  if (!entity) {
    inspector.hidden = true;
    return;
  }
  inspector.hidden = false;
  inspector.dataset.kind = entity.kind;
  state.popupAnchor = anchor;
  el("entity-name").textContent = entity.name;
  el("entity-id").textContent = entity.id;
  el("entity-type").textContent = scene.typeName(entity);
  const iconNames = { building: "building-2", tank: "cylinder", tank_group: "cylinder", area: "map", road: "route", intersection: "signpost", pipeline: "waypoints", fire: "flame" };
  el("entity-icon").innerHTML = '<i data-lucide="' + (iconNames[entity.kind] || "map-pin") + '"></i>';
  const position = entity.position || { x: entity.x + entity.width / 2, y: entity.y + entity.height / 2 };
  const area = state.data.entities.find((item) => item.id === entity.area_id || item.id === entity.parent_id);
  const row = (name, value, id = "") => '<div class="entity-field"><dt>' + escapeHTML(name) + '</dt><dd' + (id ? ' id="' + id + '"' : '') + '>' + escapeHTML(value) + '</dd></div>';
  const rows = [row("所属区域", area ? area.name : state.data.map.name, "entity-area"),
    row("定位坐标", "(" + position.x.toFixed(3) + ", " + position.y.toFixed(3) + ") m", "entity-coordinate")];
  if (entity.kind === "area") {
    rows.push(row("东西范围", entity.x.toFixed(2) + " - " + (entity.x + entity.width).toFixed(2) + " m"),
      row("南北范围", entity.y.toFixed(2) + " - " + (entity.y + entity.height).toFixed(2) + " m"));
  } else if (entity.kind === "tank") rows.push(row("罐体直径", entity.width.toFixed(2) + " m"));
  else if (entity.kind === "tank_group") rows.push(row("罐组规模", entity.geometry.components.length + " 座工艺罐"));
  else if (entity.kind === "fire") {
    rows.push(row("当前强度", entity.intensity + " / 5"), row("出现时刻", clock(entity.started_minute)));
  } else if (entity.kind === "road" && entity.path.length) {
    const start = entity.path[0], end = entity.path[entity.path.length - 1];
    rows.push(row("起点坐标", "(" + start.x.toFixed(2) + ", " + start.y.toFixed(2) + ") m"),
      row("终点坐标", "(" + end.x.toFixed(2) + ", " + end.y.toFixed(2) + ") m"));
  } else rows.push(row("平面尺寸", entity.width.toFixed(2) + " × " + entity.height.toFixed(2) + " m"));
  el("entity-fields").innerHTML = rows.join("");
  el("entity-source").textContent = entity.kind === "fire" ? "真实火情 · 仿真状态" : "规范空间模型 · 登记中心";
  el("entity-aliases").textContent = entity.aliases.length ? "别名 · " + entity.aliases.join("、") : "";
  const residents = state.data.residents.filter((resident) => resident.building_id === entity.id);
  el("entity-residents").innerHTML = residents.map((resident) => "<span>" + escapeHTML(resident.name) + " <small>" + escapeHTML(resident.unit) + "</small></span>").join("");
  el("entity-resident-count").textContent = residents.length + " 人";
  el("entity-resident-section").hidden = residents.length === 0;
  el("clear-selected-fire").hidden = entity.kind !== "fire";
  el("clear-selected-fire").disabled = state.busy;
  el("entity-fire-details").hidden = entity.kind !== "fire";
  if (entity.kind === "fire") {
    const building = state.data.entities.find((item) => item.id === entity.nearest_building_id);
    const poi = state.data.entities.find((item) => item.id === entity.nearest_poi_id);
    el("entity-fire-details").innerHTML = row("附近设施", poi?.name || "—") + row("最近居民楼", building?.name || "—");
  }
  icons();
  positionPopup();
}
// 切换展示的社区并保存阅读进度；不控制后端哪些社区生成消息。
function openCommunity(id) {
  if (id && !state.data?.communities.some(c => c.id === id)) return;
  if (state.activeCommunity && !state.members) state.roomScroll[state.activeCommunity] = el("chat-list").scrollTop;
  state.activeCommunity = id;
  state.members = false;
  state.chatSignature = "";
  renderChats();
  icons();
}
// 按居民 ID 确定头像配色，使刷新与重新渲染时保持一致。
function avatarColor(id) {
  const index = state.data.residents.findIndex(r => r.id === id);
  return ["#28534f", "#5a7084", "#8a6273", "#697b46", "#98634f"][Math.max(index, 0) % 5];
}
// 合并已缓存历史和实时原帖，按社区渲染成员/消息、未读计数及阅读位置。
function renderChats() {
  const { communities, chats, residents, chat_totals: totals } = state.data;
  const community = communities.find(c => c.id === state.activeCommunity);
  const overview = !community;
  el("community-back").hidden = overview;
  el("community-members-button").hidden = overview;
  el("community-members-button").setAttribute("aria-pressed", String(state.members));
  el("community-navigation").hidden = overview;
  el("community-list").hidden = !overview;
  el("chat-list").hidden = overview || state.members;
  el("community-members").hidden = overview || !state.members;
  el("chat-title").textContent = community?.name || "社区居民群聊";
  el("chat-subtitle").textContent = community ? community.resident_ids.length + " 人在线" : communities.length + " 个社区 · " + residents.length + " 人在线";
  if (overview) {
    el("community-list").innerHTML = communities.map(c => {
      const messages = chats.filter(m => m.community_id === c.id);
      const last = messages.at(-1);
      const unread = Math.max(0, totals[c.id] - (state.seenTotals[c.id] || 0));
      return '<button class="community-row" type="button" data-community="' + escapeHTML(c.id) + '"><span class="community-avatar ' + (c.id === "A30" ? "east" : "") + '"><i data-lucide="' + (c.id === "A30" ? "building-2" : "houses") + '"></i></span><span class="community-preview"><strong>' + escapeHTML(c.name) + '</strong><small>' + c.resident_ids.length + ' 人 · ' + c.building_ids.length + ' 栋居民楼</small><span>' + (last ? escapeHTML(last.resident_name + "：" + last.content) : "暂无消息") + '</span></span><span class="community-status"><time>' + (last ? clock(last.simulation_minute) : "") + '</time>' + (unread ? '<span class="unread-count">' + (unread > 99 ? "99+" : unread) + '</span>' : '<i data-lucide="chevron-right"></i>') + '</span></button>';
    }).join("");
    el("chat-note").textContent = communities.map(c => c.name + " " + c.resident_ids.length + " 人").join(" · ");
    return;
  }
  el("community-switch").innerHTML = communities.map(c => '<option value="' + escapeHTML(c.id) + '"' + (c.id === community.id ? " selected" : "") + '>' + escapeHTML(c.name) + '</option>').join("");
  const messages = Object.values(state.historyMessages[community.id] || {}).sort((a,b) => a.sequence-b.sequence);
  el("message-count").textContent = totals[community.id] + " 条";
  el("chat-note").textContent = messages.length ? "模型生成 · " + community.building_ids.length + " 栋居民楼" : community.building_ids.length + " 栋居民楼 · " + community.resident_ids.length + " 位邻居";
  if (state.members) {
    const members = residents.filter(r => r.community_id === community.id);
    const signature = JSON.stringify(members);
    if (signature === state.memberSignature) return;
    state.memberSignature = signature;
    const labels = { food: "烹饪", reading: "阅读", school: "亲子", plants: "园艺", repair: "维修", traffic: "出行", pets: "宠物", neighbors: "邻里互助", health: "健康", sleep: "休息", budget: "生活开支", parcel: "快递", music: "音乐", exercise: "运动", weather: "天气" };
    el("community-members").innerHTML = members.map(r => '<details class="resident-profile"><summary><span class="member-avatar" style="background:' + avatarColor(r.id) + '">' + escapeHTML(r.name.slice(-1)) + '</span><span><strong>' + escapeHTML(r.name) + '</strong><small>' + escapeHTML(r.occupation) + ' · ' + r.age + ' 岁</small></span><i data-lucide="chevron-down"></i></summary><dl><dt>家庭</dt><dd>' + escapeHTML(r.household) + '</dd><dt>兴趣</dt><dd>' + r.interests.map(k => escapeHTML(labels[k] || k)).join("、") + '</dd><dt>作息</dt><dd>' + escapeHTML(r.daily_routine) + '</dd><dt>表达</dt><dd>' + escapeHTML(r.speaking_style) + '</dd></dl></details>').join("");
    return;
  }
  state.seenTotals[community.id] = totals[community.id];
  const list = el("chat-list");
  const hasEarlier = messages.length < totals[community.id];
  const loading = Boolean(state.historyLoading[community.id]);
  const signature = community.id + ":" + messages.map(m => m.id).join(",") + ":" + hasEarlier + ":" + loading;
  if (signature === state.chatSignature) return;
  const changedRoom = !state.chatSignature.startsWith(community.id + ":");
  const existing = new Set([...list.querySelectorAll(".chat-message")].map(e => e.id));
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const oldScroll = list.scrollTop;
  state.chatSignature = signature;
  if (!messages.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon"><i data-lucide="messages-square"></i></div><h3>暂无群聊消息</h3></div>';
    return;
  }
  const earlierButton = hasEarlier ? '<button class="history-load" type="button" data-load-messages' + (loading ? ' disabled' : '') + '>' + (loading ? '加载中…' : '加载更早消息') + '</button>' : '';
  list.innerHTML = earlierButton + messages.map(m => {
    const reference = m.reply_to_id || m.corroborates_message_id;
    const target = messages.find(item => item.id === reference);
    const quote = reference ? '<button class="reply-quote" type="button" data-reply="' + escapeHTML(reference) + '"><i data-lucide="corner-down-right"></i><span>' + escapeHTML((target?.resident_name || m.reply_to_name || "邻居") + "：" + (target?.content || m.reply_quote || "较早的观察消息")) + '</span></button>' : "";
    const arrival = !changedRoom && !existing.has("chat-" + m.id) ? " new-message" : "";
    return '<article id="chat-' + escapeHTML(m.id) + '" data-community-id="' + escapeHTML(m.community_id) + '" class="chat-message ' + (m.topic === "fire" ? "fire" : "") + arrival + '"><div class="avatar" style="background:' + avatarColor(m.resident_id) + '">' + escapeHTML(m.resident_name.slice(-1)) + '</div><div class="chat-meta"><strong>' + escapeHTML(m.resident_name) + '</strong><span>' + clock(m.simulation_minute) + '</span><button class="building-tag" data-building="' + escapeHTML(m.building_id) + '">' + escapeHTML(m.building_name) + '</button></div>' + quote + '<p>' + escapeHTML(m.content) + '</p></article>';
  }).join("");
  list.scrollTop = changedRoom ? (state.roomScroll[community.id] ?? list.scrollHeight) : nearBottom ? list.scrollHeight : oldScroll;
}
// 合并实时与历史报告，显示研判、逐字证据及原帖/住址详情入口。
function renderReports() {
  const reports = Object.values(state.historyReports).sort((a,b) => b.sequence-a.sequence);
  const list = el("report-list"), oldScroll = list.scrollTop;
  const total = Math.max(state.data.report_total || 0, reports.length);
  el("report-count").textContent = total + " 份";
  if (!reports.length) {
    el("monitor-headline").textContent = "正在监听居民群聊";
    el("monitor-subtitle").textContent = "尚无需要报告的异常事件";
    el("report-list").innerHTML = '<div class="empty-report"><i data-lucide="shield-check"></i><p>暂无风险报告</p></div>';
    return;
  }
  el("monitor-headline").textContent = reports[0].severity + "：" + reports[0].title;
  el("monitor-subtitle").textContent = reports[0].summary;
  el("report-list").innerHTML = reports.map((report) => '<article id="' + escapeHTML(report.id) + '" class="report-card"><div class="report-top"><span class="severity">' + escapeHTML(report.severity) + " · " + escapeHTML(report.status) + '</span><span class="report-time">' + eventTime(report.timestamp) + '</span></div><h3>' + escapeHTML(report.title) + '</h3><p>' + escapeHTML(report.summary) + '</p><dl class="report-judgment"><dt>判断依据</dt><dd>' + escapeHTML(report.reasoning) + '</dd><dt>文本位置线索</dt><dd>' + escapeHTML(report.location_hint || "位置尚不明确") + '</dd></dl>' + (report.uncertainties?.length ? '<ul class="report-uncertainties">' + report.uncertainties.map(item => '<li>' + escapeHTML(item) + '</li>').join('') + '</ul>' : '') + '<div class="report-location-label">报告者住址</div><div class="report-locations">' + report.residents.map((resident) => '<button data-building="' + escapeHTML(resident.building ? report.buildings.find((building) => building.name === resident.building)?.id || "" : "") + '">' + escapeHTML(resident.name + " · " + resident.building + " " + resident.unit) + '</button>').join("") + '</div><ul class="evidence">' + report.evidence.map((item) => "<li>" + escapeHTML(item) + "</li>").join("") + '</ul><div class="keywords">证据短语：' + report.keywords.map(escapeHTML).join(" / ") + "</div></article>").join("");
  if (reports.length < total) {
    list.insertAdjacentHTML("beforeend", '<button class="history-load" type="button" data-load-reports' + (state.historyLoading.reports ? ' disabled' : '') + '>' + (state.historyLoading.reports ? '加载中…' : '加载更多报告') + '</button>');
  }
  list.scrollTop = oldScroll;
}
// 展示最后预测、任务与证据簇，失败时保留已有结果；一致性与相对分数都不是火灾概率。
function renderLocalization() {
  const loc = state.data?.localization;
  if (!loc) return;
  const labels = { idle: "等待疑似火灾报告", queued: "定位排队中", running: "正在分析原帖", completed: "定位已更新", failed: "定位失败 · 群聊与监测继续" };
  el("localization-status").textContent = loc.resume_pending ? "已恢复 · 等待继续定位" : labels[loc.status] || loc.status;
  el("localization-error").hidden = !loc.error;
  const failedJob = loc.jobs.find(job => job.status === "failed");
  el("localization-error").innerHTML = loc.error ? '<span>' + escapeHTML(loc.error) + '</span>' +
    (failedJob ? '<button type="button" class="ghost-button" data-retry="' + escapeHTML(failedJob.id) + '" title="重试失败的定位任务" aria-label="重试失败的定位任务"><i data-lucide="rotate-ccw"></i></button>' : '') : '';
  const prediction = loc.prediction;
  el("localization-candidate-heading").textContent = loc.status === "failed" && prediction ? "全局 Top3 · 上次成功结果" : "全局 Top3";
  el("localization-post-count").textContent = prediction?.processed_count || 0;
  el("localization-cluster-count").textContent = prediction?.active_cluster_count || 0;
  el("localization-job-count").textContent = loc.jobs.length;
  const candidates = prediction?.candidates || [];
  el("localization-candidates").innerHTML = candidates.length ? candidates.map(c =>
    '<button type="button" class="candidate-row" data-candidate="' + escapeHTML(c.poi_id) + '"><span class="candidate-rank">' + c.rank + '</span><span class="candidate-copy"><strong>' + escapeHTML(c.name) + '</strong><small>' + escapeHTML(c.poi_id) + ' · ' + c.votes + ' 票</small></span><span class="candidate-value">' + c.score.toFixed(2) + '<small>得分</small></span><i data-lucide="crosshair"></i></button>'
  ).join("") : '<p class="localization-empty">' + (loc.status === "running" ? "正在推断候选位置…" : "暂无活跃定位候选") + '</p>';
  const jobLabels = {queued:"排队",running:"运行中",completed:"完成",failed:"失败"};
  el("localization-cluster-list").innerHTML = loc.clusters.map(cluster => {
    const leading = state.data.entities.find(e => e.id === cluster.leading_poi_id);
    const expired = cluster.cold || (prediction && Date.parse(prediction.current_time)-Date.parse(cluster.last_timestamp)>=(loc.cold_minutes ?? 30)*60*1000);
    return '<article class="localization-job"><div><strong>' + escapeHTML(cluster.id) + ' · ' + cluster.count + ' 条证据</strong><span>' + (expired ? "已过时" : "活跃") + '</span></div><small>' + escapeHTML(leading?.name || cluster.leading_poi_id) + ' · 文本一致性 ' + cluster.confidence.toFixed(3) + '</small></article>';
  }).join("");
  el("localization-job-list").innerHTML = [...loc.jobs].reverse().map(job =>
    '<article class="localization-job" data-job="' + escapeHTML(job.id) + '"><div><strong>' + clock(job.simulation_minute) + ' · ' + job.message_ids.length + ' 条原帖</strong><span>' + jobLabels[job.status] + '</span>' +
    (job.status === "failed" ? '<button type="button" class="ghost-button" data-retry="' + escapeHTML(job.id) + '" title="重试定位" aria-label="重试定位"><i data-lucide="rotate-ccw"></i></button>' : '') +
    '</div><small>' + (job.elapsed_ms == null ? "等待处理" : (job.elapsed_ms / 1000).toFixed(2) + ' 秒 · 请求任务 ' + job.attempts + ' 次') + (job.replayed ? ' · 已按原帖时间重建' : '') + '</small><div class="localization-report-links">' + job.report_ids.map(id => '<button type="button" data-report="' + escapeHTML(id) + '" title="查看关联监测报告"><i data-lucide="file-text"></i>' + escapeHTML(id) + '</button>').join('') + '</div></article>'
  ).join("");
}
// 本地候选按帖子展示；分页只保留一页，避免随整轮消息无限累计浏览器缓存。
function discoveryRows() {
  const view = state.discoveryView;
  if (view.mode === "history") return view.items;
  return (state.data?.discovery?.recent_candidates || []).filter(row=>
    (!view.category || row.categories.includes(view.category)) && (!view.community || row.community_id===view.community));
}
function renderDiscovery() {
  const data = state.data?.discovery, view = state.discoveryView;
  el("discovery-scanned").textContent = data?.scanned_total || 0;
  el("discovery-total").textContent = data?.candidate_total || 0;
  el("discovery-forwarded").textContent = data?.forwarded_total || 0;
  el("discovery-skipped").textContent = data?.skipped_monitor_steps || 0;
  el("discovery-category").value = view.category;
  el("discovery-community").innerHTML = '<option value="">全部社区</option>' + (state.data?.communities || []).map(c=>
    '<option value="'+escapeHTML(c.id)+'"'+(view.community===c.id?' selected':'')+'>'+escapeHTML(c.name)+'</option>').join("");
  for (const id of ["discovery-category","discovery-community"]) el(id).disabled = !data;
  el("discovery-start").textContent = data ? "自仿真 "+clock(data.started_minute)+" 后的新消息启用 · "+data.rule_version : "后端尚未启用事件发现，请重启更新后的服务。";
  el("discovery-window-stats").innerHTML = (data?.window_stats || []).map(row=>'<div><strong>'+discoveryLabels[row.category]+'</strong><span>'+row.candidate_count+' 帖 · '+row.author_count+' 位作者 · '+row.community_count+' 社区 · 重复 '+row.duplicate_count+'</span></div>').join("");
  const rows = [...discoveryRows()].sort((a,b)=>b.sequence-a.sequence);
  el("discovery-scope").textContent = (view.mode==='history'?"历史分页":"最近50条候选")+' · '+(view.community ? state.data.communities.find(c=>c.id===view.community)?.name || view.community : '全部社区');
  // 无关定位推送或群聊切换不重建相同候选，保留展开的依据及阅读滚动位置。
  const signature=JSON.stringify([rows,view.mode,view.loading,Boolean(data)]);
  if (signature!==state.discoverySignature) {
  state.discoverySignature=signature;
  el("discovery-list").innerHTML = rows.map(row=>'<article class="discovery-card" data-discovery-message="'+escapeHTML(row.message_id)+'">'+
    '<div class="discovery-card-top"><div>'+row.categories.map(category=>'<span class="discovery-category">'+discoveryLabels[category]+'</span>').join('')+'</div><time>'+clock(row.simulation_minute)+'</time></div>'+
    '<p class="discovery-content">'+escapeHTML(row.content)+'</p><div class="discovery-origin">'+escapeHTML(row.community_name)+' · '+escapeHTML(row.resident_name)+'</div>'+
    (row.flags.length?'<div class="discovery-flags">'+row.flags.map(flag=>'<span>'+escapeHTML(discoveryFlags[flag] || flag)+'</span>').join('')+'</div>':'')+
    '<details class="discovery-reasons"><summary>筛选依据</summary>'+row.reasons.map(reason=>'<p><strong>'+escapeHTML(reason.rule)+'</strong>：'+escapeHTML(reason.excerpt)+(reason.source_message_id!==row.message_id?'（引用父消息）':'')+'</p>').join('')+'</details>'+
    '<button type="button" data-discovery-source="'+escapeHTML(row.message_id)+'" data-discovery-community="'+escapeHTML(row.community_id)+'">查看原帖</button></article>').join('') ||
    '<p class="discovery-empty">'+(!data?'等待后端启用本地筛选。':view.loading?'正在读取候选历史…':view.mode==='history'?'没有符合筛选条件的历史候选。':'近期候选中暂无匹配。普通聊天不会因此显示为已确认事件，可查询更早记录。')+'</p>';
  }
  el("discovery-latest").hidden = view.mode==='live';
  el("discovery-latest").disabled = false;
  el("discovery-older").disabled = !data || view.loading || (view.mode==='history' ? !view.hasMore : data.candidate_total===0);
  el("discovery-older").textContent = view.loading?'读取中…':'更早记录';
  el("discovery-error").hidden = !view.error; el("discovery-error").textContent = view.error;
}
async function loadDiscoveryHistory() {
  const view = state.discoveryView;
  if (view.loading || !state.data?.discovery) return;
  const runId = state.data.persistence.run_id, activation = state.data.persistence.activation_id;
  const request = ++view.request;
  const rows = discoveryRows();
  const before = view.mode==='history' ? view.nextBefore : rows.length ? Math.min(...rows.map(r=>r.sequence)) : null;
  const params = new URLSearchParams({run_id:runId,limit:'50'});
  if (view.category) params.set('category',view.category);
  if (view.community) params.set('community_id',view.community);
  if (before) params.set('before',String(before));
  view.loading=true;view.error='';el('discovery-list').scrollTop=0;renderDiscovery();
  const current=()=>request===view.request && runId===state.data?.persistence?.run_id && activation===state.data?.persistence?.activation_id;
  try {
    const response=await fetch('/api/discovery?'+params),data=await response.json();
    if(!current()) return;
    if(!response.ok) throw new Error(data.detail || '候选历史读取失败');
    if(data.run_id!==runId) return;
    view.mode='history';view.items=data.items;view.nextBefore=data.next_before;view.hasMore=data.has_more;
    el('discovery-list').scrollTop=0;
  } catch(error) {if(current())view.error=error.message;}
  finally {if(current()){view.loading=false;renderDiscovery();}}
}

// 按已接受的快照同步状态栏、地图、群聊、监测与定位，不在浏览器推进仿真。
function render() {
  if (!state.data) return;
  const saved = state.data.persistence;
  el("persistence-status").textContent = saved?.enabled ?
    (saved.error ? "保存失败 · 已暂停" : saved.restored && !state.data.running ? "已恢复，等待继续" : "已保存") +
    (saved.saved_at ? " · " + new Date(saved.saved_at).toLocaleTimeString("zh-CN", {hour12:false}) : "") : "";
  el("persistence-error").hidden = !saved?.error;
  el("persistence-error").textContent = saved?.error || "";
  el("sim-time").textContent = clock(state.data.simulation_minute);
  el("agent-count").textContent = state.data.residents.length;
  el("system-status").innerHTML = '<i class="status-dot ' + (state.data.running ? "running" : "") + '"></i>' + (state.data.running ? "运行中" : "已暂停");
  el("start-button").innerHTML = '<i data-lucide="' + (state.data.running ? "pause" : "play") + '"></i>' + (state.data.running ? "暂停仿真" : "开始仿真");
  const issue = state.data.generation_error;
  el("generation-error").hidden = !issue;
  el("generation-error-message").textContent = issue ? issue.message + (issue.reason ? " 原因：" + issue.reason : "") : "";
  el("generation-error-context").textContent = issue ? [issue.agent_role === "monitor" ? "监测 Agent" : issue.resident_name, issue.code, issue.attempts ? "本次请求 " + issue.attempts + " 次" : ""].filter(Boolean).join(" · ") : "";
  const fires = state.data.fires;
  el("clear-fire").disabled = !fires.length || state.busy;
  el("next-fire-probability").textContent = (state.data.next_fire_probability * 100).toFixed(1) + "%";
  if (fires.length) {
    el("fire-status").textContent = fires.length + " 处火源 · 最高强度 " + Math.max(...fires.map((fire) => fire.intensity));
    el("fire-status").classList.add("alert");
    el("fire-location").textContent = [...new Set(fires.map((fire) => fire.area_id))].join(" / ");
  } else {
    el("fire-status").textContent = "当前无火情";
    el("fire-status").classList.remove("alert");
    el("fire-location").textContent = "—";
  }
  scene.setData(state.data);
  renderChats();
  renderReports();
  renderLocalization();
  renderDiscovery();
  simulationControls();
  icons();
}
// 携带当前激活令牌请求完整状态，忽略切档前发出的过期响应，再统一校验并渲染。
async function api(path, options = {}) {
  const requestedActivation = state.data?.persistence?.activation_id;
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(requestedActivation ? {"X-Simulation-Activation":requestedActivation} : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if(requestedActivation && requestedActivation!==state.data?.persistence?.activation_id)return;
    throw new Error(data.detail || "请求失败：" + response.status);
  }
  if (requestedActivation && requestedActivation !== state.data?.persistence?.activation_id &&
      data.persistence?.activation_id !== state.data?.persistence?.activation_id) return;
  if (acceptData(data)) render();
}
// 用激活序号阻止旧快照倒灌；切换激活时清空分页缓存，并保留同会话更新的定位 revision。
function acceptData(data) {
  if ((data.persistence?.activation_sequence || 0) < (state.data?.persistence?.activation_sequence || 0)) return false;
  const changed = state.data?.persistence?.activation_id !== data.persistence?.activation_id ||
    state.data?.persistence?.run_id !== data.persistence?.run_id;
  if (changed) {
    resetDiscoveryView();
    state.historyMessages = {}; state.historyReports = {}; state.messageBefore = {}; state.reportBefore = null;
    state.historyLoading = {}; state.chatSignature = ""; state.roomScroll = {}; state.seenTotals = {};
    el("history-detail").close();
    state.activeCommunity = null; state.members = false; state.memberSignature = "";
    if (state.data) scene.select(null);
    state.popupAnchor = null;
    ["chat-list", "report-list", "community-members", "history-detail-body"].forEach(id=>el(id).replaceChildren());
    el("history-detail-title").textContent = "";
    state.deleteTarget = null; el("archive-delete-dialog").close();
    state.archiveData = null; state.archiveRequest++;
  }
  if (state.data?.localization?.session_id === data.localization?.session_id &&
      state.data.localization.revision > data.localization.revision) data.localization = state.data.localization;
  if (state.data && data.simulation_minute < state.data.simulation_minute) {
    state.seenTotals = {}; state.roomScroll = {}; state.chatSignature = "";
  }
  state.data = data;
  for (const message of data.chats) {
    (state.historyMessages[message.community_id] ||= {})[message.id] = message;
    state.messageBefore[message.community_id] = Math.min(state.messageBefore[message.community_id] ?? Infinity, message.sequence);
  }
  for (const report of data.reports) {
    state.historyReports[report.id] = report;
    state.reportBefore = Math.min(state.reportBefore ?? Infinity, report.sequence);
  }
  if (changed && el("archive-dialog").open && !state.archiveBusy) refreshArchives(1);
  return true;
}

// 历史请求同时绑定 run_id 和 activation_id；即使切回同档也不接受旧激活的返回值。
async function historyRequest(path) {
  const runId = state.data.persistence.run_id;
  const activation = state.data.persistence.activation_id;
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(path + separator + "run_id=" + encodeURIComponent(runId));
  const data = await response.json();
  if (state.data.persistence.run_id !== runId || state.data.persistence.activation_id !== activation) return null;
  if (!response.ok) throw new Error(data.detail || "历史记录加载失败");
  return data.run_id === runId ? data : null;
}

// 按 before 序号加载更早记录，去重合并并保持群聊滚动锚点；分页不扩展模型记忆。
async function loadHistory(kind) {
  const community = state.activeCommunity, isMessages = kind === "messages";
  const key = isMessages ? community : "reports";
  if (!key || state.historyLoading[key]) return;
  const runId = state.data.persistence.run_id;
  const activation = state.data.persistence.activation_id;
  state.historyLoading[key] = true;
  renderChats(); renderReports();
  try {
    const before = isMessages ? state.messageBefore[community] : state.reportBefore;
    const path = isMessages ? "/api/communities/" + encodeURIComponent(community) + "/messages" : "/api/reports";
    const data = await historyRequest(path + (before ? "?before=" + before : ""));
    if (!data) return;
    const list = el(isMessages ? "chat-list" : "report-list");
    const height = list.scrollHeight, top = list.scrollTop;
    for (const item of data.items) {
      if (isMessages) (state.historyMessages[community] ||= {})[item.id] = item;
      else state.historyReports[item.id] = item;
    }
    if (isMessages) state.messageBefore[community] = data.next_before ?? before;
    else state.reportBefore = data.next_before ?? before;
    // 合并已缓存历史和实时原帖，按社区渲染成员/消息、未读计数及阅读位置。
    renderChats(); renderReports(); icons();
    if (isMessages && state.activeCommunity === community) list.scrollTop = top + list.scrollHeight - height;
  } catch (error) { el("map-error").textContent = error.message; el("map-error").hidden = false; }
  finally {
    if (runId === state.data.persistence.run_id && activation === state.data.persistence.activation_id) {
      state.historyLoading[key] = false; renderChats(); renderReports();
    }
  }
}

// 从完整数据库历史打开消息/报告详情，支持实时窗口之外的引用。
async function showHistoricalItem(kind, id) {
  try {
    const data = await historyRequest("/api/" + kind + "/" + encodeURIComponent(id));
    if (!data) return;
    const item = data.item;
    el("history-detail-title").textContent = kind === "reports" ? item.title : item.resident_name + " · " + clock(item.simulation_minute);
    const fields = kind === "reports" ? [["级别", item.severity + " · " + item.status], ["摘要",item.summary],
      ["判断依据",item.reasoning], ["文本位置线索",item.location_hint], ["待核实",item.uncertainties.join("；")],
      ["报告者",item.residents.map(r=>r.name+" · "+r.building+" "+r.unit).join("；")],
      ["引用证据",item.evidence.join("\n")], ["证据短语",item.keywords.join(" / ")]] :
      [["社区",state.data.communities.find(c=>c.id===item.community_id)?.name || item.community_id],
       ["住址",item.building_name], ["正文",item.content], ["引用",item.reply_quote]];
    el("history-detail-body").innerHTML = '<dl>' + fields.filter(([,v])=>v).map(([label,value])=>'<dt>'+escapeHTML(label)+'</dt><dd>'+escapeHTML(value)+'</dd>').join("") + '</dl>';
    el("history-detail").showModal();
  } catch (error) {el("map-error").hidden=false;el("map-error").textContent=error.message;}
}
// 串行化页面控制动作并管理忙碌/错误提示，实际业务状态由服务端返回。
async function action(path, options = {}) {
  if (state.busy || state.archiveBusy) return;
  state.busy = true;
  simulationControls();
  el("map-error").hidden = true;
  try { await api(path, options); }
  catch (error) { el("map-error").textContent = error.message; el("map-error").hidden = false; }
  finally {
    state.busy = false;
    // 同步普通操作与存档操作的按钮禁用状态，减少同页重复提交。
    simulationControls();
  }
}

// 同步普通操作与存档操作的按钮禁用状态，减少同页重复提交。
function simulationControls() {
  const busy = state.busy || state.archiveBusy;
  ["start-button", "step-button", "reset-button", "clear-selected-fire", "save-fire-settings"].forEach(id=>el(id).disabled=busy);
  el("clear-fire").disabled = busy || !state.data?.fires.length;
  el("archive-button").disabled = state.archiveBusy;
}

// 更新存档弹窗的操作反馈及错误样式。
function archiveFeedback(message, error=false) {
  el("archive-feedback").hidden = !message;
  el("archive-feedback").textContent = message;
  el("archive-feedback").classList.toggle("is-error",error);
}

// 按上海时区显示真实存档时间，与仿真分钟分开。
function archiveDate(value) {
  return new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
}

// 渲染分页摘要、兼容性和待清理状态；不兼容档不能载入但仍可删除。
function renderArchives() {
  const data=state.archiveData, busy=state.archiveBusy;
  el("archive-close").disabled=busy;
  el("archive-refresh").disabled=busy || state.archiveLoading;
  el("archive-prev").disabled=busy || state.archiveLoading || !data || data.page<=1;
  el("archive-next").disabled=busy || state.archiveLoading || !data || data.page*data.page_size>=data.total;
  if (!data) {el("archive-list").innerHTML='<p class="localization-empty">正在读取存档…</p>';return;}
  el("archive-page").textContent="第 "+data.page+" / "+Math.max(1,Math.ceil(data.total/data.page_size))+" 页 · "+data.total+" 份存档";
  el("archive-list").innerHTML=data.items.map(run=>'<article class="archive-item'+(run.active?' is-current':'')+'" data-run-id="'+escapeHTML(run.run_id)+'">'+
    '<div class="archive-item-top"><strong>仿真 '+clock(run.simulation_minute)+' · '+run.simulation_minute+' 分钟</strong>'+(run.active?'<span class="archive-current">当前使用</span>':'')+'</div>'+
    '<div class="archive-stats"><span>群聊<strong>'+run.message_count+' 条</strong></span><span>监测报告<strong>'+run.report_count+' 份</strong></span><span>火源<strong>'+run.fire_count+' 个</strong></span></div>'+
    '<div class="archive-item-bottom"><time>保存于 '+escapeHTML(archiveDate(run.saved_at))+'<br><code>'+escapeHTML(run.run_id.slice(0,8))+'</code></time><div class="archive-item-actions">'+
    '<button class="primary-button" type="button" data-run-load="'+escapeHTML(run.run_id)+'"'+(busy||run.active||!run.compatible?' disabled':'')+'>'+(run.active?'使用中':'载入')+'</button>'+
    '<button class="danger-button" type="button" data-run-delete="'+escapeHTML(run.run_id)+'"'+(busy?' disabled':'')+'>删除</button></div></div>'+
    (run.incompatible_reason || run.localization_warning?'<p class="archive-incompatible">'+escapeHTML(run.incompatible_reason || run.localization_warning)+'</p>':'')+'</article>').join("") || '<p class="localization-empty">暂无存档</p>';
  const cleanup=data.cleanup || [];
  el("archive-cleanup").hidden=!cleanup.length;
  el("archive-cleanup").textContent=cleanup.length ? cleanup.length+' 份已删除存档的缓存正在清理。'+cleanup.filter(j=>j.error).map(j=>j.error).join('；') : '';
}

// 用请求序号丢弃过期列表，并核对激活标识，防止操作基于另一轮次的列表。
async function refreshArchives(page=state.archivePage) {
  const request=++state.archiveRequest;
  state.archiveLoading=true;renderArchives();
  try {
    const response=await fetch('/api/runs?page='+page);
    const data=await response.json();
    if (request!==state.archiveRequest || !el("archive-dialog").open) return;
    if (!response.ok) throw new Error(data.detail || '存档列表读取失败');
    if (data.activation_id!==state.data?.persistence?.activation_id) {
      await api('/api/state');
      if (request!==state.archiveRequest) return;
    }
    if (data.activation_id!==state.data?.persistence?.activation_id) throw new Error('当前存档已变化，请刷新列表后重试');
    if (!data.items.length && page>1) {await refreshArchives(page-1);return;}
    state.archivePage=page;state.archiveData=data;
  } catch(error) {archiveFeedback(error.message,true);}
  finally {if(request===state.archiveRequest){state.archiveLoading=false;renderArchives();icons();}}
}

// 载入/删除携带列表对应的预期轮次和激活令牌；后端负责等待当前步及事务切换。
async function changeArchive(operation, run) {
  if (state.archiveBusy || !state.archiveData) return;
  const context=state.archiveData;
  state.archiveBusy=true;simulationControls();renderArchives();
  archiveFeedback(operation==='load' || run.active ? '正在等待当前步骤完成并保存，随后'+(operation==='load'?'载入所选存档':'删除当前存档并新建空白轮次')+'…' : '正在永久删除存档…');
  try {
    const path='/api/runs/'+encodeURIComponent(run.run_id)+(operation==='load'?'/activate':'?expected_run_id='+encodeURIComponent(context.current_run_id));
    const response=await fetch(path,{method:operation==='load'?'POST':'DELETE',headers:{'Content-Type':'application/json','X-Simulation-Activation':context.activation_id},
      ...(operation==='load'?{body:JSON.stringify({expected_run_id:context.current_run_id})}:{})});
    const data=await response.json();
    if(!response.ok) throw new Error(data.detail || '存档操作失败');
    if(operation==='load') {
      if(acceptData(data)) render();
      el("archive-dialog").close();
    } else {
      if(data.state && acceptData(data.state)) render();
      archiveFeedback(data.cleanup_pending?'存档已删除，旧定位请求结束后将完成缓存清理。':'存档及对应缓存已永久删除。');
    }
  } catch(error) {archiveFeedback(error.message,true);}
  finally {
    state.archiveBusy=false;simulationControls();
    if(el("archive-dialog").open) await refreshArchives(state.archivePage);
  }
}
// 只预览概率表单的百分比，提交前不改变后端策略。
function previewFirePolicy() {
  const probability = Number(el("fire-base-probability").value) / 100;
  el("fire-base-value").textContent = Math.round(probability * 100) + "%";
  el("three-step-probability").textContent = ((1 - (1 - probability) ** 3) * 100).toFixed(1) + "%";
}
// 以下绑定页面交互；概率设置和火源清除都需后端确认，点击地图只操作展示。
el("fire-settings-button").addEventListener("click", () => {
  const settings = el("fire-settings");
  settings.hidden = !settings.hidden;
  el("fire-settings-button").setAttribute("aria-expanded", String(!settings.hidden));
  if (!settings.hidden) {
    el("fire-base-probability").value = state.data.fire_policy.base_probability * 100;
    // 只预览概率表单的百分比，提交前不改变后端策略。
    previewFirePolicy();
  }
});
el("fire-base-probability").addEventListener("input", previewFirePolicy);
el("fire-settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  await action("/api/fire-policy", { method: "PUT", body: JSON.stringify({ base_probability: Number(el("fire-base-probability").value) / 100, suppression_factor: state.data.fire_policy.suppression_factor }) });
  el("fire-settings").hidden = true;
  el("fire-settings-button").setAttribute("aria-expanded", "false");
});
// 在规范实体 ID、名称和别名中检索，选择后由地图控制器聚焦。
function searchEntities() {
  const query = el("map-search").value.trim().toLowerCase();
  const results = el("map-search-results");
  if (!query || !state.data) { results.hidden = true; return; }
  const matches = state.data.entities.filter((entity) => [entity.id, entity.name, ...entity.aliases].some((value) => value.toLowerCase().includes(query))).slice(0, 12);
  results.innerHTML = matches.length ? matches.map((entity) => '<button type="button" role="option" data-select="' + entity.id + '"><strong>' + escapeHTML(entity.name) + '</strong><span>' + escapeHTML(entity.id) + " · " + escapeHTML(scene.typeName(entity)) + "</span></button>").join("") : '<div class="search-empty">未找到匹配地点</div>';
  results.hidden = false;
}
el("map-search").addEventListener("input", searchEntities);
el("map-search").addEventListener("focus", searchEntities);
el("map-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") el("map-search-results").hidden = true;
  if (event.key === "ArrowDown") { event.preventDefault(); el("map-search-results").querySelector("button")?.focus(); }
  if (event.key === "Enter") el("map-search-results").querySelector("button")?.click();
});
el("map-search-results").addEventListener("keydown", (event) => {
  const buttons = [...el("map-search-results").querySelectorAll("button")];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }
  if (event.key === "Escape") { el("map-search-results").hidden = true; el("map-search").focus(); }
});
// 统一处理动态生成的消息、住址、报告、重试和存档按钮，避免每次渲染重新绑定。
document.addEventListener("click", async (event) => {
  const discoverySource = event.target.closest("[data-discovery-source]");
  if (discoverySource) {
    openCommunity(discoverySource.dataset.discoveryCommunity);
    await showHistoricalItem("messages",discoverySource.dataset.discoverySource);
    return;
  }

  const loadRun=event.target.closest('[data-run-load]'),deleteRun=event.target.closest('[data-run-delete]');
  if(loadRun || deleteRun) {
    const id=(loadRun || deleteRun).dataset[loadRun?'runLoad':'runDelete'];
    const run=state.archiveData?.items.find(item=>item.run_id===id);
    if(!run || state.archiveBusy)return;
    if(loadRun) {if(!run.active && run.compatible)await changeArchive('load',run);}
    else {
      state.deleteTarget=run;
      el("archive-delete-description").textContent='存档 '+run.run_id.slice(0,8)+'（保存于 '+archiveDate(run.saved_at)+'），仿真 '+clock(run.simulation_minute)+'，'+run.message_count+' 条群聊、'+run.report_count+' 份报告。'+
        (run.active?'这是当前存档；本步完成后将删除，并自动创建暂停的空白轮次。':'删除后不会影响当前使用的存档。');
      el("archive-delete-dialog").showModal();
    }
    return;
  }
  if (event.target.closest("[data-load-messages]")) { await loadHistory("messages"); return; }
  if (event.target.closest("[data-load-reports]")) { await loadHistory("reports"); return; }
  const candidate = event.target.closest("[data-candidate]");
  if (candidate) scene.select(candidate.dataset.candidate, true);
  const reportLink = event.target.closest("[data-report]");
  if (reportLink) {
    const report = document.getElementById(reportLink.dataset.report);
    if (!report) { await showHistoricalItem("reports", reportLink.dataset.report); return; }
    report?.scrollIntoView({block:"nearest",behavior:"smooth"});
    report?.classList.add("reply-focus"); setTimeout(()=>report?.classList.remove("reply-focus"), 1400);
  }
  const retry = event.target.closest("[data-retry]");
  if (retry) {
    if(state.archiveBusy)return;
    const requestedActivation=state.data.persistence.activation_id;
    retry.disabled = true;
    fetch("/api/localization/" + encodeURIComponent(retry.dataset.retry) + "/retry", {method:"POST",headers:{'X-Simulation-Activation':requestedActivation}})
      .then(async response => {if(!response.ok) throw new Error("重试未提交，请刷新定位状态后重试。"); return response.json();})
      .then(loc => { if (requestedActivation!==state.data.persistence.activation_id)return; if (loc.session_id === state.data.localization.session_id && loc.revision >= state.data.localization.revision) state.data.localization = loc; renderLocalization(); icons(); })
      .catch(error => {if(requestedActivation!==state.data.persistence.activation_id)return;el("localization-error").textContent=error.message;el("localization-error").hidden=false;retry.disabled=false;});
  }
  const community = event.target.closest("[data-community]");
  if (community) openCommunity(community.dataset.community);
  const reply = event.target.closest("[data-reply]");
  if (reply) {
    const target = el("chat-" + reply.dataset.reply);
    if (!target) { await showHistoricalItem("messages", reply.dataset.reply); return; }
    target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    target?.classList.add("reply-focus");
    setTimeout(() => target?.classList.remove("reply-focus"), 1400);
  }
  const select = event.target.closest("[data-select]");
  const building = event.target.closest("[data-building]");
  if (select) { scene.select(select.dataset.select, true); el("map-search-results").hidden = true; }
  if (building?.dataset.building) scene.select(building.dataset.building, true);
  if (!event.target.closest(".map-search-field")) el("map-search-results").hidden = true;
  if (!event.target.closest(".map-actions")) {
    el("fire-settings").hidden = true;
    el("fire-settings-button").setAttribute("aria-expanded", "false");
  }
});
el("community-back").addEventListener("click", () => openCommunity(null));
el("community-switch").addEventListener("change", event => openCommunity(event.target.value));
el("community-members-button").addEventListener("click", () => {
  if (!state.members) state.roomScroll[state.activeCommunity] = el("chat-list").scrollTop;
  state.members = !state.members;
  if (!state.members) state.chatSignature = "";
  renderChats(); icons();
});
map.addEventListener("map-entity-select", event => {
  const entity = state.data?.entities.find(e => e.id === event.detail.id);
  const community = state.data?.communities.find(c => c.id === entity?.id || c.id === entity?.area_id);
  if (community) openCommunity(community.id);
});
el("zoom-in").addEventListener("click", () => scene.setZoom(scene.zoom * 1.35));
el("zoom-out").addEventListener("click", () => scene.setZoom(scene.zoom / 1.35));
el("zoom-fit").addEventListener("click", () => scene.fit());
el("show-poi-labels").addEventListener("change", () => scene.setLayers(el("show-poi-labels").checked, el("show-area-boundaries").checked));
el("show-area-boundaries").addEventListener("change", () => scene.setLayers(el("show-poi-labels").checked, el("show-area-boundaries").checked));
el("close-inspector").addEventListener("click", () => {
  const id = scene.selectedId, fireId = scene.selectedFireId;
  scene.select(null);
  const target = id ? map.querySelector('[data-id="' + id + '"]') : fireId ? map.querySelector('[data-fire-id="' + fireId + '"]') : map;
  target?.focus({ preventScroll: true });
});
el("clear-selected-fire").addEventListener("click", () => {
  if (scene.selectedFireId) action("/api/fire/" + encodeURIComponent(scene.selectedFireId), { method: "DELETE" });
});
el("clear-fire").addEventListener("click", () => action("/api/fire", { method: "DELETE" }));
el("reset-button").addEventListener("click", () => { scene.select(null); action("/api/simulation", { method: "POST", body: JSON.stringify({ action: "reset" }) }); });
el("step-button").addEventListener("click", () => action("/api/simulation", { method: "POST", body: JSON.stringify({ action: "step" }) }));
el("start-button").addEventListener("click", () => action("/api/simulation", { method: "POST", body: JSON.stringify({ action: state.data?.running ? "pause" : "start" }) }));
map.addEventListener("map-view-change", positionPopup);
new ResizeObserver(positionPopup).observe(el("map-shell"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    scene.select(null);
    el("fire-settings").hidden = true;
    el("fire-settings-button").setAttribute("aria-expanded", "false");
  }
});
// 建立并重连事件通道；定位增量须匹配会话、revision 和激活令牌，完整状态走 acceptData。
function connectSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(protocol + "//" + location.host + "/ws");
  state.socket = socket;
  socket.addEventListener("message", (event) => {
    if(state.socket!==socket)return;
    const message = JSON.parse(event.data);
    if(message.type==='archives') {
      if(el("archive-dialog").open && !state.archiveBusy)refreshArchives();
      return;
    }
    if (message.type === "localization") {
      const incoming = message.localization, current = state.data?.localization;
      if (current?.session_id !== incoming.session_id || current.revision > incoming.revision) return;
      if(message.persistence?.activation_id!==state.data?.persistence?.activation_id)return;
      state.data.localization = incoming;
      if (message.persistence) state.data.persistence = message.persistence;
      render();
    } else { if(acceptData(message.state))render(); }
  });
  socket.addEventListener("close", () => setTimeout(connectSocket, 1500));
}
icons();
el("history-detail-close").addEventListener("click", () => el("history-detail").close());
el("archive-button").addEventListener("click",()=>{
  if(!state.data || state.archiveBusy)return;
  archiveFeedback('');el("archive-dialog").showModal();refreshArchives(1);
});
el("archive-close").addEventListener("click",()=>{if(!state.archiveBusy)el("archive-dialog").close();});
el("archive-dialog").addEventListener("cancel",event=>{if(state.archiveBusy)event.preventDefault();});
el("archive-prev").addEventListener("click",()=>refreshArchives(state.archivePage-1));
el("archive-next").addEventListener("click",()=>refreshArchives(state.archivePage+1));
el("archive-refresh").addEventListener("click",()=>refreshArchives());
el("archive-delete-cancel").addEventListener("click",()=>{state.deleteTarget=null;el("archive-delete-dialog").close();});
el("archive-delete-confirm").addEventListener("click",async()=>{
  const target=state.deleteTarget;state.deleteTarget=null;el("archive-delete-dialog").close();
  if(target)await changeArchive('delete',target);
});
setInterval(()=>{if(el("archive-dialog").open && !el("archive-delete-dialog").open && !state.archiveBusy && state.archiveData?.cleanup?.length)refreshArchives();},5000);
// 先获取完整快照再连 WebSocket，避免增量消息先于页面基础状态到达。
api("/api/state").then(connectSocket).catch((error) => {
  el("map-error").hidden = false; el("map-error").textContent = error.message;
});

// 筛选仅改变事件发现，不跟随当前打开的群聊；切档使在途分页失效。
for (const [id,key] of [["discovery-category","category"],["discovery-community","community"]]) {
  el(id).addEventListener("change",event=>{
    const view=state.discoveryView;view[key]=event.target.value;view.mode='live';view.items=[];view.request++;view.loading=false;view.error='';el('discovery-list').scrollTop=0;renderDiscovery();
  });
}
el("discovery-older").addEventListener("click",loadDiscoveryHistory);
el("discovery-latest").addEventListener("click",()=>{
  const view=state.discoveryView;view.mode='live';view.items=[];view.request++;view.loading=false;view.error='';el('discovery-list').scrollTop=0;renderDiscovery();
});
