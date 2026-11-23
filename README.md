# 火灾应急管理仿真沙盘系统

基于城市空间模型、火情语义定位和动态交通仿真的火灾应急管理可视化系统。项目将二维城市地图、POI 空间数据、火情定位、消防车辆、无人机和三维火场整合到统一界面，支持火情信息分析与事件驱动的应急响应展示。

## 核心功能

- **二维城市沙盘**：构建 `CITY90x75` 城市地图，保留原始 `LOCAL30x25` 油罐沙盘的空间布局，支持地图缩放、拖动、图层切换以及道路、建筑和绿化展示。
- **POI 空间建模**：统一管理 **416 个 POI**（原始区域 90 个、扩展区域 326 个），涵盖储罐、建筑、道路、公共设施和应急资源；通过稳定 ID 和统一坐标关联定位结果与地图对象。
- **火情语义定位**：结合帖子文本、地点参照物和空间关系，对火情线索进行分批处理；展示候选火点的证据累积、Top1/Top3 排名、定位进度与位置偏差。火源定位范围限定为原始沙盘内的 **8 座储罐**。
- **城市交通仿真**：路口信号正常轮换。消防车去程可越红灯并按车道规划最短路线，回程遵守信号，进站后倒车入库。模拟应急处置期间，罐区周边道路暂停普通车驶入。
- **双无人机可视化**：展示两架无人机的停靠站点、飞行位置、航迹和任务状态，并与二维地图及三维场景共享对象位置。
- **三维火场展示**：基于 Three.js 呈现储罐、管线和周边环境，支持不同火情等级的火焰、烟雾、消防车辆与喷水效果，以及火情状态切换。
- **应急事件联动**：提供统一的事件、调度方案和状态管理接口，将火情发现、无人机侦察、方案确认、消防出动、灭火和资源返航映射到现有地图与仿真组件。

## 系统架构

```text
火情信息 / 场景输入
        │
        ▼
Python FireLocalizer ── FastAPI Bridge ── React + TypeScript
                                               │
                      ┌────────────────────────┼───────────────────────┐
                      ▼                        ▼                       ▼
                二维地图与 POI            交通与应急状态服务          Three.js 三维火场
                      │                        │                       │
                      └────────────────────────┴───────────────────────┘
                                               ▲
                                               │
                                   外部应急事件 / 调度接口
```

系统以统一 POI ID、城市仿真坐标和对象状态连接二维地图、交通执行器与三维场景。定位通过 FastAPI Bridge 提供服务；无人机任务、消防调度等外部业务能力可通过 `EmergencyAdapter` 接入事件驱动流程。

## 技术栈

| 层次       | 技术                                      |
| ---------- | ----------------------------------------- |
| 前端       | React 19、TypeScript、Vite                |
| 二维地图   | SVG、城市空间数据与 POI 注册表            |
| 三维可视化 | Three.js                                  |
| 定位服务   | Python、FireLocalizer                     |
| 服务接口   | FastAPI、HTTP JSON                        |
| 数据模型   | JSON、JSON Schema、城市道路与空间关系模型 |

## 项目结构

```text
fire/
├── fire_locator/       # 火情定位算法与数据处理
├── fire_poi/           # 原始沙盘底图与空间模型
├── city_scene/         # 扩展城市、POI、道路和应急资源数据
├── frontend/
│   ├── bridge/         # FastAPI 定位接口
│   ├── web/            # React 前端、交通仿真与三维火场
│   ├── start-bridge.ps1
│   └── start-web.ps1
├── socialnet/          # 居民发帖、火情初筛及独立社交网络应用
├── device_access/      # 设备接入协议与 TCP 客户端示例
├── integration/        # 接口与数据契约
├── data/               # 项目输入数据
├── tests/              # Python 测试
├── start.ps1           # Windows 一键启动
└── README.md
```

## 快速开始

### 准备环境

以下命令适用于 Windows PowerShell，从仓库根目录执行。后端要求 Python 3.11 或以上，本机使用 Python 3.12。前端使用 Node.js 24 来加载 TypeScript 版 Vite 配置。

