# 原图及兼容数据

这里保留嵌入整城地图中央的 30×25 原图，以及现有代码所依赖的数据。

| 文件 | 用途 |
| --- | --- |
| fire_sandbox_spatial_model.json | 原图 POI、区域、道路、节点与关系；算法与前端仍从这里读取 8 个储罐 |
| map_config.json、map_original.png | 原图坐标系、尺寸、图像校验信息与底图 |
| CoordinateAudit.json | 前端坐标转换测试的核对点 |
| Roads.json、RoadGraph_motor_vehicle.json | 整城场景生成器引用的原始道路数据 |

新版整城 POI 清单在 `city_scene/poi_catalog.json`。旧版独立导出、图册和查询工具已经清理。
