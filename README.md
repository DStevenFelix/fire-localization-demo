# 火灾应急管理仿真沙盘系统

基于城市空间模型、火情语义定位和动态交通仿真的火灾应急管理可视化系统。项目把二维城市地图、POI 空间数据、社交网络舆情、火情定位、无人机侦查、消防车调度和三维火场整合到一个工作台，展示从发现火情线索到灭火归队的完整处置流程。

系统运行在 5 m × 4 m 的实体沙盘对应的数字孪生地图上：二维地图、三维火场、设备媒体窗口和三个智能体共用同一套设备状态和坐标。演练模式用模拟设备跑通全流程；真实联动模式只显示现场设备、调度和媒体网关实际发来的消息。**四车两机、调度系统和媒体网关等真实硬件尚未接入，现场联调尚未完成。**

## 功能概览

- **二维城市沙盘**：`CITY90x75` 城市地图，保留原始 `LOCAL30x25` 油罐沙盘的底图和空间布局；支持缩放、拖动、全图与原图视图、图层切换，以及道路、建筑、绿化、POI 和应急资源的展示。
- **POI 空间建模**：统一管理 **416 个 POI**（原始区域 90 个、扩展区域 326 个），涵盖储罐、建筑、道路、公共设施和应急资源；通过稳定 ID 和统一坐标关联定位结果与地图对象。
- **火情语义定位**：结合帖子文本、地点参照物和空间关系，对火情线索分批处理；展示候选火点的证据累积、Top1/Top2/Top3 排名、批次历史和定位偏差。火源定位范围限定为原始沙盘内的 **8 座储罐**。
- **城市交通仿真**：普通车辆沿城市路线按信号灯行驶。处置期间罐区道路疏散，外部普通车辆不再驶入罐区，信号灯照常轮换；出警消防车可越过红灯，返程时观察信号，进站后倒车入库。
- **实时信号灯**：真实联动模式下，Bridge 接收信号控制机的灯态并以 SSE 推送，前端按路口显示红、绿、黄、灭灯和闪烁状态、倒计时，以及设备在线或离线；演练模式使用前端仿真信号。
- **四辆消防车、两架无人机**：`EXT-FIRE-VEHICLE-01`～`04` 和 `DRONE-01`、`DRONE-02`。未收到定位时显示虚拟待命标记，首条有效定位到达后接管位置和航向；10 秒无新采样时标记定位过期并保留最后位置。
- **三维火场**：基于 Three.js 呈现目标储罐所在罐区的储罐、管线和周边环境，支持正常、燃烧、灭火中和已扑灭四种状态，小、中、大三档火情，以及消防车喷水效果。
- **三个 Agent 与统一调度记录**：舆情监测、火情定位、调度三个 Agent 各有独立面板；「智能体调度记录」按事件时间汇总三个 Agent 和设备的消息，去重后统一展示。
- **Top3 候选侦查、火点确认与监控**：两架无人机按排名逐点侦查 Top3 候选，回传每处结果；有效反馈确认火点后，无人机转入火场监控。
- **去程路线、实时遥测、喷水与结果反馈**：地图显示有效去程规划，实际位置由遥测更新，轨迹保存在设备状态中；消防车抵达和开始作业是两次独立反馈，灭火完成、失败或中断分别由消息确认。
- **七路视频和一路图片**：无人机 3 路视频加 1 路图片，消防车 4 路视频；每路独立绑定设备，显示等待、连接中、播放、断流、重连和错误状态，没有来源时不播放模拟画面。

## 系统架构

