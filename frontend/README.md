# Fire 前端与Bridge

安装、启动、健康检查及模型配置见[根 README 的快速开始](../README.md#快速开始)，算法接入见 [HANDOFF_README](../HANDOFF_README.md)。

## 目录职责

- `frontend/bridge/server.py` 是定位 Bridge：创建、运行和查询定位会话，从 SocialNet 帖子源拉取火情帖并分批交给 FireLocalizer，同时提供信号灯 SSE。
- `frontend/web/` 是 React 工作台，包含二维城市地图、交通仿真、四车两机设备状态、三个 Agent、媒体窗口和 Three.js 三维火场。
- `frontend/web/src/services/dashboardInput.ts` 是设备、调度、侦查和媒体消息的统一入口，`frontend/web/src/config/dashboardSource.ts` 是真实数据源的注册位置。

在仓库根目录运行 `.\start.ps1`，会启动 SocialNet 帖子源（8000）、定位 Bridge（8080）和主项目的 Vite 前端（5173）。Vite 把 `/api` 转发到 Bridge。

## 工作台模式

| 模式 | 说明 |
| --- | --- |
| 真实联动 | 监听 `connectPhysicalDashboardSource()` 注册的真实设备和调度消息，红绿灯读取 Bridge 的 SSE。当前没有注册任何设备或调度源 |
| 本地应急演练 | 不需要 Bridge，用前端内置的模拟帖子、模拟设备和模拟调度演示完整处置流程 |
| SocialNet 联动演练 | 通过 Bridge 消费 SocialNet 帖子和 FireLocalizer 的真实批次，可把定位候选交给前端 `EmergencyDemo` 模拟侦查、调度和灭火 |

前端合并原始 90 项与扩展 326 项 POI，共 416 项。真实定位算法目前只输出原始 8 个储罐候选。设备、调度、侦查、媒体和信号灯消息的字段与接入方式见[前端联动契约](web/DASHBOARD_INPUT_CONTRACT.md)，Bridge 端点见[integration/FRONTEND_API_CONTRACT.md](../integration/FRONTEND_API_CONTRACT.md)。

## 免安装 Node

前端要求 Node.js 22.12 及以上。`setup-node.ps1` 把 Node 24.21.0 免安装包下载到 `frontend/.tools`，核对官方 SHA-256 后解压，并在 `frontend/web` 执行 `npm ci`：

```powershell
# 在仓库根目录执行一次
& .\frontend\setup-node.ps1
```

脚本设置的 PATH 只在脚本自己的进程内有效。之后每个要使用 `node` 或 `npm` 的终端，先执行：

```powershell
$env:Path = (Join-Path (Get-Location) 'frontend/.tools/node-v24.21.0-win-x64') + ';' + $env:Path
```

Node 和 npm 已在系统 PATH 上时可以跳过以上两步，直接运行 `npm.cmd --prefix frontend/web ci` 安装依赖。

## 单独启动与检查

```powershell
$env:Path = (Join-Path (Get-Location) 'frontend/.tools/node-v24.21.0-win-x64') + ';' + $env:Path
$env:FIRE_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path

& .\frontend\start-bridge.ps1   # 终端 1
& .\frontend\start-web.ps1      # 终端 2
& .\frontend\verify.ps1         # Python 测试、保护校验、类型检查、构建和单元测试；加 -Browser 运行浏览器验收
```

`start-bridge.ps1` 在没有设置 `FIRE_PYTHON` 时默认使用固定的解释器路径 `D:/Anaconda/envs/agent/python.exe`。这两个脚本不启动 SocialNet 帖子源，「开始仿真」需要它，完整功能请使用 `.\start.ps1`。

## 浏览器验收

`web/e2e` 下的 Playwright 用例默认自行启动隔离的 Bridge 和 Vite。`opinion.spec.ts` 等用例通过 `page.route` 模拟 Bridge 接口；设置 `FIRE_E2E_MOCK_ONLY=1` 时不启动 Bridge，只运行不依赖真实 Bridge 的用例。
