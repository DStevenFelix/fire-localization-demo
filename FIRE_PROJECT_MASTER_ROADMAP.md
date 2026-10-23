> 2026-10-23 更新：当前采用 `fire_poi/` 新地图，8 只储罐，默认 `T-SW-01`，Python 使用 Anaconda `agent`。旧地图实验数字只作历史记录；详见 [地图迁移记录](MAP_MIGRATION.md)。

# 火灾应急管理仿真沙盘系统项目主线文档

本文件是以后项目开发的唯一主线文档，用于记录项目目标、系统架构、阶段成果、稳定版本、Demo 状态与后续方向。阶段推进、任务范围变更和验收结果统一更新到本文件；其他说明文件作为运行或技术细节的补充。

首次建立日期：2026-10-13。当前状态：第一次 Demo 已完成并封存，等待导师汇报与后续阶段确认。本次封存不开发新功能，不修改已有代码。

发布状态更新（2026-10-15）：第一次 Demo 已成功推送到 GitHub；当前主分支为 `main`，发布标签为 `demo-v1.0`，仓库为 Private。原封存阶段记录保留，GitHub 发布与后续待办见第 6 节。

## 1. 项目目标

构建城市火灾异常定位与可视化系统，将多源居民火情信息转化为空间定位结果，并在二维数字沙盘中展示预测位置、候选 POI 与定位误差。

核心流程：

```text
居民火情信息
    ↓
语义理解
    ↓
空间关系解析
    ↓
POI 匹配
    ↓
火点预测
    ↓
二维沙盘展示
```

前端 Agent 流程区域是对现有处理流程的展示说明。当前后端提供整轮任务状态，前端不虚构逐个 Agent 的执行状态或额外算法步骤。

## 2. 系统架构与模块边界

| 模块 | 技术职责与边界 |
| --- | --- |
| 核心定位引擎（Python / LangChain） | FireLocalizer、语义理解、空间关系解析、候选排名与模型调用；核心定位模块保持稳定，不随意改动定位算法 |
| POI 空间模型 | 提供地点、坐标与空间关系，保证定位结果与地图展示使用一致的数据依据 |
| FastAPI Bridge | 提供演示场景、独立会话、核心引擎调用及结果评估接口；API 与数据结构变更需要评审 |
| React 可视化前端 | 页面布局、二维沙盘、火点、Top3、误差与运行状态展示；可在既有 API 边界内独立优化 |

前端保持 React + Vite + TypeScript + Tailwind 技术栈。展示所需信息不足时，优先兼容现有接口；不要为展示效果直接修改定位算法、POI 空间模型或后端数据结构。真实火点标签仅用于展示与评估，不参与推理或候选排名。

项目通过 Git 与 PR 协作：从 `main` 创建工作分支，说明变更范围、模块影响和验证结果，评审后合并。涉及 API 或核心定位逻辑的变更需单独评审；保留真实代码贡献记录、Git 历史、版权声明及第三方许可证。

## 3. 已完成阶段

### Phase 0：原始代码保护

完成原始代码的 Git 基线保护，作为后续工作与变更核对的参照。

- Git 基线：`d45067dbd13a7dd3bf580ebda16cb6fd324917d3`。
- 原则：保护核心定位引擎 FireLocalizer 与定位算法，保持系统模块边界。

### Phase 1：模型服务迁移

完成智增增 API 接入。已接入模型：

- Chat：`deepseek-v4.1-flash`。
- Embedding：`qwen3-embedding-4b`。

模型服务接入成功属于此前已完成的成果。本次 Demo 封存未修改 API 配置或 `.env`，未再次调用付费模型 API。

### Phase 2：定位流程验证

已完成默认模拟场景的定位流程验证：

| 项目 | 记录 |
| --- | --- |
| 输入 | 10 条模拟火情帖子 |
| Top1 | `POI-HA-SW-02` |
| 位置名称 | 成品1号储罐 |
| 定位误差 | 0 m |

此结果用于记录已验收场景的链路表现，不代表所有场景或真实居民文本均能达到相同精度。

### Phase 3：React 可视化 MVP

已验收稳定版本：`bd9ef1b81d7448265943b31d8eec176a7e0a581f`。

实现内容：

- 数字沙盘与 POI 展示。
- 真实火点与预测火点展示。
- Top3 候选结果与地图高亮。
- 定位误差展示。
- Offline 演示、场景选择与重置。

