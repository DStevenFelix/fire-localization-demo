# Fire 网页与算法API契约

本文件描述当前真实代码，以 `frontend/bridge/server.py`、`frontend/bridge/socialnet.py`、`frontend/bridge/traffic_signals.py` 和 `fire_locator/models.py` 为准。网页只连接 `frontend/bridge/server.py`（默认8080），经Vite代理访问 `/api`；`fire_locator/api.py` 是独立、可选的原算法HTTP入口，路径不带 `/api`，两者不能混用。默认启动方式 `start.ps1` 不启动该可选入口，8000端口由 SocialNet 帖子源使用。

## 1. 网页Bridge端点

所有请求/响应为JSON，除信号灯SSE。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| GET /api/health | 无 | status、algorithm、default_mode、live_requires_confirmation |
| GET /api/pois | 无 | 原始90项：poi_id/name/type/coordinates/can_post |
| GET /api/scenarios | 无 | scenarios（原始8罐）、default_target_poi_id |
| GET /api/scenarios/active | 无 | 最近一个仍在运行的 SocialNet 流式Session；没有时为空 |
| GET /api/spatial-data | 无请求体/查询参数 | 见第2节 |
| POST /api/scenarios/prepare | target_poi_id（默认T-SW-01）、mode（offline或live）、seed（默认42，0..2^31-1）、source（demo或socialnet，默认demo） | 201 Session |
| POST /api/localization/run | session_id；confirm_paid_api布尔值（默认false）；paused布尔值（默认false） | 202 Session |
| GET /api/localization/{session_id} | 32位十六进制会话ID | Session |
| GET /api/localization/{session_id}/posts | 32位十六进制会话ID | `{ session_id, post_count, posts: Post[] }` |
| POST /api/localization/{session_id}/reset | {} | 201 新Session |
| POST /api/localization/{session_id}/handoff | 无请求体 | Session，`analysis_frozen` 置为 true |
| POST /api/localization/{session_id}/stop | 无请求体 | Session，状态置为 completed |
| PUT /api/localization/{session_id}/pause | `{ paused: 布尔值 }` | Session |
| GET /api/traffic-signals/stream | 无 | `text/event-stream`，见第7节 |

`handoff` 和 `stop` 没有请求体；`pause` 的请求体为 `{ paused: 布尔值 }`。

### 1.1 两种帖子来源

`source` 决定Bridge如何取得帖子。网页工作台固定发送 `source: "socialnet"`；`demo` 供脚本和测试直接调用算法流程。

| 行为 | `demo` | `socialnet` |
| --- | --- | --- |
| 帖子来源 | prepare时由 `fire_locator/demo.py` 生成100条模拟帖子，写入会话目录的 `demo_posts.jsonl` | Bridge调用 SocialNet 帖子源（`SOCIALNET_BASE_URL`，默认 `http://127.0.0.1:8000/api/post-source`）持续拉取规则初筛后的火情帖 |
| 批次 | 每批10条，共10批 | 每3条一批（`socialnet.BATCH_SIZE`） |
| 开始运行的付费确认 | Live必须 `confirm_paid_api=true`，未确认为403 | 任何模式下都必须 `confirm_paid_api=true`，因为居民发帖使用模型；未确认为403 |
| 结束 | 10批处理完后调用 `prediction()`，状态置为 completed | 定位随帖子持续更新；`handoff` 后冻结定位分析，`stop` 后状态置为 completed |
| posts端点 | 返回 `demo_posts.jsonl` 中按时间排序的全部帖子 | 返回内存中最近60条帖子；`post_count` 为累计收到的帖子数 |

### 1.2 通用规则

prepare和run的请求禁止额外字段，非法输入为422；未知会话为404；重复启动、运行中重置、旧数据指纹会话或状态不允许的操作为409。`confirm_paid_api` 必须是布尔值，字符串 `"true"` 无效。prepare只支持原始储罐场景，不支持传EXT住宅ID作为Ground Truth；这不妨碍算法返回扩展候选。

SocialNet流式会话的补充规则：

- `run` 在会话已在运行时直接返回当前Session，不重复启动；状态不是 prepared 时为409。`paused=true` 表示帖子和定位都先处于暂停状态。
- SocialNet帖子源不可达时，`run` 返回503。
- `handoff` 只接受正在运行且已有至少一个定位候选的会话。冻结后帖子继续进入 posts 端点并展示，但不再启动新的定位批次。
- `pause` 只接受正在运行的流式会话，暂停或恢复 SocialNet 发帖和新批次的启动。
- `stop` 要求会话已 `handoff`，否则409；重置时不受此限制。
- `reset` 会停止 SocialNet 发帖，清理 `runtime/frontend` 下除 `_demo_posts` 和仍在运行的会话以外的历史会话目录，再用相同的储罐、模式和种子准备新会话。
- 出错时Bridge把 `error_type` 和 `message` 写入 `error`。SocialNet停止、帖子无法读取或帖子格式无效时状态置为failed；定位失败或待处理帖子积压时状态保持running，帖子继续进入posts端点，定位停止。Bridge不会自动切换模式或重复提交付费任务。

