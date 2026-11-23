# city-full 正式空间数据

city_scene.json及assets为正式city-full几何/静态资源，不修改建筑、道路、绿化或原图。场景CITY90x75，原图LOCAL30x25居中于X=30..60、Y=25..50。

| 文件 | 用途 |
| --- | --- |
| poi_catalog.json | 325项扩展POI：名称、别名、类型、父级、坐标、几何、来源和can_post |
| poi_hierarchy.json | subject_id/relation/object_id/source父子关系 |
| city_scene.json | 冻结建筑/道路/节点几何、56条车辆路线及原图放置 |
| pedestrian_animation.json | 318节点、440边、136处斑马线引用和连续闭合路线 |
| fire_resources.json | 消防站与3个车辆资源的预留位置、station_poi_id和接入道路/节点 |
| handoff_schema.json / scene_schema.json | 正式数据JSON Schema |
| runtime-manifest.json | 正式数据版本和文件指纹；Bridge隔离会话使用 |
| community_building_entrances.csv | 正式入口派生表，由runtime-manifest引用 |

原始90项与扩展325项组成415项注册表。扩展类型：社区7、功能区8、建筑106、入口120、物业联系点7、公园4、道路20、路口40、内部节点12、预留地1。建筑住宅72、商业21、公共13，沿用现有几何。

id稳定；parent_id为直接父级；community_id/region_id为所属社区；aliases用于可区分的名称引用，source保留来源。geometry采用Point/LineString/Polygon/MultiPolygon坐标数组，center为POI显示位置。

can_post是帖子参照资格，不是火灾候选资格。建筑97可引用、9个辅助建筑不可；社区/命名功能区/公园和路口可引用；内部节点、物业联系点、预留地及8条接驳路不可引用，具体理由在post_policy。原始规则不回写原始POI。

社区几何为已有建筑地块并集。建筑入口取既有building.entrance；14个社区入口用access_via_id引用这些入口，不代表新增物理大门。物业联系点仅作语义参照，不代表新增建筑或实际机构。

LOCAL转CITY加[30,25]，依据original_map_placement；CITY不重复转换。X向东、Y向北，西南原点，仿真单位不代表测绘精度。行人仅走合法人行道、斑马线与专用通道；R-08～R-11禁止机动车。消防资源状态reserved，无调度/寻路。

算法读取方法见[ALGORITHM_ADAPTATION.md](../integration/ALGORITHM_ADAPTATION.md)。冻结基线源码generate.mjs保留，不在日常启动链路，不应在算法适配时重新生成地图。