```text
SocialNet 帖子源 (8000) ──► FastAPI Bridge (8080) ◄── FireLocalizer 火情定位算法
                                    │
        信号控制机 ──TCP 灯态──►     │ /api（经 Vite 代理）
   (192.168.1.111～116)            │ /api/traffic-signals/stream（SSE）
                                    ▼
                      沙盘前端 React + TypeScript (5173)
        ┌──────────────────┬──────────────────┬────────────────┐
        │ 左栏             │ 中栏             │ 右栏           │
        │ 无人机视角 3+1路 │ 二维城市沙盘地图 │ 舆情监测 Agent │
        │ 无人车视角 4路   │                  │ 火情定位 Agent │
        │ 三维火场         │                  │ 调度 Agent     │
        │                  │                  │ 智能体调度记录 │
        └──────────────────┴──────────────────┴────────────────┘
                                    ▲
                 真实定位设备 / 调度系统 / 媒体网关
                 经 connectDashboardSource() 适配接入（待现场注册）
```

| 模块 | 目录 | 职责 |
| --- | --- | --- |
| 火情定位算法 | `fire_locator/` | 从帖子中提取参照物与方位，累积证据并输出储罐候选排名。Offline 使用本地规则和向量，Live 调用 Chat 与 Embedding 模型 |
| 定位 Bridge | `frontend/bridge/` | FastAPI 服务：创建、运行和查询定位会话；从 SocialNet 拉取火情帖并分批交给 FireLocalizer；接收信号控制机灯态并以 SSE 发布 |
| 社交网络 | `socialnet/` | 居民仿真、模型发帖和规则初筛。主项目启动其中的无界面帖子源 `socialnet.app.post_source`；该模块也可作为独立应用运行 |
| 沙盘前端 | `frontend/web/` | React 工作台：二维地图、交通仿真、设备与媒体状态、三个 Agent、三维火场，以及真实消息的适配与校验入口 |
| 空间数据 | `fire_poi/`、`city_scene/` | 原始沙盘空间模型与底图；扩展城市的 POI、道路、行人网络和应急资源 |
| 设备接入 | `device_access/` | 沙盘集成平台 TCP 二进制定位协议说明和客户端示例 |
| 接口契约 | `integration/` | Bridge 与算法的 API 契约、算法接入说明、Prediction JSON Schema |
| 测试 | `tests/`、`frontend/bridge/tests/`、`frontend/web/src/**/*.test.ts`、`frontend/web/e2e/` | Python 测试、前端单元测试和浏览器验收 |

系统以统一 POI ID、城市仿真坐标和设备状态连接二维地图、交通执行器、三维火场与媒体窗口。交通与演练调度运行在浏览器内；定位通过 Bridge 提供服务。

## 业务流程

```text
地图起火 → SocialNet 舆情监测 → 火情定位 Top3 → 调度 Agent 收到候选
        → 两架无人机逐点侦查 Top3 → 回传结果并确认火点 → 无人机监控火点
        → 派遣消防车 → 去程路线与实时位置 → 抵达后喷水灭火
        → 灭火完成反馈 → 无人机与消防车返航归位 → 恢复待命
```

- 三个候选都没有命中时，调度保持「火点尚未确认」，等待补充侦查。
- 出动几辆消防车由调度结果决定。本地演练中它是可调的派车参数，不代表真实火情需要全部出动。
- **信息边界**：场景的真实火点（Ground Truth）只用于地图展示和定位评估，不进入帖子、候选、侦查反馈、任务或设备消息。舆情、定位和调度只能看到各自有权获得的数据。
- 定位得分、票数和地图颜色表示证据强度，不是校准后的火灾概率。

## 三种工作台模式

顶部「数据来源」切换工作台。切换时会关闭上一模式的连接、计时、媒体渲染和消息订阅。定位模型的 Offline/Live 设置独立于设备数据来源。

| 模式 | 依赖 | 帖子与定位 | 设备与调度 |
| --- | --- | --- | --- |
| **真实联动**（默认） | Bridge（定位会话、信号灯 SSE）；开始仿真还需要 SocialNet 帖子源 | SocialNet 真实帖子和 FireLocalizer 真实批次 | 只显示 `connectPhysicalDashboardSource()` 注册的真实消息；当前没有注册任何设备或调度源 |
| **本地应急演练** | 无，不需要 Bridge 和模型密钥 | 前端内置两批共 8 条演练线索 | 前端模拟四车两机的完整流程 |
| **SocialNet 联动演练** | SocialNet 帖子源、Bridge 和模型密钥 | 真实帖子和真实定位批次 | 候选交给前端 `EmergencyDemo` 模拟侦查、调度和灭火 |