### Phase 3.5：前端展示优化

已完成科研项目汇报展示优化，代码改动仅位于 `frontend/web/`：

- Agent 流程展示：居民火情信息、语义理解、空间定位、POI 匹配、火点预测。
- UI 优化：研究项目标题、数字孪生配色、布局与信息层级。
- 地图优化：扩大主体区域、减少边距，保持底图比例与原有 SVG 坐标映射。
- 火点优化：深色中心与白色描边的 Ground Truth、红色呼吸外环的 AI Prediction；重合时同时可辨。
- 结果卡片优化：优先展示预测位置、误差、Top3，折叠运行信息。
- 交互优化：Ready / Analyzing... / Completed 状态、卡片 hover、结果出现动画、友好错误提示与减少动画偏好适配。

验收记录：

- `npm run build`：通过。
- 现有地图坐标单元测试：31/31 通过。
- 浏览器验收：6/6 通过。
- 已验证页面加载、地图、真实点、预测点、Top3、重置、刷新、候选切换和异常展示。
- 默认真实点与预测点仍位于 SVG 约 `(678, 713)`；不同视口下底图、POI 与火点叠加保持对齐。
- 坐标校准参数、坐标转换、Bridge、接口、定位算法及 API 配置未修改。

## 4. 第一次 Demo 完成记录

### First Demo Milestone

时间：**2026-10-13**。

状态：**第一次 Demo 完成并已创建 Git 提交**。

| 版本项 | 记录 |
| --- | --- |
| Demo commit | `3360f704e246d01bb89ad651c41b67b1b393beda` |
| 提交信息 | `feat: complete first fire localization demo` |
| Demo 提交时分支 | `feat/fire-visualization`（当前主分支已为 `main`） |
| 提交文件数量 | 6 个 |
| 代码修改范围 | 仅 `frontend/web/` |
| 主线文档 | 本文件在 Demo 提交后创建并单独提交 |

后端完成情况：

- 定位流程运行成功。
- 模型接入成功。

前端完成情况：

- React 系统完成。
- 沙盘展示完成。
- 真实点 / 预测点展示完成。
- Top3 与误差展示完成。
- Agent 流程展示完成。

#### 运行方式

在两个独立 PowerShell 终端中，分别从项目根目录启动。

Bridge：

```powershell
# 在克隆后的仓库根目录执行
.\frontend\start-bridge.ps1
```

Frontend：

```powershell
# 在另一个终端进入克隆后的仓库根目录执行
.\frontend\start-web.ps1
```

访问：<http://127.0.0.1:5173>。

Bridge 健康检查：<http://127.0.0.1:8080/api/health>。