`demo` 来源的 `reset` 在定位进行中返回409，否则新建一个会话目录，旧会话目录保留。

## 2. /api/spatial-data响应

```typescript
type SpatialData = {
  version: "1.0.0";
  original: object;          // 原始空间模型完整对象
  extended: ExtendedPoi[];   // city_scene/poi_catalog.json，326项
  extended_relations: {subject_id:string; relation:"part_of"|"serves"; object_id:string; source:string}[];
  city_offset: [30, 25];
  spatial_fingerprint: string; // Bridge所用正式数据快照的SHA-256
};
```

original包含pois/areas/roads/nodes/relations/alias_index/id_redirects及原始坐标/来源元数据。前四集合合计90项。接口不返回名为registry的平铺416项数组：前端合并原始90与扩展326，保留来源。

ExtendedPoi包含id、name、aliases、type、category、parent_id、region_id、community_id、center、geometry、coordinate_system、can_post、post_policy、source；原始对象使用entity_type等原有字段。扩展类型为社区7、功能区8、建筑106、入口120、物业联系点7、公园4、道路20、路口40、内部节点12、预留地1、无人机站1。完整正式Schema为city_scene/handoff_schema.json。

## 3. Post与算法输入

```typescript
type Post = {
  id: string;                 // 非空，同ID相同内容可去重
  timestamp: string;          // ISO-8601，分钟精度，Asia/Shanghai
  text: string;               // 1..4000字符
  location_poi_id: string;
  urgency: "低" | "中" | "高";
};
```

模型定义在fire_locator/models.py，禁止额外字段。时间按分钟、非递减输入；无时区时间按上海处理。Ground Truth不属于Post，不进入推理。

Bridge自身取得帖子并调用现有ingest；网页run端点不接收posts字段。真实业务帖子可通过算法模块自身入口接入，保持Post结构。

### 3.1 舆情展示接入

posts端点按第1.1节返回该会话的实际帖子和条数。缺失会话或帖子文件返回404，旧地图指纹返回409。SocialNet来源的响应只包含帖子字段和会话标识、条数，时间戳为带时区的ISO-8601。

展示类型定义在 `frontend/web/src/types/index.ts`。

```typescript
type OpinionPost = {
  id: string;
  text: string;
  timestamp?: string;           // 带时区的 ISO-8601，界面按上海时间显示
  location_poi_id?: string;     // 发帖位置，未知 POI 直接显示标识
  urgency?: '低' | '中' | '高';
};
```

`frontend/web/src/utils/opinionFeed.ts` 导出 `createOpinionFeed(sessionId)` 和 `useSocialNetPosts`。`App.tsx` 随会话创建 feed，`OpinionPanel` 订阅该实例。`useSocialNetPosts` 在会话运行期间每秒调用一次 posts端点，把新收到的帖子交给 feed，界面每秒展示一条。

接入外部来源时，在 `App.tsx` 用实际订阅替换 `useSocialNetPosts`，由适配器转换字段并传入关联的本地会话 ID。订阅清理由外部接入负责，来源标签和状态通过面板 props 传入，未知总量可省略 `total`。已有 `opinionFeed` 可直接用于接入，例如在订阅回调里调用下列函数。

```typescript
function onExternalPost(sourceSessionId: string, post: OpinionPost) {
  opinionFeed.receivePost(sourceSessionId, post);
}

function onExternalClear(sourceSessionId: string) {
  opinionFeed.clearPosts(sourceSessionId);
}
```

入口按会话接收连续到达的帖子，展示窗口更新到最新一条。真实外部通信和真实帖子参与火情定位的联调由后续接入成员完成。

## 4. Prediction输出

正式JSON Schema：integration/prediction.schema.json。

```typescript
type Coordinates = {x_m:number; y_m:number};
type Candidate = {
  rank:number;             // 从1开始，由算法决定
  poi_id:string;
  name:string;
  coordinates:Coordinates;
  votes:number;
  confidence:number;
  score:number;
  relative_score:number;
  cluster_ids:string[];
};
type Prediction = {
  coordinate_system?: "LOCAL30x25" | "local_cartesian_meters" | "CITY90x75";
  candidates:Candidate[];  // 可以为空；原算法通常至多3项
  active_cluster_count:number;
  cold_cluster_count:number;
  processed_count:number;
  pending_count:number;
  status:string;
  current_time?:string;
};
```

