# 沙盘前端联动契约

`src/services/dashboardInput.ts` 导出 `connectDashboardSource(subscribe, adapt, options?, mode?)`。收到的原始报文经 `adapt` 转成前端消息，经校验后进入地图、调度 Agent、设备媒体窗和统一时间线。定位、任务反馈和规划路径各自更新。路径是计划，设备地图标记和实际轨迹由定位采样更新。

运行 `npm run dev` 后，顶部的「真实联动」监听当前工作台的物理设备消息和既有红绿灯 SSE。「本地应急演练」无需 Bridge，默认派出四辆，也可选择 1～3 辆。「SocialNet 联动演练」通过现有 Bridge 消费 SocialNet 与定位结果，可把候选交给前端 `EmergencyDemo`。定位模型的 `offline/live` 设置独立于设备数据来源。切换工作台会关闭上一工作台的连接、计时、媒体渲染和输入订阅。

## 数据职责

| 数据 | 提供方 | 前端入口 |
| --- | --- | --- |
| 帖子与监测进度 | SocialNet，经现有 Bridge | `src/services/api.ts`、`src/utils/opinionFeed.ts` |
| Top1、Top2、Top3、批次和历史证据 | 我们自己的 FireLocalizer，经现有 Bridge Session / Prediction | `src/App.tsx` 读取 Session 的 `prediction` 和 `batch_history`，更新 `LocationPanel` 和 `SandboxMap`。外部对接清单不包含定位候选 |
| 消防车和无人机连接、位姿、精度和运行状态 | 设备及硬件定位负责人 | `connectDashboardSource` → `device.connection` / `device.telemetry` |
| 调度阶段、侦查结果、车辆和无人机任务、规划路径 | 调度 Agent、侦查服务和设备执行负责人 | `connectDashboardSource` → `agent.event` / `recon.candidate` / `recon.confirmed` / `device.task` / `device.route` |
| 视频、图片及各路流状态 | 摄像头和媒体网关负责人 | `connectDashboardSource` → `media.feed` |
| 现场数据通道状态 | 各通道传输负责人 | `connectDashboardSource` → `source.connection` |
| 信号灯 | 已有 Bridge SSE | `src/utils/liveTrafficSignals.ts` → `src/App.tsx` → `TrafficSignalController` |

## 注册真实适配器

在 `src/config/dashboardSource.ts` 的 `connectPhysicalDashboardSource()` 注册现场源。目前该函数等待真实协议注册，默认不订阅设备或调度服务。进入真实工作台时，`src/App.tsx` 先挂载工作台入口，再调用此函数。已有的 `connectDashboardSource()` 负责订阅、映射、校验和更新共享状态。切到演练或卸载时，入口自动退订，旧回调失效。回到真实工作台时，应用重新调用注册函数。

```ts
import { connectDashboardSource } from '../services/dashboardInput';

// 三项输入由现场协议、设备编号和标定结果确定。
export function connectPhysicalDashboardSource() {
  connectDashboardSource(subscribeTransport, mapFieldMessage, {
    idMap: { 'robot-04': 'EXT-FIRE-VEHICLE-04' },
    calibrations: [fieldCalibration],
  });
}
```

`subscribeTransport(receive)` 可同步推送首批消息，返回取消订阅函数，负责关闭连接及释放创建的流、对象 URL 和监听器。返回的 `disconnect` 也可提前调用。传输根据实际连接报告 `source.connection`，单设备与流状态分别报告 `device.connection`、`media.feed`。发生通道断线时，适配器根据该通道负责的设备与媒体范围上报状态。`idMap` 是原始 ID 到前端 ID 的一对一字符串表，`calibrations` 是标定数组。各订阅的映射和标定独立生效。模式默认 `physical`，演练测试可传 `simulation`。

