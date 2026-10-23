# 新地图前端演示

从项目根目录，在两个 PowerShell 终端分别执行：

```powershell
./frontend/start-bridge.ps1
```

```powershell
./frontend/start-web.ps1
```

访问 http://127.0.0.1:5173。Bridge 在 8080 端口，Vite 将 `/api` 转发到 Bridge。启动脚本使用已确认的 Anaconda `agent` 环境（`D:/Anaconda/envs/agent/python.exe`），其他机器可通过 `FIRE_PYTHON` 指定解释器。已有 `node_modules` 时无需重复安装。

默认场景为西南罐区1号储罐 `T-SW-01`，共 8 个储罐场景，每轮 100 条帖子，按 10 条一批，共 10 批。Offline 使用规则提取和字符哈希向量；Live 读取本地模型配置，需要页面确认后才能发起付费请求。启动、场景准备和 Offline 不调用真实模型，失败也不自动切换运行模式。

## 地图与坐标

唯一底图是 `../fire_poi/map_original.png`（1313×1050），数据入口是同包规范空间模型，显示 29 个实体 POI（8 罐、17 建筑、4 管线设施组）。道路、区域和节点仍可作为后端参照对象，共 90 项，不作为实体标记铺满地图。

按用户确认 1 仿真单位 = 1 米，范围仍为 30m×25m；原点在西南，X 向东、Y 向北。图像左上是北西角，不能直接把像素 Y 当作地图 Y。`map_config.json` 定义源像素中心索引：

```text
u = x * 1312 / 30
v = (25 - y) * 1049 / 25
```

SVG `<image>` 使用图像外边缘坐标，需换算为：

```text
edgeX = u * 1313 / 1312 = x * 1313 / 30
edgeY = v * 1050 / 1049 = (25 - y) * 1050 / 25
```

地图保持原始图片比例；X/Y 像素比例略有不同。底图、实体 POI、真实点与预测点置于同一 SVG 中，缩放拖动共享变换。坐标网格可开关；旧图的本地校准缓存不再读取，避免遗留偏移。

## 会话与验证

每轮使用独立目录 `runtime/frontend/<session_id>/`。其中 `root/fire_poi/` 保存规范 JSON、地图配置和底图副本。标签仅留在 `.meta.json` 和展示/评估状态，推理只接收 `Post`。Memory 和会话均记录地图指纹，旧地图状态会被拒绝，需重新准备场景。

```powershell
./frontend/verify.ps1 -Browser
./frontend/scripts/verify-protection.ps1
```

验证覆盖 Python 后端、TypeScript 构建、29 个 POI 的源像素对齐、四角与逆变换，以及真实页面的运行、缩放、图层、候选高亮、手机布局、重置与错误状态。浏览器测试默认使用本机 Edge，可设置 `PLAYWRIGHT_CHANNEL` 切换已安装浏览器。测试截图位于 `web/screenshots/`，结果目录不纳入版本管理。

数据包不是实测测绘数据；用户确认的米制仿真约定不改变原包的几何精度声明。原始旧地图验收保留在 `PROGRESS.md` 作为历史记录，当前结果见 [迁移记录](../MAP_MIGRATION.md)。