候选没有必须的type/can_post字段。rank、votes、score等必须是算法实际输出；confidence、relative_score和前端颜色不能视作经校准的火灾概率。原算法坐标系是local_cartesian_meters；扩展算法应统一返回CITY90x75，包含原始候选时仅转换一次。缺省坐标系按旧局部处理。

## 5. Session和候选历史

```typescript
type Batch = {batch_number:number; processed_count:number; ignored_count:number; prediction:Prediction};
type Session = {
  session_id:string;
  mode:"offline"|"live";
  status:"prepared"|"running"|"completed"|"failed";
  source:"demo"|"socialnet";
  analysis_frozen?:boolean;   // SocialNet来源：handoff后为true
  paused?:boolean;            // SocialNet来源：是否暂停
  poi_fingerprint:string;
  spatial_fingerprint:string;
  target_poi_id:string;
  seed:number;
  post_count:number;
  ground_truth:{poi_id:string; name:string; coordinates:Coordinates};
  prediction:Prediction|null;
  evaluation:{top1_hit:boolean; top3_hit:boolean; target_rank:number|null; distance_m:number|null}|null;
  processed_count:number;
  ignored_count:number;
  batch_count:number;
  batch_history:Batch[];
  error:{error_type:string; message:string}|null;
  created_at:string;
  started_at:string|null;
  completed_at:string|null;
};
```

`demo` 来源每10条调用一次 `ingest(..., flush=True)`，每批发布实际Prediction、累计进度和完整batch_history，最后调用 `engine.prediction()` 并标记completed。失败保留已经发布的进度和历史，不自动切换模式或重复付费任务。

`socialnet` 来源每收齐3条火情帖调用一次 `ingest(batch)` 并发布同样的进度字段，batch_history保留最近60批。Bridge不为这类会话调用最终的 `prediction()`，Top1/Top2/Top3取当前 `prediction` 中rank为1、2、3的候选。批次大小由Bridge的 `BATCH_SIZE` 决定，前端按Session实际返回的batch_history、batch_count和processed_count展示，不写死阈值。

前端在会话运行期间每秒轮询一次Session，刷新页面后通过 `/api/scenarios/active` 恢复仍在运行的流式会话。services/api.ts规范化所有历史；poiRegistry.ts解析名称、父级和坐标；candidateEvidence.ts保留每个ID的历史最大展示强度；SandboxMap.tsx完成标记。最终Top1由Prediction中rank=1决定，不由数组位置或颜色决定。当前Top3和退出当前排名的历史候选均保留。

已注册ID优先显示主数据名称/中心；region_name与parent_name是前端派生属性，不是服务端新增字段。未知ID按返回名称和声明坐标系显示。Ground Truth始终为原始局部坐标，只用于显示/评估。

## 6. 可选原算法HTTP服务

fire_locator.api提供GET /health、POST /posts、GET /prediction、GET /pois，不带/api前缀。POST /posts体为 `{posts: Post[], flush?: boolean}`，posts默认空数组、最多1000条，flush默认false；返回ingest结果，含mode、duplicates、pending_count、updates、processed_count、ignored_count、llm_calls_this_process、embedding_requests_this_process。每个updates项包含prediction。

该实时HTTP入口要求帖子时间在最近60分钟至未来1分钟内；历史演示数据应走算法历史输入方式，不能直接当实时帖子提交。网页演示只需Bridge和Vite，不要求启动该第三个进程。

## 7. 信号灯SSE

`GET /api/traffic-signals/stream` 返回 `text/event-stream`。Bridge作为TCP服务端接收信号控制机主动上报的灯态：监听地址由环境变量 `FIRE_SIGNAL_HOST`（默认 `192.168.1.190`）和 `FIRE_SIGNAL_PORT`（默认 `5000`）指定，`FIRE_SIGNAL_HOST` 为空或 `off` 时不监听。只接受 `192.168.1.111`～`116` 六个地址的连接。

每条事件的data为一个JSON对象：

```typescript
type SignalSnapshot = {
  listening: boolean;   // Bridge的TCP接收端是否正在监听
  devices: {
    [ip: string]: {
      connected: boolean;
      groups: { color: string; countdown: number }[];  // 16项，见下
    };
  };
};
```

订阅建立后先发送一条完整快照，随后每次灯态变化发送一条，15秒没有变化时发送注释行 `: keepalive` 作为心跳。首条数据之前发送 `retry: 1000`。`groups` 依次为东、南、西、北四个方向，每个方向依次为左转、直行、右转、人行。`color` 为 `red/green/yellow/off/red_flash/green_flash/yellow_flash` 之一，`countdown` 为秒值。控制机断开后该设备保留最后的灯组，`connected` 置为 false。

前端 `frontend/web/src/utils/liveTrafficSignals.ts` 把设备地址映射到路口，设备IP尾号111～116依次对应 `J04`、`R-02`、`J03`、`J01`、`R-01`、`J02`。现场部署的IP与路口关系需要联调时确认。