`mapFieldMessage(raw)` 返回下表消息。回调结果为 `{accepted: true}`、`{accepted: true, duplicate: true}` 或 `{accepted: false, error}`。配置无效、可预期的订阅创建失败及原始报文解析失败可抛 `RangeError`，工作台显示原因。异步连接故障通过状态消息上报，程序异常保留调用栈。外部报文通过现场协议映射，本文表格及样例定义的是前端消费结构。

消息、去重记录、设备轨迹、侦查进度和时间线只保存在页面内存中，刷新页面或切换工作台后清空，不支持断线重放。传输方重连后如需恢复现场，应重新发送连接状态，以及各设备的最新位置、任务和媒体状态。

## 运行现场接入样例

`src/services/dashboardSourceExample.ts` 是内存测试适配器。它包含内存订阅、原始报文映射、设备 ID 映射和示例标定，接收调用者主动发布的报文。运行 `npm run dev`，打开其本地地址并选择「真实联动」。在浏览器开发者工具控制台执行下列代码。应先看到 4 号车上线并保持虚拟待命，再看到地图位置变为 CITY (45, 37.5)，航向为 π / 2，并从该点记录轨迹。两次 `publish` 都返回 `{accepted: true}`。

```js
const { connectExampleDashboardSource } = await import('/src/services/dashboardSourceExample.ts');
const example = connectExampleDashboardSource();
example.publish({
  topic: 'link', serial: 'truck4-online', sampled: Date.now(),
  body: { deviceId: 'rig-4', state: 'online' },
});
example.publish({
  topic: 'fix', serial: 'truck4-fix', sampled: Date.now(),
  body: { deviceId: 'rig-4', kind: 'fireTruck', east: 2.5, north: 2, yaw: 90 },
});
// 完成验收时调用 example.disconnect()，或切到本地应急演练。
```

示例的 `serial`、`sampled`、`incident` 分别映射到 `eventId`、`occurredAt`、`incidentId`。主题 `source/link/fix/plan/task` 对应连接和设备消息，`dispatch/camera` 对应 Agent 和媒体，`candidate/confirmation` 对应逐点侦查和火点确认。其余数据放进 `body`。示例设备 ID 为 `rig-1` 至 `rig-4`、`aircraft-1` 至 `aircraft-2`，`fix` 原始位置字段为 `east/north`（米）和 `yaw`（度）。`e2e/physicalDashboard.spec.ts` 通过这个订阅驱动地图和调度界面。

## 消息信封与类型

| 字段 | 语义 |
| --- | --- |
| `sourceMode` | 字符串 `physical` 或 `simulation`，必须与当前工作台匹配 |
| `eventId` | 非空字符串，工作台内唯一。多通道接入请加来源前缀，重复投递保留同一个 ID |
| `occurredAt` | 采样或事件发生时间，UTC Unix 毫秒数，或带明确时区的 ISO 8601 字符串 |
| `sessionId` | 可选非空字符串，提供时须匹配当前 Bridge 或演练会话。独立现场事件可省略，随 Bridge 会话切换保持有效 |
| `incidentId` | 非空字符串，标识同一火情或处置事件。设备任务、设备路线、侦查消息、作业失败或中断反馈及携带 `taskId` 的消息必填 |
| `eventType` / `payload` | 类型和值按下表映射 |

Payload 中的各类 ID、坐标系名称、标定版本、阶段、摘要和结果均为非空字符串。坐标点的 `x` 和 `y` 为有限数值，单位由坐标系决定。省略未提供的可选字段。