如果 PowerShell 执行策略阻止直接运行脚本，可使用现有 README 中的启动方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\frontend\start-bridge.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\frontend\start-web.ps1
```

以上两条启动命令仍需在两个独立终端中分别执行。当前机器使用 Anaconda `agent` Python 环境及系统已有 Node；使用现有启动脚本即可，无需修改配置。

#### Demo 演示流程

1. 打开页面，等待 Bridge 连接和默认场景准备完成。
2. 保持 Offline 模式；默认场景为成品1号储罐，固定种子 42，输入 10 条模拟帖子。
3. 点击“开始定位”，观察运行状态。
4. 完成后展示 Ground Truth、AI Prediction、Top3 与定位误差。
5. 点击候选列表查看地图高亮；点击“重置”返回准备状态。

Offline 使用原始规则提取和字符哈希向量，不调用外部模型 API。Live 使用已接入的真实模型，需要页面二次确认，会产生 API 费用。本次浏览器验收仅执行 Offline 和 Live 取消确认测试。

#### 封存范围

Demo 提交仅包含以下文件：

- `frontend/web/src/App.tsx`
- `frontend/web/src/components/SandboxMap.tsx`
- `frontend/web/src/index.css`
- `frontend/web/index.html`
- `frontend/web/e2e/dashboard.spec.ts`
- `frontend/web/playwright.config.ts`

未提交 `.env`、`node_modules`、`dist`、runtime 缓存、测试产物、临时文件或截图。截图保留在本地 `frontend/web/screenshots/`，仅用于验收参考。

本次封存仅进行 Git 操作和主线文档创建，未新增功能，未修改 React、Bridge、FireLocalizer、算法或 API 配置。Demo 提交封存的是此前已验收的前端展示改动。

## 5. 当前限制

当前 Demo：

- 使用模拟火情帖子。
- 重点验证系统链路与可视化展示。
- 后端算法保持稳定。
- Offline 结果用于流程演示，不等同于真实大模型效果。
- 当前结果来自已有模拟场景验证，尚不能据此推断真实城市复杂场景中的整体定位准确率。

未来方向：

- 更真实的居民文本生成。
- 更多复杂场景。

上述方向尚未进入开发，后续工作需先确认范围、模块边界和验收标准，再更新本主线文档。第一次 Demo 封存完成后停止开发，等待后续确认。

## 6. GitHub 发布记录

记录日期：**2026-10-15**。

| 项目 | 状态 |
| --- | --- |
| 远程仓库 | `DSTevenFelix/fire-localization-demo`（GitHub 仓库地址见下方） |
| 仓库地址 | https://github.com/DStevenFelix/fire-localization-demo |
| 主分支 | `main` |
| 发布标签 | `demo-v1.0` |
| 发布状态 | **第一次 Demo 已成功推送到 GitHub** |
| 仓库可见性 | **Private**（按项目负责人提供的当前状态记录） |
| Demo 功能提交 | `3360f704e246d01bb89ad651c41b67b1b393beda` |
| 已发布主线文档提交 | `7a57fb5d2dc47ad3c8ddf436bfdca7d47be8bdeb` |
| 首次发布时 main / 标签指向的提交 | `7a57fb5d2dc47ad3c8ddf436bfdca7d47be8bdeb` |

`demo-v1.0` 是附注标签：标签对象为 `977ddbfe42faed3c7d7dacf3f7d34ae7036975fc`，解引用后对应上表的已发布提交。本次通过只读查询核对了远程 `main` 与该标签，未修改标签或覆盖历史提交。后续文档完善通过新的正常提交进入 `main`，不移动既有标签。

### 已完成事项

- [x] 第一次 Demo 本地封存及主线文档建立。
- [x] Demo 推送至 GitHub，主分支为 `main`，标签 `demo-v1.0` 可由远程引用读取。
- [x] 本地完善根目录 README，增加面向新用户的介绍、架构、Windows 安装配置、启动、演示及排错说明。
- [x] 同步本文件的 GitHub 发布状态，保留阶段历史及系统模块边界。

### 待执行与待验证事项

- [ ] 审阅文档修改，并通过 Git 与 PR 完成提交、推送；本次任务未执行 Git 暂存、提交或推送。
- [ ] 邀请协作者加入 Private 仓库，验证其仓库访问权限。
- [ ] 在全新克隆环境验证 Python 3.12、uv、前端依赖及 Windows `tzdata` 安装过程。
- [ ] 按根目录 README 启动 Bridge 和 React，完成新环境下的 Offline 场景、真实点 / 预测点、Top3、误差和重置验收。
- [ ] 若需 Live，由使用者配置自己的密钥、核对服务账户与模型权限，确认费用后再单独验证。

本次工作只完善 `README.md` 和 `FIRE_PROJECT_MASTER_ROADMAP.md`。未修改业务代码、启动脚本、依赖文件、`.env`、API 配置或 POI 原始数据；未重装依赖、重新运行功能测试或开展全新克隆验收。此前机器的验收记录与新环境待验收状态分开记录。

## 7. 文档更新日志

### 2026-10-15：统一项目对外介绍

- 统一项目对外介绍，清理内部人员关系表述，使用核心定位引擎、Python 后端、POI 空间模型、FastAPI Bridge 和 React 可视化前端描述完整系统。
- 将项目架构说明统一为“系统架构与模块边界”，明确核心定位模块稳定、前端可独立优化、API 变更需评审，以及 Git 分支和 PR 协作流程。
- 保留已记录的提交、Demo 里程碑、测试结果、GitHub 发布状态及待办事项；前述首次发布记录按历史时点保留。
- 本次编辑基线为 `main` 的 `e74a5ce2e5be7e7a4425bc119a4ac64e9c6a8e69`（已推送的文档提交）。本次措辞整理仅修改项目文档，未修改业务源码、配置、测试或已有 `demo-v1.0` 标签，尚未提交或推送。
- README 的 Python / Node.js 要求、uv 安装、智增增 API 配置、Offline / Live、启动命令、Demo 流程与常见问题保持不变；保留真实代码贡献记录、版权和许可证信息。