- **本地应急演练**不需要后端。开始前可选择模拟派车 1～4 辆，默认 4 辆。演练火点为 `T-NW-01`；两批线索（5 条加 3 条）给出候选 `T-NW-02`、`T-NW-01`、`T-NE-01`，Top2 命中火点。两架无人机完成三处侦查后确认火点并转入监控，消防车沿路网抵达、喷水约 8 秒后自动确认灭火，随后返航、返位。
- **SocialNet 联动演练**使用真实数据链路。首次出现定位候选后可点击「移交应急处置」：定位分析立即冻结，帖子继续滚动。无人机按移交时的候选排名逐点侦查，由模拟现场观测确认与场景火点一致的候选，再派出 1、2 或 3 辆消防车。点击「确认已灭火」后发帖停止，设备返航。
- 也可以用地址参数直接打开某个模式：`http://127.0.0.1:5173/?workspace=mock`（本地应急演练）、`?workspace=bridge-demo`（SocialNet 联动演练）。

## 真实设备接入与当前边界

真实联动的接入入口只有一处：`frontend/web/src/config/dashboardSource.ts` 的 `connectPhysicalDashboardSource()`。接入方在其中调用 `connectDashboardSource(subscribe, adapt, options)`，由 `subscribe` 订阅现场传输，由 `adapt` 把原始报文映射为前端消息。映射后的消息经过格式、设备编号、时间戳和坐标标定校验，再更新地图、调度 Agent、媒体窗口和调度记录。可以只接入其中任何一类消息。

- **接入契约**：消息信封、事件类型、Payload、设备编号、物理坐标标定、媒体槽位和待提供的数据清单，见 [frontend/web/DASHBOARD_INPUT_CONTRACT.md](frontend/web/DASHBOARD_INPUT_CONTRACT.md)。
- **接入示例**：`frontend/web/src/services/dashboardSourceExample.ts` 是内存适配器，可在浏览器控制台逐条发布消息，验证原始报文到界面的完整路径。
- **定位设备协议**：[device_access/协议文档.html](device_access/协议文档.html) 描述沙盘集成平台的 TCP 二进制帧 v1.0（轮式车、无人机、光谱无人机等，坐标单位为米，航向单位为度）。前端和 Bridge 目前没有内置该协议的接收端，需要由适配器接收并按标定参数转换。
- **信号灯**：Bridge 内置 TCP 接收端，默认监听 `192.168.1.190:5000`，接受 `192.168.1.111`～`116` 六台控制机的连接，环境变量 `FIRE_SIGNAL_HOST`、`FIRE_SIGNAL_PORT` 可修改地址，`FIRE_SIGNAL_HOST=off` 关闭接收端。灯态通过 `GET /api/traffic-signals/stream` 推送；SSE 断开或 10 秒没有有效快照时，界面保留最后灯色并标明离线。

**当前边界：**

- 四车两机的真实定位、调度系统和媒体网关尚未接入，也没有完成现场联调。
- 现场信号控制机没有参与本地验收；本地验证使用仿真信号和测试快照。
- 仍需各负责人提供真实设备编号对照、坐标原点与标定控制点、任务和侦查报文、媒体地址与鉴权方式、信号机部署信息。完整清单见接入契约的「待提供的数据」。

## 项目结构