| 类型 | Payload 字段 | 界面行为 |
| --- | --- | --- |
| `source.connection` | `sourceId, state` | 展示传输源状态 |
| `device.connection` | `deviceId, state` | 单设备连接状态。两类连接支持 `waiting/connecting/online/disconnected/error` |
| `device.telemetry` | `deviceId, kind: fireTruck/drone, coordinateSystem, position: {x,y}, headingRadians`，可带 `calibrationVersion, taskId, status, accuracyMeters, altitudeMeters`。坐标、航向、精度和高度须为有限数值，精度和无人机高度为非负米值 | 接管坐标与航向并追加采样轨迹。无人机高度基准由上游统一。可提供已确认的 `waterTarget: {x,y}`（CITY90x75）以显示喷水。渲染高度 `renderAltitude` 属于 Mock 内部数据 |
| `device.route` | `deviceId, taskId, coordinateSystem, route: [{x,y},…]`，可带 `calibrationVersion`、`purpose: outbound/reconnaissance/return`，默认去程 | 有序航点用于去程和多点侦查展示。空数组明确撤除规划线。适配器可将正式有向路段解析成航点。返程路线记录在任务和日志内 |
| `device.task` | `deviceId, taskId, phase`，可带 `result, status, routeComplete, waterTarget`。`routeComplete` 为布尔值，`waterTarget` 为 CITY90x75 坐标 | 展示接单、起飞、抵达、侦查、返航及执行结果。多点侦查全部结束后可发送 `routeComplete: true`。消防车作业上报 `status: "extinguishing"`，喷水目标可来自同一事件已确认的位置或显式字段 |
| `recon.candidate` | `deviceId, taskId, candidatePoiId, stage`，可带 `rank`（整数 1–3），阶段为 `assigned/arrived/observed`，回传阶段必填 `result` | 记录每架无人机对每个候选的进度、结果与发生时间。中间候选反馈保留剩余路线。初始候选来自 FireLocalizer，侦查报文仅引用其 POI ID |
| `recon.confirmed` | `result`，加 `confirmedFirePoiId` 或 `position: {x,y}, coordinateSystem`。可带 `calibrationVersion, deviceId, taskId` | 有效反馈确认火点。坐标映射到正式地图，命中已建模储罐时同步既有 3D 火场。后续火场监控路线由独立的设备任务与路线消息提供 |
| `agent.event` | 外部使用 `agent: dispatch`，必填非空字符串 `type, phase, summary`，可带 `object, taskId, deviceId, targetPoiId, fireStatus, suppression` | `fireStatus` 为 `normal/burning/extinguishing/extinguished`。同一事件可复用已知火点。发送 `fireStatus: "extinguished"` 确认扑灭。发送 `suppression: "failed"` 或 `"interrupted"` 停止作业效果并显示失败或中断 |
| `media.feed` | `slotId, feedId, kind: video/image, status`，可带 `deviceId, url, stream` | 每路媒体独立绑定。状态为 `idle/connecting/ready/disconnected/error/reconnecting`。发送 `ready` 时需要浏览器可播放的 HTTP、HTTPS、Blob URL 或视频 `MediaStream` |
| `traffic.snapshot` | `devices` | 使用既有 SSE 灯组结构、IP 到路口映射和 `TrafficSignalController` |

车辆 ID 为 `EXT-FIRE-VEHICLE-01` 至 `EXT-FIRE-VEHICLE-04`，无人机 ID 为 `DRONE-01`、`DRONE-02`。提供方可使用经映射的原始 ID。连接与运行状态独立。车支持 `idle/dispatched/en-route/arrived/extinguishing/returning/return-waiting/unreachable`，无人机支持 `idle/dispatched/flying/observing/returning/charging`。设备上线后仍保留虚拟待命点，首条有效采样接管地图位置和航向。位置在 10 秒无新采样后标记为过期，并保留最后有效点。正式地图显示有效去程规划，采样轨迹保留在设备状态中。到达有效终点、任务结束或断连时立即收起相应路线。返程保持定位更新，无规划线或轨迹线。新作业使用新任务 ID。

前端按采样时间比较单设备遥测、连接、同任务路线、同任务反馈以及单路媒体。路径与反馈可以交错到达。某条遥测附带较旧运行状态时，有效定位可继续更新，运行状态采用较新的反馈。外部 Agent 历史事件保留在时间线，调度摘要显示最近阶段。各通道尽量提供可排序的毫秒级时间。同一通道的同毫秒更新按接收顺序处理，显式连接状态优先于同毫秒遥测。相同 `eventId` 的重投不重复记录。未来超过 5 秒、除 Agent 历史事件外早于 30 秒及无效坐标、设备、会话、来源、标定均返回拒绝。设备任务结果与全局处置结果由外部各自显式上报，轨迹到达规划终点、播放完成和页面计时均不改变真实任务结果。

