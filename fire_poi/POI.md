# 当前空间模型数据字典 · v1.1

## 1. 坐标和底图

LOCAL30x25：西南(0,0)、东南(30,0)、西北(0,25)、东北(30,25)，X东Y北。单位为simulation_unit，30×25不是实测物理尺寸。

底图1313×1050，SHA-256：`300f7e00b2d285e98c146e2e5f43846e862e5cd3bec59377846c275a84449eea`。

```text
x = u * 30 / 1312
y = (1049 - v) * 25 / 1049
```

u/v是**源图像素中心索引**，范围0..1312、0..1049，仅用于显示。若CSS点击坐标按图片外边缘0..width、0..height计算，先换算u=edgeX*1312/width、v=edgeY*1049/height，再用上述公式；别把两种像素约定混用。缩放/拖动先逆变换到图片坐标。

图片保持原始长宽比；局部空间30/25与像素比不完全相同，X/Y像素比例略有差异，不为等比例仿真坐标而拉伸底图。图版比例尺是X方向仿真单位，不能当作真实米制比例尺。

几何保留6位小数是为了往返一致性，不代表测量精度。建筑轮廓按可见屋面描绘，储罐按可见罐顶外缘描绘，管线组用主要器件包络；并非地籍基底或工程图。人工边缘通常有数像素误差。

## 2. 数据入口与封装

推荐入口 `fire_sandbox_spatial_model.json`；拆分文件POI.json、Areas.json、Roads.json、SpatialRelations.json、AliasIndex.json、IDMapping.json由同一数据生成。元数据含schema_version、model_version、crs/source_sha256。几何采用GeoJSON式Polygon/LineString结构，但不是WGS84经纬度。

|字段|含义|
|---|---|
|id|当前唯一实体ID，与显示名称解耦|
|name/aliases|仿真正式名称及别名；非真实模型名称声明|
|entity_type|Tank / Building / Facility；区域可为Region、Green Area、Pavement|
|category|可读类别：大型储罐、小区建筑、罐区附属建筑、管线设施组|
|building_use|community_building或tank_area_ancillary，仅建筑有此字段|
|classification_status/confirmation_source|建筑均为用户确认，源为本轮实物确认消息|
|parent_id|直属区域；祖先归属需递归；城区根为null|
|center|局部[x,y]，来自几何形心；储罐为罐顶中心|
|geometry|闭合逆时针Polygon外环，主坐标一致|
|shape|储罐Ellipse中心及局部X/Y半径，64段Polygon近似|
|linework|管线主要可见折线示意；topology_available=false，不是工程管线拓扑|
|floor_count|null，用户仅确认小区/附属建筑用途，没有楼层测量信息|

## 3. ID和命名

罐按四罐区NW/NE/SW/SE，各区由西向东01、02。西侧锦安社区由北向南B-W-01..05；罐区附属建筑北缘由西向东B-D-01..04，东缘同一栋为B-D-05。

为保留原东侧1号楼身份，B-E-01仍对应东侧第三个主体（中下部立体模型）；B-E-02、03、04分别对应原北、中、南三个U对象。正式楼号为仿真地址，不是排序算法；不得据ID顺序猜测坐标。南庭社区B-S-01/02由西向东，南苑社区B-S-03正式名称为“南苑社区1号楼”。

|旧ID|规范ID|处理|
|---|---|---|
|U-E-01|B-E-02|小区建筑，原几何不变|
|U-E-02|B-E-03|小区建筑，原几何不变|
|U-E-03|B-E-04|小区建筑，原几何不变|
|U-S-01|B-S-03|小区建筑，原几何不变|
|B-D-06|B-D-05|同栋合并，中心按完整轮廓重算|

旧ID只查重定向，不保留成第二个POI。AliasIndex包括旧名称与旧ID；其他废弃历史POI无可靠对应，不做猜测映射。类别应读entity_type/building_use，不用前缀猜测。

北侧蓝白图形仅属于A-NORTH-GREEN景观区域；两黄色矩形为A-PAVE-SW/SE铺装区域。它们从未作为本版Building/Facility。

## 4. 路网

Roads.json.roads是11条命名道路/通道；nodes为32个几何节点；intersections是15个交汇/步行接入节点的视图，不是另建15个实体，也不表示15个机动车交叉路口；edges为37条分段边。

|字段|含义|
|---|---|
|centerline|局部坐标道路中心折线；主干双幅道路抽象为单中轴|
|from_node/to_node/node_ids/edge_ids|道路端点及其分段拓扑|
|axis|east_west / north_south / mixed|
|access_mode|pedestrian_only或原有vehicle_abstract|
|allowed_modes|当前仿真允许的pedestrian/motor_vehicle|
|vehicle_allowed|R-08/09/10/11为false|
|access_basis|步行限制为user_confirmed，其余为原有抽象仿真假设|
|length|局部仿真坐标折线长，不是实测米数或行车时间|

R-05东西连通两侧主路，R-06南北通道在园内止步，不穿过绿化带。RoadGraph_motor_vehicle.json排除R-08/09/10/11全部边；步行图保留它们。模式图的node.road_ids已按该模式过滤，is_profile_junction仅说明该模式图内的交汇情况。

图为无向几何拓扑，未实现车道箭头、转向、信号灯、门禁。后续真实交通控制应在现有空间底座上补足相关规则。

## 5. 关系

