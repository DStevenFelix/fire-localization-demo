# 火灾应急管理仿真沙盘系统项目主线文档

本文件是以后项目开发的唯一主线文档，用于记录项目目标、分工、阶段成果、稳定版本、Demo 状态与后续方向。阶段推进、任务范围变更和验收结果统一更新到本文件；其他说明文件作为运行或技术细节的补充。

首次建立日期：2026-10-13。当前状态：第一次 Demo 已完成并封存，等待导师汇报与后续阶段确认。本次封存不开发新功能，不修改已有代码。

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

## 2. 当前项目分工

| 模块 | 负责人 | 负责范围 |
| --- | --- | --- |
| 后端 | 同门 | FireLocalizer、定位算法、POI 模型、模型调用；当前负责后端算法维护 |
| 前端 | 本人 | React 页面、二维沙盘可视化、前端交互与状态展示、Demo 展示效果 |

协作原则：未经确认，不修改对方负责模块。前端展示所需信息不足时，优先做前端兼容展示，接口或后端数据结构的变更需另行确认。

前端保持 React + Vite + TypeScript + Tailwind 技术栈。后端算法保持稳定，前端调用已有 Bridge 接口，不将真实火点标签用于推理或候选排名。

## 3. 已完成阶段

### Phase 0：原始代码保护

完成原始代码的 Git 基线保护，作为后续工作与变更核对的参照。

- Git 基线：`d45067dbd13a7dd3bf580ebda16cb6fd324917d3`。
- 原则：保护原始 FireLocalizer 与定位算法，保持模块分工边界。

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
| 分支 | `feat/fire-visualization` |
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
cd F:\LUCK_Group\fire
.\frontend\start-bridge.ps1
```

Frontend：

```powershell
cd F:\LUCK_Group\fire
.\frontend\start-web.ps1
```

访问：<http://127.0.0.1:5173>。

Bridge 健康检查：<http://127.0.0.1:8080/api/health>。

如果 PowerShell 执行策略阻止直接运行脚本，可使用现有 README 中的启动方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\frontend\start-bridge.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\frontend\start-web.ps1
```

以上两条启动命令仍需在两个独立终端中分别执行。当前机器使用项目 `.venv` Python 环境及 `frontend/.tools/` 下的便携 Node；使用现有启动脚本即可，无需修改配置。

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

上述方向尚未进入开发，后续工作需先确认范围、前后端分工和验收标准，再更新本主线文档。第一次 Demo 封存完成后停止开发，等待后续确认。