```text
fire/
├── fire_locator/            # 火情定位算法（LangChain）
├── fire_poi/                # 原始沙盘空间模型与底图
├── city_scene/              # 扩展城市、POI、道路、行人网络和应急资源
├── frontend/
│   ├── bridge/              # FastAPI 定位 Bridge 与信号灯接收端
│   ├── web/                 # React 前端
│   │   ├── src/             # 组件、服务、工具与配置
│   │   ├── e2e/             # Playwright 浏览器验收
│   │   └── DASHBOARD_INPUT_CONTRACT.md
│   ├── scripts/             # 受保护源码与底图校验脚本
│   ├── setup-node.ps1       # 下载免安装 Node 并安装前端依赖
│   ├── start-bridge.ps1     # 单独启动 Bridge
│   ├── start-web.ps1        # 单独启动前端
│   └── verify.ps1           # Python 测试、保护校验与前端全套检查
├── socialnet/               # 居民仿真、发帖、规则初筛与独立社交网络应用
├── device_access/           # 设备接入协议说明与 TCP 客户端示例
├── integration/             # 接口与数据契约
├── data/                    # 演示帖子输入数据
├── tests/                   # Python 测试
├── requirements.txt         # 主项目 Python 依赖
├── start.ps1                # Windows 一键启动
└── README.md
```

## 技术栈

| 层次 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite 8、Tailwind CSS 4、lucide-react |
| 二维地图 | SVG、城市空间数据与 POI 注册表 |
| 三维可视化 | Three.js |
| 前端测试 | Vitest、Playwright |
| 定位 Bridge | Python 3.11 及以上、FastAPI、Uvicorn、httpx |
| 火情定位 | Python、LangChain（Chat 与 Embeddings） |
| 社交网络 | Python、FastAPI、LangChain |
| 服务接口 | HTTP JSON、SSE |
| 数据模型 | JSON、JSON Schema、城市道路与空间关系模型 |

前端要求 Node.js 22.12 及以上，仓库脚本使用 Node 24。

## 快速开始

以下命令适用于 Windows PowerShell，从仓库根目录执行。

### 准备环境

后端要求 Python 3.11 或以上，本机使用 Python 3.12。首次克隆且尚无 Python 环境时，安装两个后端的依赖；已有可用环境时可跳过。使用 Conda 等其他环境时，把下文的 Python 路径换成对应的解释器。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -r socialnet/requirements.txt
```

Node.js 和 npm 不一定在系统 PATH 中。仓库提供了免安装的 Node 24.21.0，位于 `frontend/.tools/node-v24.21.0-win-x64`。每个新终端先把它加入当前终端的 PATH：

```powershell
$env:Path = (Join-Path (Get-Location) 'frontend/.tools/node-v24.21.0-win-x64') + ';' + $env:Path
node --version    # 应输出 v24.21.0；报错说明尚未安装，先执行下一步
```

尚未安装免安装 Node 时，从仓库根目录执行一次。脚本从 nodejs.org 下载 Node 24.21.0，核对官方 SHA-256，解压到 `frontend/.tools`，然后安装前端依赖。脚本设置的 PATH 只在脚本自己的进程内有效，结束后需要重新执行上面的 PATH 命令。

```powershell
& .\frontend\setup-node.ps1
```

单独安装或重新安装前端依赖：

```powershell
npm.cmd --prefix frontend/web ci
```

### 启动主项目

在仓库根目录运行一个命令：

```powershell
.\start.ps1
```

脚本按以下顺序检查并启动：

1. Python：优先使用环境变量 `FIRE_PYTHON` 指定的 `python.exe`，否则使用仓库的 `.venv`。
2. Node：优先使用 `frontend/.tools` 中的免安装 Node，其次使用 PATH 上的 `node.exe`。
3. 前端依赖：`frontend/web/node_modules` 缺失时提示先执行 `npm.cmd --prefix frontend/web ci`。
4. 端口 8000、8080、5173 被占用时直接报错退出，不会复用已有服务。
5. 依次启动 SocialNet 帖子源（8000）、定位 Bridge（8080）和火灾定位前端（5173），并检查帖子源和 Bridge 的健康状态。

终端显示 `Open http://127.0.0.1:5173/` 后，打开 <http://127.0.0.1:5173/>。保持启动窗口打开，在同一窗口按 `Ctrl+C` 停止全部服务。

