# 火灾应急沙盘 POI / 定位数据包 v1.1

版本：1.1.0-confirmed-image5-20261023。唯一底图为《沙盘模拟图(5).png》，1313×1050，未裁剪、旋转或重绘。主坐标为西南原点、X向东、Y向北的30×25局部仿真坐标，非实测米制。

## 已按用户实物确认修订

- 原U-E-01/02/03及U-S-01均为小区建筑，规范ID为B-E-02/03/04、B-S-03。
- 原B-D-05/06是同一栋楼，合并为B-D-05。
- 外围12栋小区建筑、罐区5栋附属建筑，共17栋建筑；另有8罐和4组管线设施，有效兴趣点共29个。
- R-08/09/10/11仅限步行，机动车禁止，已落实到道路和边及独立模式路网。
- 北侧蓝白景观和南侧两块黄色铺装始终不建建筑/设施点。
- 其余28个POI中心和轮廓与上一版本保持一致；合并建筑按整栋轮廓重算中心，见CoordinateAudit。

## 人工查看

|文件|用途|
|---|---|
|POI_atlas.png|高清地图及完整名称索引|
|POI_overlay.png|1313×1050完整叠加图，与原图直接对齐|
|POI_simple.png|1313×1050简洁点位图|
|map_original.png|原始底图字节副本|
|CoordinateAudit.png|29个独立原图裁切、轮廓和十字中心，逐项检查实体对应|
|CoordinateAudit.json / .csv|主坐标、显示像素及变更追踪|
|Road_topology.png|几何路网与接入节点；紫色为仅步行通道|
|POI.xlsx|12张人工核对表，含分类、道路权限、确认记录、旧ID和坐标复核|
|VALIDATION_REPORT.md|核验结果及适用范围|

## fire开发入口

先看 `docs/FIRE_INTEGRATION.md`，统一读 `fire_sandbox_spatial_model.json`。它包含pois、areas、roads、nodes、edges、relations、alias_index与id_redirects；拆分JSON用于核对及分层加载。

定位设计沿用用户分享文档的模块边界与流程，不使用其中任何废弃POI、旧阈值、地图或米制声明，详见 `docs/SOURCE_DESIGN_SCOPE.md`。

`schemas/`有告警/查询/结果三个JSON Schema；`examples/`有11组告警、人工规范查询及实际辅助代码输出；`scripts/spatial_repository.py`提供无外部依赖的读取、名称/别名/旧ID、方位/隔路候选和模式路径查询。它不是完整自然语言Agent或Socket服务，尚未与用户本地fire仓库联调。

```bash
python scripts/verify_package.py
python scripts/spatial_repository.py --name "锦安二号楼"
python scripts/spatial_repository.py --name "B-D-06"
```

机动车路径用RoadGraph_motor_vehicle.json，步行用RoadGraph_pedestrian.json；不能仅凭全图节点连通认定车辆可通行。

本包通过155项结构/几何检查、130项离线查询/契约检查，以及Excel 4754个数据单元格比对。轮廓仍是人工图像描绘，非测绘或车道级交通模型。