视频槽位为 `air-video-1/2/3` 和 `ground-video-1/2/3/4`，图片槽位为 `air-image-1`。地面槽位依次绑定 1～4 号车，空中槽位可选绑定两架无人机。启动替换源时，用新 `feedId` 发送 `connecting`、`reconnecting` 或 `ready`。已替换源后续的 `idle`、`disconnected`、`error` 不会改写当前窗口。UI 根据浏览器的加载、播放、缓冲、结束和错误事件显示播放状态。HLS 使用浏览器能直接播放的地址，WebRTC 可由媒体适配器完成协商并提供流句柄。真实鉴权、跨域、证书及媒体编码需要在网关联调时确认。

## 物理标定

`DeviceCalibration` 记录 `sourceCoordinateSystem`、`version`、`origin`、`axisDirection`、`physicalBounds`、`mapBounds` 和仿射 `transform`。矩阵顺序为 `[xx, xy, yx, yy, tx, ty]`，结果是 `LOCAL30x25` 内的 `(xx*x + xy*y + tx, yx*x + yy*y + ty)`。局部到城市由正式地图偏移计算，城市到 SVG 和屏幕使用现有地图比例和 `getScreenCTM()`。航向归一化为沿城市地图 X 轴向东起算、逆时针为正的弧度。若设备在相机或局部坐标系中报告航向，适配器需把方向向量按标定旋转、翻轴及缩放后归一化。

`tabletopCalibration` 的参考系 `PHYSICAL_SW_METERS/axis-aligned-v1` 适用于西南原点、X 东 Y 北、米单位、轴对齐的 5×4 米沙盘。三点对应关系为 `(0,0) → (30,25)`、`(2.5,2) → (45,37.5)`、`(5,4) → (60,50)`。现场配置请提交原点、轴及单位、边界、标定版本、至少三个不共线的物理控制点及其 LOCAL/CITY 对应点。在控制点之外复测角点和中间点，对照位置残差、行进航向和无人机高度基准。前端接受已注册的坐标系和匹配的标定版本。已确认在 `CITY90x75` 或 `LOCAL30x25` 的数据可直接标明坐标系，二者单位均为仿真单位。

## 归一化样例

以下示例用于字段映射和夹具。把 `occurredAt` 换成本次采样时间再重放。

```json
{
  "sourceMode": "physical",
  "eventId": "demo:car4:42",
  "occurredAt": "2026-11-23T10:00:00+08:00",
  "eventType": "device.telemetry",
  "payload": {
    "deviceId": "EXT-FIRE-VEHICLE-04",
    "kind": "fireTruck",
    "coordinateSystem": "PHYSICAL_SW_METERS",
    "calibrationVersion": "axis-aligned-v1",
    "position": { "x": 2.5, "y": 2 },
    "headingRadians": 0.25,
    "status": "en-route",
    "accuracyMeters": 0.04
  }
}
```

下表沿用同一个信封，每条消息分配自己的 `eventId`。