使用其他 Python 环境时，在运行前把 `FIRE_PYTHON` 设为对应 `python.exe` 的完整路径：

```powershell
$env:FIRE_PYTHON = 'D:\Anaconda\envs\agent\python.exe'
.\start.ps1
```

端口被占用时，用下面的命令查看占用进程：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 5173,8080,8000
```

### 健康检查

服务启动后，在另一个 PowerShell 窗口执行以下命令，三个请求都应返回 `status: ok`。第三个请求经 Vite 代理访问 Bridge。

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/post-source/health
Invoke-RestMethod http://127.0.0.1:8080/api/health
Invoke-RestMethod http://127.0.0.1:5173/api/health
```

### 单独启动（开发调试）

```powershell
# 两个终端都先执行
$env:Path = (Join-Path (Get-Location) 'frontend/.tools/node-v24.21.0-win-x64') + ';' + $env:Path
$env:FIRE_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path

# 终端 1：Bridge（8080）
& .\frontend\start-bridge.ps1

# 终端 2：前端（5173）
& .\frontend\start-web.ps1
```

`start-bridge.ps1` 在没有设置 `FIRE_PYTHON` 时默认使用固定的解释器路径 `D:/Anaconda/envs/agent/python.exe`，换机器必须先设置 `FIRE_PYTHON`。这两个脚本不启动 SocialNet 帖子源：页面、健康检查和本地应急演练可用，「开始仿真」需要帖子源，完整功能请使用 `.\start.ps1`。

### 配置模型并开始仿真

服务健康检查和主页加载不需要模型密钥。点击「开始仿真」前，把 `socialnet/.env.example` 复制为 `socialnet/.env`，填入 `OPENAI_API_KEY` 或 `DASHSCOPE_API_KEY` 及对应的模型配置，然后重启帖子源。Offline 模式的定位在本地运行，居民发帖仍会调用配置的模型；Live 定位还需参照根目录的 `.env.example` 配置根目录的 `.env`。

点击「开始仿真」后会弹出付费确认对话框，勾选确认后才启动。模型调用失败时会显示错误，不会自动切换到离线模式。

### SocialNet JSON 换行符校验

SocialNet 按字节核对 `socialnet/city_scene` 下的整城场景和扩展 POI 文件。旧 Windows 工作副本如果报「整城场景校验失败」或「扩展 POI 校验失败」，可在仓库根目录执行下面的命令。命令只在转换为 LF 后的 SHA-256 与清单一致时才写回对应文件。

```powershell
@'
import hashlib, json
from pathlib import Path

root = Path('socialnet/city_scene')
expected = json.loads((root / 'import-manifest.json').read_bytes())['files']
for name in ('city_scene.json', 'poi_catalog.json'):
    path = root / name
    original = path.read_bytes()
    normalized = original.replace(b'\r\n', b'\n')
    if hashlib.sha256(normalized).hexdigest() != expected[name]:
        raise SystemExit(f'SHA-256 mismatch after LF conversion: {path}')
    if normalized != original:
        path.write_bytes(normalized)
    print(f'{path}: SHA-256 OK')
'@ | .\.venv\Scripts\python.exe -
```

`device_access/` 下的 TCP 客户端示例用于单独进行设备联调。

## 使用方式

1. 在二维地图中浏览城市道路、建筑、储罐和应急资源。地图工具栏提供图层、缩放、全图、原图、查看消防站、查看无人机站、全局暂停和仿真倍速。
2. 点击「仿真设置」选择储罐和 Offline 或 Live 模式，再点击「开始仿真」。SocialNet 按指定储罐生成帖子并做规则初筛，主项目每收到 3 条火情帖更新一次定位。舆情面板每秒切换一条，有新帖时优先展示，空档时循环近期帖子。
3. 查看地图上的候选与最终 Top1、定位面板的批次历史，以及对应储罐的三维场景。点击候选行可在地图上高亮该候选。
4. 切换到「本地应急演练」可直接演示完整处置流程；切换到「SocialNet 联动演练」并在出现候选后点击「移交应急处置」，可以用真实定位结果演示处置流程。
5. 「全局暂停」会暂停沙盘、SocialNet 发帖和帖子滚动，并暂停启动新的定位批次；「继续仿真」从当前会话继续。「全局重置」停止 SocialNet，清空滚动、定位和处置状态，清理 `runtime/frontend` 中的旧演示会话和帖子缓存，之后可以更换储罐开始下一轮。

