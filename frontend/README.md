# 火灾应急管理仿真沙盘系统 · 可视化前端

React + Vite + TypeScript + Tailwind CSS + Lucide 构成系统可视化前端，通过 FastAPI Bridge 连接 Python 核心定位引擎 `FireLocalizer`、POI 空间模型 `PoiRepository` 和模拟信息生成器 `demo.generate`，默认使用 Offline 模式。前端在既有 API 边界内独立优化，不改变定位算法、POI 数据或模型配置；接口变更需评审。

## Windows 启动

在两个独立 PowerShell 终端中运行。当前机器的 Python 环境为项目根目录 `.venv`，Node 便携版位于 `frontend/.tools/node-v24.21.0-win-x64/`，没有修改全局 Node 配置。

终端 1（Bridge）：

```powershell
cd F:\LUCK_Group\fire
powershell -NoProfile -ExecutionPolicy Bypass -File .\frontend\start-bridge.ps1
```

等价的手动启动命令：

```powershell
.\.venv\Scripts\python.exe -m uvicorn frontend.bridge.server:app --host 127.0.0.1 --port 8080
```

推荐启动脚本将新 Python 字节码缓存放到 `frontend/.tools/`。Bridge 启动、查询 POI、准备场景和 Offline 运行均不需要读取 `.env`。

终端 2（React）：

```powershell
cd F:\LUCK_Group\fire
powershell -NoProfile -ExecutionPolicy Bypass -File .\frontend\start-web.ps1
```

如果终端已有合适的 Node/npm，也可使用：

```powershell
cd F:\LUCK_Group\fire\frontend\web
npm.cmd run dev
```

访问 **http://127.0.0.1:5173**。Bridge 健康检查为 http://127.0.0.1:8080/api/health，API 文档为 http://127.0.0.1:8080/docs。Vite 将 `/api` 代理到 `127.0.0.1:8080`。两个进程均绑定本机回环地址；在各自终端按 Ctrl+C 停止。端口已被占用时不要终止其他用户进程。

## Node 与局部依赖

当前机器已经完成局部安装，无需重复。若复制到缺少工具的新环境：

```powershell
cd F:\LUCK_Group\fire
powershell -NoProfile -ExecutionPolicy Bypass -File .\frontend\setup-node.ps1
```

