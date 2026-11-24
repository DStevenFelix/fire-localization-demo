# Fire 项目开发者交接

## 1. 架构和真实能力

浏览器React页面经Vite代理访问FastAPI Bridge；Bridge创建隔离会话、调用原FireLocalizer并发布批次结果。无需新增Runner、Worker或业务服务。单独的fire_locator.api是可选算法HTTP入口，不是网页运行的必需进程。

原算法当前读取原始90项和扩展326项参照对象，火灾候选仍只有8个储罐。原始建筑可作为发帖地点或语义参照，不等于住宅火灾候选。扩展住宅/社区/公共设施此前仅做过前端模拟显示验证，真实扩展定位尚未完成；模拟夹具和过程产物不属于本源码交付。

city-full地图、106栋扩展建筑几何、道路、行人网络、POI与前端展示已经完成。空间数据中的消防站预留地和3个车辆资源仍为reserved；前端另有四车两机的演练仿真和真实消息接入契约，见[前端联动契约](frontend/web/DASHBOARD_INPUT_CONTRACT.md)。

## 2. 启动工程

安装步骤见根README：创建.venv、安装requirements.txt、在frontend/web运行npm ci。分别执行frontend/start-bridge.ps1和frontend/start-web.ps1，访问 http://127.0.0.1:5173；Bridge为8080。Node≥22.12、Python≥3.11。可用FIRE_PYTHON指定解释器。完整启动（含SocialNet帖子源）在仓库根目录运行 `.\start.ps1`；分别执行两个脚本时不启动帖子源，且start-bridge.ps1需要先设置FIRE_PYTHON。

启动不调用模型；Offline不使用付费API。Live只有用户明确确认后才启动。不要在接入检查时无意点击运行或执行原有100条回放测试。

## 3. 正式空间数据

- 原始fire_poi/fire_sandbox_spatial_model.json：pois、areas、roads、nodes合计90项，含29个实体POI和8个储罐，保留原别名、关系及坐标。
- city_scene/poi_catalog.json：326项扩展社区、功能区、建筑、入口、设施、道路、路口、内部节点、预留地和无人机站。
- 前端poiRegistry.ts组合两者，共416项；GET /api/spatial-data分别提供original、extended和extended_relations，而不是返回名为registry的平铺数组。
- city_scene/poi_hierarchy.json：父子关系；city_scene.json：冻结几何和机动车拓扑；pedestrian_animation.json：318节点440边及斑马线约束；fire_resources.json：消防资源预留。
- 正式Schema在city_scene/handoff_schema.json及integration/prediction.schema.json。

稳定ID不可重编号。parent_id是直接父级，community_id/region_id是社区归属；aliases用于名称索引，source保留原始/扩展来源。can_post只表示帖子位置参照资格，火灾候选资格由算法另行定义。14个社区入口引用已有建筑入口，不表示新增物理大门。

原始LOCAL30x25与现有local_cartesian_meters等价，西南原点、X向东、Y向北；CITY90x75=LOCAL+[30,25]。CITY不再次偏移，原始文件不回写。具体几何/字段语义见city_scene/README.md。

## 4. 算法接入路径

Bridge的demo来源每轮把原始空间模型、map_config、原图及6个正式city_scene文件复制到runtime/frontend/<session_id>/root；网页使用的socialnet来源直接读取仓库根目录下的正式文件。算法在settings.root下读取，不能假定当前工作目录是仓库。

修改fire_locator/poi.py读取和组合扩展数据，在算法内部统一CITY坐标，适配providers.py的名称匹配、engine.py的候选/推理与输出，必要时调整models.py和memory.py，但保持既有调用接口。不要修改frontend/bridge/server.py来绕过算法适配。

Bridge现有调用链必须保持：

1. FireLocalizer(settings, offline=..., state_path=..., resume=False)。
2. ingest(posts, flush=True)返回updates数组，每项含prediction。
3. memory.processed_count、memory.ignored_count、memory.batch_count提供累计进度。
4. prediction()返回最终Prediction；extractor.calls和embeddings.request_count供运行信息使用。

前端实际HTTP请求/响应、Post、Session和Prediction完整字段见[API契约](integration/FRONTEND_API_CONTRACT.md)。算法只需保持契约，Bridge会发布每批的prediction和batch_history：demo来源每10条一批，10批后发布completed及最终prediction；网页使用的socialnet来源每3条一批，移交应急处置后停止定位。无需新增前端通信机制。

## 5. 前端如何显示结果

services/api.ts接收Session并规范化当前/历史Prediction；utils/poiRegistry.ts按稳定ID解析名称、父级和地图坐标；candidateEvidence.ts保留历史支持强度；SandboxMap.tsx渲染候选、历史和最终Top1。完成后rank=1决定Top1，颜色不参与排序。

已注册ID优先显示主数据中心。未来扩展Prediction应统一声明CITY90x75，原始候选坐标只转换一次。rank、score、votes、confidence等必须来自算法，不得把前端模拟结果当作推理输出。

## 6. 写入边界

主要修改fire_locator及对应算法测试，完成扩展POI读取、语义匹配、候选集合、评分/推理和回归。city_scene、fire_poi、frontend、地图资源、稳定ID和Bridge协议保持不变。原项目测试可用于维护，但新增算法测试应放对应测试文件，不引入额外审计服务或Mock数据作为正式算法能力。

具体差异、输入约束和扩展区域验收要求见[integration/ALGORITHM_ADAPTATION.md](integration/ALGORITHM_ADAPTATION.md)。当前源码不依赖仓库外归档中的测试、报告或ZIP。