SocialNet 把每轮生成的群聊原帖存到 `socialnet/runtime/post_runs` 下以 UTC 启动时间和会话 ID 命名的目录。达到 30 轮或 128 MiB 时按时间轮换；全局重置保留 SocialNet 的归档。当前发帖服务只运行发帖与规则初筛。

## 自动化测试

前端检查在 `frontend/web` 下执行。先在每个新终端设置 PATH 和 Python 解释器：

```powershell
$env:Path = (Join-Path (Get-Location) 'frontend/.tools/node-v24.21.0-win-x64') + ';' + $env:Path
$env:FIRE_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path
Push-Location frontend/web

npm.cmd run typecheck     # TypeScript 类型检查
npm.cmd run build         # 类型检查加 Vite 生产构建
npm.cmd test              # Vitest 单元测试
npm.cmd run test:e2e      # Playwright 浏览器验收

Pop-Location
```

Python 测试：

```powershell
.\.venv\Scripts\python.exe -m pytest tests frontend/bridge/tests -q
```

也可以运行 `& .\frontend\verify.ps1` 一次执行 Python 测试、底图与受保护源码校验、类型检查、构建和单元测试；加上 `-Browser` 时再运行浏览器验收。

运行浏览器验收前注意：

- Playwright 自己启动隔离的 Bridge 和 Vite，默认使用 5173 和 8080 端口，先用 `Ctrl+C` 停止正在运行的服务。端口可用 `FIRE_E2E_VITE_PORT` 和 `FIRE_E2E_BRIDGE_PORT` 调整。
- Bridge 进程由 `FIRE_PYTHON` 指定的解释器启动；不设置时 Windows 下使用 PATH 上的 `python`。
- 浏览器通道默认为 Microsoft Edge，可用 `PLAYWRIGHT_CHANNEL` 指定其他已安装的通道。
- 验收期间 Bridge 不连接信号控制机。截图和报告写入 `frontend/web/screenshots`、`test-results` 和 `playwright-report`，这些目录已被 Git 忽略；设置 `FIRE_ACCEPTANCE_DIR` 可改为写入指定目录。
- 设置 `FIRE_E2E_MOCK_ONLY=1` 时不启动 Bridge，只适用于用模拟接口的用例。

