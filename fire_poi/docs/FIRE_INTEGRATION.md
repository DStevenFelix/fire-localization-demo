# fire 项目定位接入说明

## 1. 唯一数据入口

推荐把本包解压到fire仓库的数据目录，例如 `data/city_spatial/`，保留整个目录结构。统一加载 `fire_sandbox_spatial_model.json`，其中包含当前pois、areas、roads、nodes、edges、relations、alias_index及id_redirects。拆分JSON供人工核对与分层加载；二者由同一规范数据生成，禁止手改一份后混用。

`map_config.json`定义坐标/图片；启动时检查 `source.sha256` 与map_original.png一致。id_redirects只覆盖本次v1.0→v1.1变更；不对已废弃的其他历史POI进行猜测映射。

## 2. 上游→查询→下游

上游 `schemas/alert_input.schema.json` 保留event_id、alert_level、content、timestamp，可附reporter.current_poi_id。该位置是报告人参照点，不能默认当作火点。

解析器输出 `schemas/localization_query.schema.json`：explicit_target、reference、spatial_relation、road_hint、area_hint、distance、nearest。它不接受x、y；不允许解析器编造坐标。仅有“我在X，对面着火”时X是reference；“X着火”时X才是explicit_target。

确定性检索返回 `schemas/localization_result.schema.json`。唯一POI可返回located；区域范围、多候选、缺参照返回ambiguous且location=null。候选坐标均来自当前POI。confidence为演示启发式值，未做概率校准。

`examples/`的告警、人工结构化查询、实际脚本输出一一对应。脚本没有把自然语言自动变成query；自然语言解析仍应在fire项目中单独实现或接入。

## 3. 可直接运行

无需安装依赖，Python 3.9+：

```bash
python scripts/spatial_repository.py --name "锦安社区2号楼"
python scripts/spatial_repository.py --name "U-E-01"
python scripts/spatial_repository.py --query-json '{"event_type":"fire","explicit_target":{"target_type":"Tank"},"reference":{"poi_id":"B-W-02"},"spatial_relation":"across_road","road_hint":"锦安路"}'
python scripts/verify_package.py
```

在Python模块内：

```python
from spatial_repository import SpatialRepository
repo = SpatialRepository("data/city_spatial")
result = repo.query("evt-001", {
    "event_type": "fire",
    "explicit_target": {"name_text": "南苑社区1号楼"}
})
```

import路径由现有项目布局决定：可将scripts放入现有包中或在应用入口显式设置模块路径。不要覆盖现有后端算法、模型配置或API Key。

## 4. 前端组件

map_original.png为唯一底图。POI的center=[x,y]是主坐标；源图像素中心 `u=x*1312/30`、`v=(25-y)*1049/25`。缩放/拖动后先反变换点击位置，再查POI轮廓。位于图片外边缘坐标系的CSS点击应按map_config换算，避免混用1313/1050和1312/1049。

正式地图建议默认只显示底图，按选择、高亮或定位结果叠加POI；完整标注PNG用于人工验收。火点是动态对象，与静态POI分开，真实/预测火点样式由已有fire界面控制。不要把POI_atlas.png或CoordinateAudit.png当作组件底图。

## 5. 步行与机动车

R-08、R-09、R-10、R-11明确为pedestrian_only，road与edge均有allowed_modes和vehicle_allowed=false。

机动车必须使用RoadGraph_motor_vehicle.json，或过滤edges的allowed_modes；步行可使用RoadGraph_pedestrian.json。不可仅按节点连通推断机动车可通行。其余路段沿用抽象仿真通行假设，未加入真实车道转向/门禁规则。城市定位查询可以参照步行通道，无须删掉这些道路实体。

## 6. 合并与归一化

U-E-01→B-E-02，U-E-02→B-E-03，U-E-03→B-E-04，U-S-01→B-S-03，B-D-06→B-D-05。旧ID只作重定向，不生成重复POI。

为保留已有东侧1号楼身份，B-E-01仍是东侧第三个主体；新增B-E-02/03/04分别是北、中、南三个原U对象。楼号是仿真地址，不用ID排序推断空间次序，应使用center坐标。

## 7. 开发验收顺序

1. 运行verify_package，检查坐标、旧ID、分类、模式路网和示例契约。
2. 将现有fire接口映射到本包Schema，先验收明确地址与旧ID归一化。
3. 验收“报告人位置+对面/方位+目标类型”的候选，确保不强猜唯一结果。
4. 对接已有Socket传输并保持event_id，再将结果送入现有React地图组件。
5. 多帖子时空聚类、置信度校准和交通协同控制单独推进。