首次克隆且尚无 Python 环境时，安装两个后端的依赖。已有可用环境时可跳过。使用 Conda 等其他环境时，将下文的 Python 路径改为对应的解释器。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -r socialnet/requirements.txt
```

如果 Node 和 npm 已在 PATH 上，首次安装前端依赖时运行 `npm.cmd --prefix frontend/web ci`。尚未安装 Node 时，可从根目录运行 `& .\frontend\setup-node.ps1`，下载仓库使用的免安装 Node 并安装前端依赖。

### 启动主项目

在仓库根目录运行一个命令。

```powershell
.\start.ps1
```

脚本会依次启动 SocialNet 帖子源（8000）、定位 Bridge（8080）和主项目的火灾定位前端（5173）。Bridge 从 SocialNet 后端读取帖子，网页由 `frontend/web` 提供。终端显示启动成功后，打开 <http://127.0.0.1:5173/>。

脚本默认使用仓库的 `.venv`。如使用其他 Python 环境，先在当前终端设置 `$env:FIRE_PYTHON` 为对应 `python.exe` 的完整路径。前端优先使用 `frontend/setup-node.ps1` 安装的免安装 Node，其次使用 PATH 上的 Node。

保持启动窗口打开，在同一窗口按 `Ctrl+C` 停止项目。端口被占用时，用 `Get-NetTCPConnection -State Listen -LocalPort 5173,8080,8000` 查看占用进程。

如需单独检查各服务，在另一个 PowerShell 窗口执行以下命令，三个请求均应返回 `status: ok`。

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/post-source/health
Invoke-RestMethod http://127.0.0.1:8080/api/health
Invoke-RestMethod http://127.0.0.1:5173/api/health
```

### 配置模型并开始仿真

服务健康检查和主页加载无需模型密钥。点击「开始仿真」前，将 `socialnet/.env.example` 复制为 `socialnet/.env`，填入 `OPENAI_API_KEY` 或 `DASHSCOPE_API_KEY` 及对应的模型配置，随后重启帖子源。Offline 模式的定位在本地运行，居民发帖仍会调用配置的模型。Live 定位还需根据根目录的 `.env.example` 配置项目根目录的 `.env`。

如旧 Windows 工作副本报「整城场景校验失败」或「扩展 POI 校验失败」，可在仓库根目录执行以下修复。命令只在转换为 LF 后的 SHA-256 与清单一致时写回对应文件。

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

1. 在二维地图中浏览城市道路、建筑、储罐和应急资源，使用图层控制和缩放功能查看不同区域。
2. 在仿真设置中选择储罐，点击「开始仿真」。SocialNet 按指定储罐生成帖子并做规则初筛，主项目收到每 3 条火情帖后更新一次定位。舆情面板每秒切换一条，有新帖时优先展示，空档循环近期帖子。
3. 查看地图、定位结果和对应储罐的三维场景。
4. 通过系统的应急事件接口接收无人机、消防车辆和火情状态，展示任务执行、交通优先通行及火场变化。

Offline 定位使用本地规则和向量，Live 定位调用 Chat 和 Embedding。两种模式下，SocialNet 居民发帖均使用已配置的模型，开始前需要确认 API 费用。

第一次出现定位候选后即可点击「移交应急处置」。定位结果立即冻结，面板继续滚动新帖。无人机依次巡查移交时的候选，最后飞往主项目选定的真实火点。通过「确认设置」应用火情等级，系统分配 1、2 或 3 辆消防车。点击「确认已灭火」后，发帖和滚动停止，无人机和消防车返站。

「全局暂停」会暂停沙盘、SocialNet 发帖和帖子滚动，并暂停启动新的定位批次。点击「继续仿真」会从当前会话继续。点击「全局重置」会停止 SocialNet，清空滚动、定位和处置状态，并清理 `runtime/frontend` 中的旧演示会话和帖子缓存。主项目将流式原帖和每帖文本向量保留在内存中，共享的地图 POI 向量缓存继续复用。之后可以更换储罐并开始下一轮。

SocialNet 把每轮生成的群聊原帖存到 `socialnet/runtime/post_runs` 下的 `UTC 启动时间_会话ID` 目录。达到 30 轮或 128 MiB 时按时间轮换，单轮持续过久时轮换该轮最早的帖子分卷。全局重置保留 SocialNet 的归档。历史群聊和报告仍保存在旧 SQLite 存档，当前发帖服务仅运行发帖与规则初筛。

模拟事件源位于 `frontend/web/src/utils/emergencyDemo.ts`。接入真实系统时，在前端设置 `VITE_EMERGENCY_DEMO=false` 并重启 Vite，然后通过 `connectEmergencyAdapter` 注册外部 `EmergencyAdapter`。演示适配器由页面作为默认源，已注册的外部适配器优先。

## 空间约定

- 城市仿真范围：`CITY90x75`，西南角为原点，X 轴向东、Y 轴向北。
- 原始沙盘范围：`LOCAL30x25`，在城市坐标中的偏移为 `(30, 25)`。
- 火情目标使用稳定储罐 POI ID；二维地图与三维场景共享空间映射。

---

本项目围绕火情定位、城市交通仿真与应急响应可视化构建，便于开展城市空间感知和火灾应急管理相关研究与系统集成。