最近一次完整验收（2026-11-24，Windows、Node 24、Python 3.12、Microsoft Edge）：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm test` | 13 个文件，**204/204 通过** |
| `npm run test:e2e` | **30/30 通过**，用时约 6.1 分钟 |

浏览器验收覆盖三种工作台模式、单屏三栏布局、四车两机的演练全流程、物理坐标标定、候选侦查与火点确认、媒体窗口状态、信号灯同步和 SocialNet 流式定位。演练和验收使用模拟设备与模拟调度消息，不代表真实硬件或调度系统已经联通。

## 空间约定

- **城市仿真范围**：`CITY90x75`，西南角为原点，X 轴向东、Y 轴向北。整城画布为 3939×3150 像素。
- **原始沙盘范围**：`LOCAL30x25`，在城市坐标中的偏移为 `(30, 25)`，即 `CITY = LOCAL + (30, 25)`。原始底图为 1313×1050 像素，原图和原始 POI 不回写。
- **单位**：仿真坐标的单位是仿真单位（`simulation_unit`），不是米。实体沙盘为东西 5 m、南北 4 m；物理米和仿真单位通过标定参数转换，默认轴对齐标定 `PHYSICAL_SW_METERS/axis-aligned-v1` 把沙盘 `(0,0)`、`(2.5,2)`、`(5,4)` 米映射到 CITY 的 `(30,25)`、`(45,37.5)`、`(60,50)`。现场坐标必须先确认原点、轴向和单位再套用。
- **航向**：从东向起算、逆时针为正的弧度。
- **火情目标**：使用稳定储罐 POI ID，二维地图与三维场景共享空间映射。当前共 8 座储罐：

| POI ID | 储罐 | CITY 中心 |
| --- | --- | --- |
| `T-NW-01` | 西北罐区 1 号 | (39.626524, 40.419447) |
| `T-NW-02` | 西北罐区 2 号 | (42.393293, 40.419447) |
| `T-NE-01` | 东北罐区 1 号 | (47.583841, 40.419447) |
| `T-NE-02` | 东北罐区 2 号 | (50.350610, 40.419447) |
| `T-SW-01` | 西南罐区 1 号 | (39.717988, 33.984747) |
| `T-SW-02` | 西南罐区 2 号 | (42.393293, 34.008580) |
| `T-SE-01` | 东南罐区 1 号 | (47.446646, 33.960915) |
| `T-SE-02` | 东南罐区 2 号 | (50.167683, 33.960915) |

- **站点与资源**：消防无人机站 `EXT-P-DRONE` 位于 CITY `(28.6, 24)`，两个泊位对应 `DRONE-01`、`DRONE-02`；消防站预留地 `EXT-P-FIRE` 位于 `(20, 16)`，经 `EXT-R-009` 接入道路。正式空间数据中的消防资源仍是 3 个预留车位；四辆车在真实联动中的虚拟待命点和演练中的四个仿真泊位由前端配置 `frontend/web/src/config/emergency.json` 管理，不代表已标定的硬件停放位置。

## 开发约定

- 不修改原始底图 `fire_poi/map_original.png`、原始 POI、道路和稳定 ID 编号，不增加储罐，不重画正式地图。
- 前端接入真实数据只通过适配层映射和校验，不直接订阅尚未确认的后端地址，不把模拟数据当作真实定位或真实任务结果。
- 设备位置、任务结果和灭火结论只由实际收到的消息决定，不根据动画进度或页面计时推断。
- 城市交通、应急状态机和信号控制复用现有实现，不为每个数据源另建一套平行逻辑。
- 调整后端接口或数据结构前先更新对应契约文档，并通知各模块负责人。
- 仓库只包含正式源码、数据、配置、接口文档和测试，不包含开发期的审计、验收过程产物，也不提交 `.env`、本机工具缓存和运行目录。

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [frontend/web/DASHBOARD_INPUT_CONTRACT.md](frontend/web/DASHBOARD_INPUT_CONTRACT.md) | 前端联动契约：真实设备、调度、侦查、媒体和信号灯消息的接入方式、字段定义与待提供清单 |
| [integration/FRONTEND_API_CONTRACT.md](integration/FRONTEND_API_CONTRACT.md) | Bridge 与算法的 API 契约：端点、Session、Post、Prediction 和信号灯 SSE |
| [HANDOFF_README.md](HANDOFF_README.md) | 定位与算法开发交接：架构、空间数据、Bridge 调用链和写入边界 |
| [integration/ALGORITHM_ADAPTATION.md](integration/ALGORITHM_ADAPTATION.md) | 扩展城市定位算法的接入与验收要求 |
| [frontend/README.md](frontend/README.md) | 前端与 Bridge 的开发说明 |
| [city_scene/README.md](city_scene/README.md)、[fire_poi/README.md](fire_poi/README.md) | 正式空间数据说明 |
| [socialnet/README.md](socialnet/README.md) | 社交网络系统的使用与配置 |
| [device_access/协议文档.html](device_access/协议文档.html) | 沙盘集成平台定位协议 |

---

本项目围绕火情定位、城市交通仿真与应急响应可视化构建，用于城市空间感知和火灾应急管理相关研究与系统集成。