| 类型 | Payload 示例 |
| --- | --- |
| `device.telemetry` | `{"deviceId":"DRONE-01","kind":"drone","coordinateSystem":"CITY90x75","position":{"x":32,"y":30},"headingRadians":1.57,"altitudeMeters":1.4,"status":"observing"}` |
| `device.route` | `{"deviceId":"EXT-FIRE-VEHICLE-04","taskId":"fire-01:truck-04","coordinateSystem":"LOCAL30x25","route":[{"x":15,"y":12.5},{"x":19,"y":12.5}]}` |
| `recon.candidate` | `{"deviceId":"DRONE-01","taskId":"fire-01:scout-01","candidatePoiId":"T-NW-01","rank":2,"stage":"observed","result":"热成像显示罐顶起火"}` |
| `recon.confirmed` | `{"confirmedFirePoiId":"T-NW-01","result":"现场热成像确认 1 号罐起火"}` |
| `device.task` | `{"deviceId":"EXT-FIRE-VEHICLE-04","taskId":"fire-01:truck-04","phase":"作业开始","status":"extinguishing"}` |
| `device.task` | `{"deviceId":"DRONE-01","taskId":"fire-01:scout-01","phase":"侦察完成","result":"已取得热成像反馈","status":"returning"}` |
| `agent.event` | `{"agent":"dispatch","type":"侦察反馈","phase":"侦察完成","summary":"无人机反馈已收到","taskId":"fire-01:scout-01","deviceId":"DRONE-01"}` |
| `agent.event` | `{"agent":"dispatch","type":"火场监控","phase":"监控已下发","summary":"派 1 号机监控确认火点","taskId":"fire-01:monitor-01","deviceId":"DRONE-01","targetPoiId":"T-NW-01"}` |
| `device.task` | `{"deviceId":"DRONE-01","taskId":"fire-01:monitor-01","phase":"接收监控任务","status":"dispatched"}` |
| `device.route` | `{"deviceId":"DRONE-01","taskId":"fire-01:monitor-01","coordinateSystem":"CITY90x75","purpose":"outbound","route":[{"x":32,"y":30},{"x":38,"y":45}]}`，终点由真实规划提供 |
| `agent.event` | `{"agent":"dispatch","type":"处置结果","phase":"任务结束","summary":"已收到灭火和归队反馈","targetPoiId":"T-NW-01","fireStatus":"extinguished"}` |
| `media.feed` | `{"slotId":"air-image-1","feedId":"scout-photo","deviceId":"DRONE-01","kind":"image","status":"ready","url":"/fixture/scout.png"}`，地址为测试夹具 |
| `media.feed` | `{"slotId":"ground-video-4","feedId":"vehicle-camera-4","deviceId":"EXT-FIRE-VEHICLE-04","kind":"video","status":"ready","url":"/fixture/truck-4.mp4"}`，地址为测试夹具。断流时用相同 `slotId`、`feedId` 和 `kind` 上报 `status: "disconnected"` |
| `source.connection` | `{"sourceId":"设备网关","state":"online"}` |
| `device.connection` | `{"deviceId":"DRONE-02","state":"disconnected"}` |
| `traffic.snapshot` | `devices` 对象以既有信号机 IP 为键，每台含 `connected` 和 16 项 `groups`。单项形如 `{"color":"yellow_flash","countdown":3}` |

红绿灯的现有 SSE 为 `GET /api/traffic-signals/stream`，上游发送 `{listening, devices}`。设备组顺序为东、南、西、北，每个方向依次为左转、直行、右转、人行。灯态支持 `red/green/yellow/off/red_flash/green_flash/yellow_flash`，倒计时读取秒值。现有 IP 尾号 111～116 的映射以 `src/utils/liveTrafficSignals.ts` 为准。SSE 断开或 10 秒未收到有效快照时，保留最后灯色并标明离线。模拟模式使用本地交通模拟或显式注入的测试快照。

携带 `taskId` 的这些示例在信封中使用 `"incidentId": "fire-01"`。例如先发无人机接单和起飞反馈，随后分别发定位、路线与侦查结果，收到侦查反馈后另发车辆任务和各车路线。车辆抵达、灭火、灭火完成、返程和全局结束或失败分别由实际收到的消息确认。可逐条接入其中任何一类，工作台展示收到的部分。

火点确认后的监控由外部调度发起，使用新的任务 ID。先发送 `agent.event`，再发送关联的 `device.task`、`device.route` 和连续 `device.telemetry`。到达火点的遥测可带 `status: "observing"`，引导界面收起监控去程路线。返程遥测继续更新位置，返程规划消息可进入时间线，地图不绘制返程路线。统一时间线记录任务、路径、侦查与调度事件，也记录首定位及状态发生变化的遥测。持续的纯位置采样进入内部轨迹。