|predicate|方向和规则|
|---|---|
|within|子对象→父区域，逆向为contains；可递归|
|east_of等8方位|主语中心相对宾语中心，atan2每45°扇区，边界±22.5°|
|near|同父区域的对象边界距离≤1.6仿真单位|
|adjacent|同父区域POI边界距≤0.65；相邻罐区间阈值1.8|
|along|所属街区临街关联，不意味着有车辆入口|
|across_road|对向地块之间只跨一条实际有限主路，沿路投影间隔≤0.65；候选关系|
|on_road|节点与道路的拓扑关联|
|connected_to|道路共享节点，不等价于车辆任意转向|

symmetric=true只存一条记录，反向查询须支持。方向关系只对有意义局部配对预计算；辅助代码可对任意POI和参照中心实时计算。没有预存关系不等于任意对象对都不满足该关系。

“对面”不默认唯一；“附近”阈值为本模型规则，不是通用语言定义。管线工艺/住户观察朝向/遮挡没有被推定。nearest只有文本明确要求最近时才用于单候选收敛。

## 6. 定位契约

schemas定义Alert、LocalizationQuery、LocalizationResult。LLM不传坐标；查询可以给explicit_target/reference/关系/道路/区域/距离。距值为distance.value并明确unit=simulation_unit，结果为location.x/y及同一unit，不用x_m/y_m冒充米。

located仅给当前规范POI坐标；ambiguous/not_found/invalid的location为null，必要时给候选。confidence是演示启发式数值，未校准。Schema示例用包内所需关键字的轻量验证器核验，不声称执行了独立完整Schema引擎。

docs/FIRE_INTEGRATION.md说明接入与代码范围；docs/SOURCE_DESIGN_SCOPE.md说明分享文档采用范围。自然语言解析、Socket服务及实际fire联调不在本包已完成能力中。

## 7. 图层及核对

完整图、简洁图及独立透明图层都为1313×1050。map_original.png原字节不变。POI_atlas.png是地图2倍等比显示并附外侧索引的图版，其地图框起点(88,180)、尺寸2626×2100。CoordinateAudit.png为逐对象裁切复核，不能作地图底图。

Excel共12张表，数值坐标由规范数据直接生成。CoordinateAudit.json记录29项：28项保留原中心，1项合并建筑重算中心。PNG和SVG覆盖层使用同一几何；SVG标签为默认偏移，与PNG人工布局可不同，但实体点位一致。

## 8. 当前兴趣点全集

|ID|名称|类别|X|Y|父区域|
|---|---|---|---:|---:|---|
|T-NW-01|华安能源西北罐区1号储罐|大型储罐|9.626524|15.419447|A-TANK-NW|
|T-NW-02|华安能源西北罐区2号储罐|大型储罐|12.393293|15.419447|A-TANK-NW|
|T-NE-01|华安能源东北罐区1号储罐|大型储罐|17.583841|15.419447|A-TANK-NE|
|T-NE-02|华安能源东北罐区2号储罐|大型储罐|20.350610|15.419447|A-TANK-NE|
|T-SW-01|华安能源西南罐区1号储罐|大型储罐|9.717988|8.984747|A-TANK-SW|
|T-SW-02|华安能源西南罐区2号储罐|大型储罐|12.393293|9.008580|A-TANK-SW|
|T-SE-01|华安能源东南罐区1号储罐|大型储罐|17.446646|8.960915|A-TANK-SE|
|T-SE-02|华安能源东南罐区2号储罐|大型储罐|20.167683|8.960915|A-TANK-SE|
|B-D-01|华安能源园1号附属楼|罐区附属建筑|9.798018|17.635844|A-TANK-NW|
|B-D-02|华安能源园2号附属楼|罐区附属建筑|12.656250|17.635844|A-TANK-NW|
|B-D-03|华安能源园3号附属楼|罐区附属建筑|17.298018|17.635844|A-TANK-NE|
|B-D-04|华安能源园4号附属楼|罐区附属建筑|20.201982|17.635844|A-TANK-NE|
|B-D-05|华安能源园5号附属楼|罐区附属建筑|21.497451|15.172085|A-TANK-NE|
|B-W-01|锦安社区1号楼|小区建筑|1.806403|17.040038|A-WEST|
|B-W-02|锦安社区2号楼|小区建筑|1.794970|15.181125|A-WEST|
|B-W-03|锦安社区3号楼|小区建筑|1.783509|12.495951|A-WEST|
|B-W-04|锦安社区4号楼|小区建筑|1.806402|9.902288|A-WEST|
|B-W-05|锦安社区5号楼|小区建筑|1.806403|8.067207|A-WEST|
|B-E-01|东源社区1号楼|小区建筑|28.194460|11.047808|A-EAST|
|B-S-01|南庭社区1号楼|小区建筑|9.615091|1.143946|A-SOUTH-W|
|B-S-02|南庭社区2号楼|小区建筑|12.073171|1.143946|A-SOUTH-W|
|B-E-02|东源社区2号楼|小区建筑|28.125000|16.062917|A-EAST|
|B-E-03|东源社区3号楼|小区建筑|28.182164|13.572450|A-EAST|
|B-E-04|东源社区4号楼|小区建筑|28.090702|8.674929|A-EAST|
|B-S-03|南苑社区1号楼|小区建筑|19.177038|0.971923|A-SOUTH-E|
|F-PIPE-NW|西北罐区管线设施组|可见管线设施组|10.918445|15.371782|A-TANK-NW|
|F-PIPE-NE|东北罐区管线设施组|可见管线设施组|19.001524|15.347950|A-TANK-NE|
|F-PIPE-SW|西南罐区管线设施组|可见管线设施组|11.192836|7.614395|A-TANK-SW|
|F-PIPE-SE|东南罐区管线设施组|可见管线设施组|18.692835|7.626310|A-TANK-SE|