脚本从 [Node 官方分发目录](https://nodejs.org/dist/v24.21.0/) 下载 Windows x64 ZIP，核验官方 SHA-256，在 `frontend/.tools/` 解压并按 `package-lock.json` 安装局部依赖。只改变当前进程 PATH。Vite 的 [Node 版本要求](https://vite.dev/guide/) 为 20.19+ / 22.12+，本项目使用 Node 24.21.0。

## 演示步骤

1. 页面连接 Bridge 后，自动准备默认场景（成品1号储罐、seed 42、10 条帖子）。地图仅显示灰黑色真实点，无红色预测圆环。
2. 选择任意储罐会创建新的独立场景；准备期间、运行期间禁用重复操作。
3. 点击「开始定位」，后台执行核心定位引擎。界面显示真实会话状态，不显示虚构百分比，不提前展示候选。
4. 完成后红色圆环位于后端返回的 Top1 坐标。命中时中心灰黑点与外圈红环同时可辨。选择 Top2/Top3 会显示不同颜色的虚线候选标记，Top1 保持原位。
5. 控制台显示真实候选得分、处理数量、证据簇和欧氏距离误差。得分/相对得分不是经过校准的火灾概率。
6. 重置创建新会话，清除本轮 UI 结果，保留旧结果目录。刷新页面也会准备新会话，不自动沿用上一轮预测。

Offline 使用规则提取和字符哈希向量，仅用于流程演示。它不代表智增增真实大模型效果。

## Live 模式

Live 通过 `Settings.load()` 接入 `FireLocalizer(offline=False)`；使用此前 `.env` 配置的智增增模型。浏览器不接触密钥，错误响应不包含供应商原文、密钥或向量。

选择 Live 仅准备场景，不产生模型请求。点击开始后，必须在确认框中勾选批准付费调用并再次确认。服务端要求严格布尔字段 `confirm_paid_api: true`，遗漏、false 或字符串值均不能启动 Live。初始化向量库也包含 POI 名称编码，可能产生多次 Embedding 请求。失败时保留 Live 模式和错误类型，不回退为 Offline。

本阶段没有进行任何新的付费模型调用。Live 真实端到端联调待另行授权。若当前终端保留了阶段 2A 的 `PYTHON_DOTENV_DISABLED=1`，应在准备进行已获批准的 Live 演示前，单独设置 `$env:PYTHON_DOTENV_DISABLED='0'` 并重新启动 Bridge；不得把密钥放进命令参数或浏览器。

## 会话与数据隔离

每个演示使用随机 UUID 目录 `runtime/frontend/<session_id>/`：

```text
session.json                  # 前端状态和展示用真实标签
demo_posts.jsonl               # 模拟信息生成器输出，无真实标签字段
demo_posts.meta.json           # ground truth，仅展示与评估
root/                         # 独立 Settings.root
  city_localization_data_dictionary.xlsx
  fire_sandbox_spatial_model.json
  runtime/embedding_cache.json # 仅该 Live 会话的向量缓存
memory.json                   # 核心定位引擎内部状态，HTTP 不公开向量
batch_results.json
prediction.json
report.json
failure.json                  # 仅失败时生成，保存错误类型与安全提示
```

POI 文件只复制，不改动原件。Bridge 使用 `dataclasses.replace` 指向会话根目录；原始 `runtime/embedding_cache.json` 和此前 benchmark、阶段 2A/2B 结果保持不变。历史模拟帖子直接交给核心定位引擎，绕开实时 `/posts` 的最近 60 分钟限制，预测时间仍采用原始模拟证据时间。

ground truth 不进入 `Post`、提取器提示词、匹配器或候选排名，只在预测完成后计算命中与距离。定位引擎 Memory 已保存的向量仅留在本地会话目录，不返回浏览器。

API 支持按会话查询。服务重启后可读取已有会话；未完成的任务会标记中断，不自动重跑，尤其不自动重发付费请求。当前实现用于单进程本地演示，不启动多个 Uvicorn worker。

## 坐标校准

正式底图仅使用 `frontend/assets/沙盘原始底图.jpg`，1707×1280。原始 PNG 为 1707×1360，只作为校准参考。通过图片网格 RGB 比较确认参考图向下多 80 像素；提取原始 PNG 中 28 个红色 POI 标记中心并核对 JSON/Excel 坐标后得到：

```text
left = 160 px     top = 70 px
width = 1385 px   height = 1120 px
pixelX = 160 + x_m / 30 * 1385
pixelY = 70 + (1 - y_m / 25) * 1120
```

28 个跨区域储罐/建筑锚点最大残差约 0.028 像素（源数据坐标保留 0.001m）。这验证与原始人工 POI 标注的一致性，不代表物体几何中心或测绘精度。

典型 JPEG 像素位置：成品1号约 (678,713)，成品2号约 (754,713)，成品3号约 (678,792)，东北1号约 (1035,548)，原料1号约 (920,708)，锦安1号楼约 (252,445)，消防站约 (240,1140)。所有正式标记使用后端米制坐标实时转换，没有写死 CSS 位置。

`src/utils/mapCoordinates.ts` 提供双向转换；`docs/map-calibration.json` 保存 28 个实测锚点，`docs/map-image-alignment.json` 保存图片平移测量。SVG 同一 viewBox 内包含 JPEG、POI、真实点和候选点，保持图片纵横比；拖动、缩放时同步。

点击地图工具栏「坐标校准」打开网格和 left/top/width/height 输入，参数只保存在当前浏览器 localStorage，不改变图片、原始坐标或后端数据；「恢复实测校准」清除浏览器微调。移动光标可查看米制坐标。建议先对照不同区域的建筑和储罐，再决定是否微调。

## 测试与保护检查

先关闭手动启动的 8080/5173 服务；浏览器测试会自行启动并停止它们，不复用未知进程。

```powershell
cd F:\LUCK_Group\fire
powershell -NoProfile -ExecutionPolicy Bypass -File .\frontend\verify.ps1 -Browser
powershell -NoProfile -ExecutionPolicy Bypass -File .\frontend\scripts\verify-protection.ps1
```

`verify.ps1` 运行原始 pytest、Bridge 测试、TypeScript、生产构建、地图单元测试及可选浏览器验收；测试数据放入新建的 `runtime/frontend/acceptance_<uuid>/`，缓存放到 `frontend/.tools/`。不修改原始清单，不调用付费 API。

Playwright 使用当前机器安装的 Chrome，无需额外下载浏览器。仅有 Edge 时可先设置 `$env:PLAYWRIGHT_CHANNEL='msedge'`。测试包含真实 Offline 流程；空结果、错误预测位置和失败状态的 UI 用例使用明确的响应夹具，不能当作算法效果评估。Live 用例只验证取消，以及使用模拟失败和网络拦截验证服务端门禁，不发送真实模型请求。

浏览器截图位于 `frontend/screenshots/`。`node_modules`、构建产物、工具缓存、测试报告由 `frontend/.gitignore` 排除；根目录 `.gitignore` 保持不变。新增源码、文档、截图和配置均在 `frontend/`，不自动执行 Git 提交。

## 手动验收重点

- 在你的常用显示器及浏览器缩放比例下检查字体、间距和地图可读性；布局允许纵向滚动，窄屏会堆叠面板。
- 默认地图只有灰黑色真实点；完成后双标记重合但可分辨。缩放与拖动后标记仍贴合 POI。
- 点击 Top2/Top3 验证虚线候选和红色 Top1 的区别；更换场景、重置、刷新均不得出现旧预测。
- 检查无后台服务时的错误提示，并确认 Live 弹窗取消不发起定位请求。
- Live 的新付费联调需另外批准；不要在本次 Offline 验收中勾选付费确认。
