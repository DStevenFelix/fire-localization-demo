# Fire 火灾应急管理仿真沙盘

Python定位算法、FastAPI Bridge与React前端组成的城市火情定位工程。正式地图为city-full，90×75仿真单位；原始30×25沙盘及POI保持不变。

## 当前能力

- 前端已完成地图缩放/拖动/图层、车辆与行人动画、415项POI注册、候选历史颜色及最终Top1展示。
- 行人网络318节点、440边，只走合法人行道、斑马线和原始专用通道；R-08～R-11禁止机动车。
- 原始算法只输出原始8个储罐候选。扩展住宅、社区和公共设施此前仅验证过模拟候选显示，真实定位算法尚待适配。
- 消防站及3个车辆资源只预留位置与关联，不含调度、寻路或信号控制。

## 目录

| 目录 | 用途 |
| --- | --- |
| fire_locator/ | 原始定位算法；主要修改范围 |
| fire_poi/ | 中央原图、原始空间模型，以及坐标校验和整城生成仍使用的数据 |
| city_scene/ | city-full静态资源、扩展POI、道路/行人数据和Schema |
| frontend/ | Bridge、React前端、启动脚本及原有项目测试 |
| integration/ | API契约、Prediction Schema和算法接入说明 |
| data/ | 原项目的演示输入与元数据，不是新增验收夹具 |
| tests/ | 原项目算法与接口测试 |

## 安装和启动

Python≥3.11，Node≥22.12。仓库根目录执行：

```powershell
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt
cd frontend/web
npm ci
cd ../..
```

两个终端分别运行：

```powershell
./frontend/start-bridge.ps1
```

```powershell
./frontend/start-web.ps1
```

打开 http://127.0.0.1:5173，Bridge位于8080端口。可用FIRE_PYTHON指定已有Python解释器。启动本身不调用真实模型；默认Offline，Live需要明确的付费确认。点击开始定位会生成新演示任务，不会自动重放历史记录。

## 继续开发操作

先读 [HANDOFF_README.md](HANDOFF_README.md)，再读 [算法适配说明](integration/ALGORITHM_ADAPTATION.md) 和 [API契约](integration/FRONTEND_API_CONTRACT.md)。通过GET /api/spatial-data读取原始与扩展数据，或在算法内读取settings.root/city_scene中的正式JSON。

当前演示仍为每轮 100 条、每批 10 条。生成器使用整城坐标，火点 30 米以外不发帖；20 米以上至 30 米只生成模糊描述；20 米以内的帖子按每 11 条 4 条明确方向、3 条模糊、2 条低紧急度、2 条干扰循环。定位搜索半径为 15 米，方向扇形为 45°。

算法将原图 POI 按地图配置偏移到整城坐标，与扩展 POI 一起匹配参照物；模拟火点候选仍为原来的 8 只储罐。正文既无明确方位、也无可匹配地点名的帖子，对每个命中的候选投 0.34 票；其余帖子投 1 票。每个候选独立维护票数与文本向量累计值，不合并，满 30 分钟没有收到新票即退出排名。每完成一批，Bridge 发布一次进度和预测。

只修改fire_locator及对应算法测试。地图、POI、行人网络、前端和Bridge协议是已完成的工程基础，无需重新开发。社区入口是已有建筑入口引用，can_post仅表示发帖参照资格，不等于火灾候选资格。

本源码不包含本轮审计、Mock、临时测试、截图报告或交付ZIP。原项目测试保留；部分测试会执行100条演示推理，运行前应明确授权范围。配置凭证放本机.env，勿提交Git。
