# 阶段 3 实际交付记录

日期：2026-10-13（Asia/Shanghai）。状态：本地开发与 Offline 验收完成，等待用户浏览器验收；未执行 Git 提交，未调用新的付费模型。

## 实现结果

- `web/`：React + Vite + TypeScript + Tailwind CSS + Lucide。深色 Dashboard，地图为视觉中心，右侧场景与定位控制，顶部连接/模式状态，底部统计与运行记录。
- `bridge/`：只读导入原始 `PoiRepository`、`demo.generate`、`Settings` 和 `FireLocalizer`。提供健康、POI、场景、准备、启动、会话查询、重置七类接口。
- 原始数据为 52 个 POI、14 个独立储罐；全部 14 个储罐均已通过原始生成器的场景准备测试。
- 每次准备/重置使用新 UUID，数据与 Memory 位于 `runtime/frontend/<session_id>/`；Live 的独立 `Settings.root` 和向量缓存同样在该目录内。
- ground truth 与模型输入隔离：生成器元数据只用于前端展示和计算完成后的评估；推理只接收原始 `Post` 字段。
- 灰黑色真实点与红色 Top1 圆环同时可辨；Top2/Top3 为独立虚线标记。空候选不画红环；错误预测按返回坐标绘制，未移动到真实点。
- POI 显隐、悬停信息、滚轮/按钮缩放、拖动、视图重置、坐标网格和浏览器局部校准均完成。
- 控制台有真实运行状态、处理数量、Top3 排名/坐标/得分、欧氏距离误差；没有伪造百分比或硬编码预测答案。
- 重复启动、运行中重置由后端拒绝；异步响应使用前端会话版本隔离；页面刷新创建新会话，不误用旧预测。
- 网络请求有超时提示；查询失败后仅恢复状态查询，不自动重新提交定位或付费请求。
- Live 的双重确认已实现：主动选择模式、确认框勾选、服务端严格布尔确认字段；失败不会切换 Offline。

## 地图实测

- 用户 JPEG：1707×1280；原始参考 PNG：1707×1360，原件均未改动。
- 跨图网格 RGB 对比中，80 像素纵向偏移的误差最小；JPEG 比参考图上移 80 像素。
- 28 个参考图红色 POI 标记中心与 JSON/Excel 坐标核对，覆盖西侧社区、西北建筑、东北储罐、成品区、原料区、东侧建筑、消防站。
- 默认有效范围：`left=160, top=70, width=1385, height=1120`；物理范围 30×25 米，西南原点，北向在上。
- 28 个锚点最大残差约 0.028 像素；这表示与原始人工标注一致，不表示测绘精度。
- 成品1/2/3号 JPEG 位置约 (678,713)、(754,713)、(678,792)。正式火点来自后端坐标，经独立映射模块转换。
- 测量记录：`docs/map-calibration.json`、`docs/map-image-alignment.json`。

## 实际测试结果

| 检查 | 最终结果 |
| --- | --- |
| 原始 Python 测试 | 15 passed |
| 新增 Bridge 测试 | 10 passed |
| 合并 Python 验收 | 25 passed，5.26 秒 |
| TypeScript | `npm run typecheck` 通过 |
| 生产构建 | `npm run build` 通过，Vite 8.3.4 |
| 地图转换测试 | 31 passed（含 28 个实测锚点） |
| Chrome 端到端 | 6 passed，21.7 秒 |
| 浏览器 Console | 真实 Offline 流程无 pageerror / Console error |
| 显示器宽度 | 1440×1000、1920×1080、1366×900；无横向溢出 |
| 窄屏 | 390×844；无横向溢出，面板纵向堆叠 |
| 原始文件保护 | 29 个受保护文件 SHA-256 全部一致 |
| 用户底图保护 | JPEG SHA-256 与操作前一致 |
| 历史结果保护 | 已记录的 116 个历史结果文件 SHA-256 全部一致 |
| `.env` | 未读取内容、未修改、未跟踪；文件长度/修改时间与阶段开始一致 |

Bridge 测试覆盖真实 Offline 算法、标签隔离、历史缓存保护、14 个场景、重复启动、运行中重置、结果持久化、重启中断、真实空证据输入、脱敏错误、Live 门禁及模拟 Live 失败。测试同时阻断 `httpx` 与 `httpx2` 的外部网络请求。

浏览器六项覆盖真实 Offline 操作；Live 确认框取消；空候选；错误坐标；失败重置；Bridge 不可用。后四项中相关异常结果使用响应夹具验证 UI，不代表真实算法效果。真实 Offline 首轮含鼠标悬停、图层、缩放、校准开关、Top2 高亮、重置、更换场景和刷新。

开发过程中修复了测试基目录不存在、测试保护器误拦截新版本 TestClient 的 httpx2、Vitest 错误收集 Playwright 用例、源坐标舍入容差、favicon 404，以及 Windows PowerShell 5.1 对无 BOM 脚本中文路径的编码问题。浏览器启动请求有过一次未完成，最终复验通过；HTTP 超时和仅查询恢复机制已补齐。无需修改原始后端或依赖清单。

## Offline 真实演示记录

代表性实际会话：`runtime/frontend/14c9076f033744f2a0f05e4ed94b18b5/`。

- 输入：原始生成器，seed 42，10 条模拟帖子。
- 原始算法：处理 10 条、1 批；1 条因范围内无储罐而被忽略。
- Top1：`POI-HA-SW-02`，成品1号储罐。
- Top2：`POI-HA-SW-03`，成品2号储罐。
- Top3：`POI-HA-SW-04`，成品3号储罐。
- 真实火点为 `POI-HA-SW-02`；Top1/Top3 均命中；Top1 欧氏距离误差 0 米。
- 结果为原始 Offline 规则/字符哈希向量计算，不是本阶段付费大模型推理。
- 会话中已生成 `prediction.json`、`report.json`、`batch_results.json` 和 `memory.json`；没有覆盖历史文件。

## Git 与环境

- 分支：`feat/fire-visualization`。
- HEAD：`d45067dbd13a7dd3bf580ebda16cb6fd324917d3`。
- `git status --short`：仅 `?? frontend/`。
- `git diff --name-only`、`git diff --cached --name-only`：均为空。
- 所有可审查新增文件都在 `frontend/`；工具、依赖、构建、测试缓存已由 `frontend/.gitignore` 排除；新演示目录由原始 `runtime/` 规则排除。
- Node 24.21.0、npm 11.19.0 为官方校验过的局部便携版，不修改系统 PATH 或全局 npm 配置。
- 根目录 `.venv` 沿用阶段 2A 环境，本阶段未安装或改写 Python 依赖。
- 自动化启动的 Bridge、Vite 与 Chrome 均在验收结束后停止；未终止其他用户进程。

## 待用户验收 / 后续事项

1. 按 `README.md` 在两个终端启动服务，访问 http://127.0.0.1:5173，确认实际显示器上的字号、布局、地图可读性与交互。
2. 查看 `screenshots/offline-1440.png`、`screenshots/offline-1920.png`、`screenshots/initial-mobile.png`。
3. 若需要微调，使用地图「坐标校准」工具；只影响该浏览器，不改变原始数据。
4. Live 接入具备测试条件，真实付费端到端联调仍需另行授权。本阶段没有发送新付费请求。
5. 等用户确认视觉效果后再决定美化和 Git 提交；本阶段不自动提交。