## 储罐编号与虚拟待命点

`recon.candidate` 的 `candidatePoiId`、`recon.confirmed` 的 `confirmedFirePoiId` 和 `agent.event` 的 `targetPoiId` 只接受下列 8 个储罐 POI ID，其他 POI 会被拒绝。FireLocalizer 的 Top1、Top2、Top3 使用的也是这些 ID，侦查报文只引用 ID，不自行生成候选。

| POI ID | 储罐 | CITY90x75 中心 |
| --- | --- | --- |
| `T-NW-01` | 西北罐区 1 号 | (39.626524, 40.419447) |
| `T-NW-02` | 西北罐区 2 号 | (42.393293, 40.419447) |
| `T-NE-01` | 东北罐区 1 号 | (47.583841, 40.419447) |
| `T-NE-02` | 东北罐区 2 号 | (50.350610, 40.419447) |
| `T-SW-01` | 西南罐区 1 号 | (39.717988, 33.984747) |
| `T-SW-02` | 西南罐区 2 号 | (42.393293, 34.008580) |
| `T-SE-01` | 东南罐区 1 号 | (47.446646, 33.960915) |
| `T-SE-02` | 东南罐区 2 号 | (50.167683, 33.960915) |

未收到定位时，四辆消防车显示在 `src/config/emergency.json` 的 `standby` 虚拟待命点：1 号车 (27.2, 27)、2 号车 (62.8, 27)、3 号车 (27.2, 48)、4 号车 (62.8, 48)，均位于原始沙盘之外。两架无人机显示在 `EXT-P-DRONE` 的两个泊位 (28.6, 23.15) 和 (28.6, 24.85)。虚拟待命点只用于占位，不代表硬件停放位置或在线状态。

## 待提供的数据

| 编号 | 负责方 | 请提供真实样例 | 接入结果及当前影响 |
| --- | --- | --- | --- |
| H1 | 消防车和无人机定位负责人 | 四车两机真实 ID 对照。各一条首定位、连续采样、无任务上线、越界/断连数据。注明单位、坐标轴和原点、时间戳时区和采样率、航向零点与正方向、精度和高度基准。提供物理控制点及其地图对应点 | 消费、标定、首次接管、轨迹、离线和过期已可测。实机的绝对位置精度等待控制点核验 |
| H2 | 调度及侦查 Agent 负责人 | 提供含事件、任务和设备 ID 的四车两机任务下发、按设备规划、接单、抵达、Top3 逐点侦查反馈、火点确认、独立监控任务、灭火开始与结果、返程、结束和失败样例。注明必填字段、坐标系、发生时间及重发去重键 | 真实工作台已可消费并展示上述消息，待映射调度报文 |
| H3 | 媒体网关负责人 | 七路视频、一路图片的设备或窗口映射，至少各一条真实媒体描述、连接地址或流句柄、鉴权/过期、断流和恢复样例 | 播放组件已支持真实浏览器媒体。实际设备编码、网络和网关授权待验证 |
| H4 | 交通信号负责人 | 部署时六台设备 IP 与路口关系，Bridge 可达性、鉴权、离线和心跳策略，以及至少一段带灯态变化的 SSE 样例 | 既有 SSE、控制器和分组渲染可用。现场信号机未参与本地验收 |
| H5 | SocialNet / 定位负责人 | 确认现有 Bridge 3 条一批与历史 10 条目标的最终口径 | 前端显示 Bridge 实际批次、已处理数、历史证据和动态 Top3 |

现场传输方还需提供实际可访问的服务地址、订阅方式、消息编码、鉴权与凭证更新方式、断线通知和恢复数据。部署时确认浏览器或同源代理对设备网关、媒体网关和现有 Bridge 的可达性，以及适用的跨域规则、TLS 证书与媒体编码。
