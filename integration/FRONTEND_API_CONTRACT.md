# Fire 网页与算法API契约

本文件描述当前真实代码。网页只连接frontend/bridge/server.py（默认8080），经Vite代理/api；fire_locator/api.py（通常8000）是独立、可选的原算法HTTP入口，两者不能混用路径。

## 1. 网页Bridge端点

所有请求/响应为JSON。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| GET /api/health | 无 | status、algorithm、default_mode、live_requires_confirmation |
| GET /api/pois | 无 | 原始90项：poi_id/name/type/coordinates/can_post |
| GET /api/scenarios | 无 | scenarios（原始8罐）、default_target_poi_id |
| GET /api/spatial-data | 无请求体/查询参数 | 见第2节 |
| POST /api/scenarios/prepare | target_poi_id（默认T-SW-01）、mode（offline或live）、seed（默认42，0..2^31-1） | 201 Session |
| POST /api/localization/run | session_id；confirm_paid_api布尔值（默认false） | 202 Session |
| GET /api/localization/{session_id} | 32位十六进制会话ID | Session |
| GET /api/localization/{session_id}/posts | 32位十六进制会话ID | `{ session_id, post_count, posts: Post[] }` |
| POST /api/localization/{session_id}/reset | {} | 201 新Session，旧会话保留 |

prepare/run请求禁止额外字段。Live必须confirm_paid_api=true，字符串"true"无效；未确认为403。重复启动、运行中重置或旧数据指纹会话为409，非法输入422，未知会话404。prepare只支持原始储罐场景，不支持传EXT住宅ID作为Ground Truth；这不妨碍算法返回扩展候选。

## 2. /api/spatial-data响应

```typescript
type SpatialData = {
  version: "1.0.0";
  original: object;          // 原始空间模型完整对象
  extended: ExtendedPoi[];   // city_scene/poi_catalog.json，325项
  extended_relations: {subject_id:string; relation:"part_of"; object_id:string; source:string}[];
  city_offset: [30, 25];
  spatial_fingerprint: string; // Bridge所用正式数据快照的SHA-256
};
```

original包含pois/areas/roads/nodes/relations/alias_index/id_redirects及原始坐标/来源元数据。前四集合合计90项。接口不返回名为registry的平铺415项数组：前端合并原始90与扩展325，保留来源。

ExtendedPoi包含id、name、aliases、type、category、parent_id、region_id、community_id、center、geometry、coordinate_system、can_post、post_policy、source；原始对象使用entity_type等原有字段。完整正式Schema为city_scene/handoff_schema.json。

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

Bridge自身产生演示Post并调用现有ingest；网页run端点不接收posts字段。真实业务帖子可通过算法模块自身入口接入，保持Post结构。

### 3.1 舆情展示接入

只读端点从 `runtime/frontend/<session_id>/demo_posts.jsonl` 返回该会话的实际帖子和条数，按定位使用的时间顺序排列。同一时间戳保留文件顺序，响应仅包含帖子字段和会话标识、条数。缺失会话或帖子文件返回 404，旧地图指纹返回 409。

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

`frontend/web/src/utils/opinionFeed.ts` 导出 `createOpinionFeed(sessionId)`。`App.tsx` 随会话创建 feed，`OpinionPanel` 订阅该实例。当前 `useSessionPostReplay` 预取只读端点，定位请求成功后每秒调用一次 `receivePost`。预取列表长度和实际展示进度分开，定位进度由原 Session 更新。

接入外部来源时，在 `App.tsx` 用实际订阅替换 `useSessionPostReplay`，由适配器转换字段并传入关联的本地会话 ID。订阅清理由外部接入负责，来源标签和状态通过面板 props 传入，未知总量可省略 `total`。已有 `opinionFeed` 可直接用于接入，例如在订阅回调里调用下列函数。

```typescript
function onExternalPost(sourceSessionId: string, post: OpinionPost) {
  opinionFeed.receivePost(sourceSessionId, post);
}

function onExternalClear(sourceSessionId: string) {
  opinionFeed.clearPosts(sourceSessionId);
}
```

入口按会话接收连续到达的帖子，展示窗口更新到最新一条。模拟回放的总量和节奏由回放器控制。真实外部通信和真实帖子参与火情定位的联调由后续接入成员完成。

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

候选没有必须的type/can_post字段。rank、votes、score等必须是算法实际输出；confidence、relative_score和前端颜色不能视作经校准的火灾概率。原算法坐标系是local_cartesian_meters；未来扩展算法应统一返回CITY90x75，包含原始候选时仅转换一次。缺省坐标系按旧局部处理。

## 5. Session和候选历史

```typescript
type Batch = {batch_number:number; processed_count:number; ignored_count:number; prediction:Prediction};
type Session = {
  session_id:string;
  mode:"offline"|"live";
  status:"prepared"|"running"|"completed"|"failed";
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

当前Bridge每10条调用ingest(...,flush=True)，默认100条/10批。每批发布实际Prediction、累计进度和完整batch_history，最后调用engine.prediction()并标记completed。失败保留已经发布的进度和历史，不自动切换模式或重复付费任务。

前端运行轮询约350ms，恢复轮询约1s。services/api.ts规范化所有历史；poiRegistry.ts解析名称、父级和坐标；candidateEvidence.ts保留每个ID的历史最大展示强度；SandboxMap.tsx完成标记。最终Top1由最终Prediction中rank=1决定，不由数组位置或颜色决定。当前Top3和退出当前排名的历史候选均保留。

已注册ID优先显示主数据名称/中心；region_name与parent_name是前端派生属性，不是服务端新增字段。未知ID按返回名称和声明坐标系显示。Ground Truth始终为原始局部坐标，只用于显示/评估。

## 6. 可选原算法HTTP服务

fire_locator.api提供GET /health、POST /posts、GET /prediction、GET /pois，不带/api前缀。POST /posts体为 `{posts: Post[], flush?: boolean}`，posts默认空数组、最多1000条，flush默认false；返回ingest结果，含mode、duplicates、pending_count、updates、processed_count、ignored_count、llm_calls_this_process、embedding_requests_this_process。每个updates项包含prediction。

该实时HTTP入口要求帖子时间在最近60分钟至未来1分钟内；历史演示数据应走算法历史输入方式，不能直接当实时帖子提交。网页演示只需Bridge和Vite，不要求启动该第三个进程。
