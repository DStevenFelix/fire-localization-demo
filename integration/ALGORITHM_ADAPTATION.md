# 扩展城市定位算法接入

## 1. 当前差异与工作范围

FireLocalizer 读取原始 90 项与扩展 326 项，共 416 项参照对象，内部统一使用 CITY90x75。新增社区、建筑、道路等可用于参照匹配，发帖资格遵从各 POI 的 can_post。火灾候选仍是原来的 8 只独立储罐。匹配先处理唯一名称、ID 与别名，再做余弦模糊搜索；歧义或未超过阈值时回退发帖位置。

仅修改fire_locator及对应算法测试。city_scene、fire_poi、frontend、地图资源、稳定ID和Bridge协议保持不变。不要把住宅伪装成储罐，也不要把can_post直接当成火灾候选白名单。

## 2. 数据获取

网页环境可GET /api/spatial-data，响应完整格式见[API契约](FRONTEND_API_CONTRACT.md)。该接口分别提供原始模型、扩展326项、扩展关系及偏移/指纹；416项＝原始pois/areas/roads/nodes四集合90项＋扩展326项。

算法代码应优先读取settings.root下正式文件。Bridge的demo来源已经把下列文件复制到每个会话的隔离root；网页使用的socialnet来源下settings.root是仓库根目录，同样包含这些文件：

- fire_poi/fire_sandbox_spatial_model.json、map_config.json、map_original.png。
- city_scene/city_scene.json、poi_catalog.json、poi_hierarchy.json、fire_resources.json、runtime-manifest.json、handoff_schema.json。

不要用当前工作目录或机器绝对路径定位数据。原始道路、节点、边和空间关系从原始完整空间模型读取，不假设隔离目录包含整个fire_poi目录的其他导出文件。

```python
import json
original = json.loads((settings.root / 'fire_poi/fire_sandbox_spatial_model.json').read_text('utf-8'))
extended = json.loads((settings.root / 'city_scene/poi_catalog.json').read_text('utf-8'))
by_id = {p['id']: p for p in extended}
relations = json.loads((settings.root / 'city_scene/poi_hierarchy.json').read_text('utf-8'))['relations']
```

扩展包括社区7、功能区8、建筑106、入口120、物业点7、公园4、道路20、路口40、内部节点12、预留地1、无人机站1。id稳定；type/category区分实体；parent_id是直接父级；community_id/region_id是社区归属。住宅楼归社区，商业/公共楼归功能区，功能区归社区。aliases保留完整名称和可区分简称，source保留原始/扩展来源，不回写主数据。

原始关系使用original.relations，扩展关系使用subject_id/relation/object_id/source。扩展入口用既有building.entrance；14个社区入口引用已有建筑入口，不表示新增物理大门。社区范围是建筑地块并集，物业联系点不代表新增实体机构。

## 3. 坐标与发帖资格

原始LOCAL30x25与现有local_cartesian_meters同义：西南原点、X东、Y北。CITY90x75=LOCAL+[30,25]，依据冻结original_map_placement，不猜偏移、不回写原始坐标，不对CITY二次转换。

SVG.x=CITY.x×1313/30；SVG.y=(75−CITY.y)×1050/25。仿真单位不是地理测量精度。算法可在内部统一CITY坐标，但应保留每项原生坐标和来源用于审计/解释，而不修改空间主数据。

can_post仅表示可作为帖子位置参照，具体原因在post_policy。辅助建筑、内部节点、部分接驳道路、物业点和消防预留地不可发帖；火灾候选资格须由算法独立定义。原始8罐演示场景仍可保留，不需要扩大网页场景控制器来验证算法。

## 4. 必须兼容的Python接口

主要文件：poi.py（加载、索引、参照与候选）、providers.py（名称/语义匹配）、engine.py（推理与输出），必要时models.py、memory.py和对应测试。

Bridge直接调用FireLocalizer(settings, offline=..., state_path=..., resume=False)；demo来源随后每10条调用ingest(posts,flush=True)，读取response['updates'][-1]['prediction']，最后调用prediction()。网页使用的socialnet来源每收齐3条调用一次ingest(batch)，读取同一位置的prediction，移交应急处置后不再调用。两种来源都必须保留：

- memory.processed_count、memory.ignored_count、memory.batch_count。
- extractor.calls、embeddings.request_count；有client时应保持可关闭。
- Post字段和Prediction结构，见[API契约](FRONTEND_API_CONTRACT.md)及[prediction.schema.json](prediction.schema.json)。

当前prediction通过repository.tanks取候选实体；扩展算法需要改为从统一索引解析允许的候选类型，保留原tanks语义供原始8罐场景使用。评分、匹配和推理由算法内部实现，不修改Bridge来伪造扩展候选。若调整Repository指纹，应只取数据内容，不包含本机绝对路径，保证主工程与隔离副本一致。

## 5. 返回现有前端

算法返回标准Prediction即可。未来扩展结果声明coordinate_system='CITY90x75'，poi_id用正式注册表ID，name和coordinates与该POI对应；所有rank/score/votes/confidence/relative_score/cluster_ids来自真实算法。空结果返回空candidates，不能用模拟占位结果。

Bridge发布当前Prediction和batch_history；前端统一按ID解析并累计历史颜色，completed时突出最终rank=1。已注册ID按POI中心显示；同一建筑内部连续位置定位不属于当前POI候选展示契约。不要因颜色较深自行修改Top1。

## 6. 算法开发验收要求

在对应原有测试中维护原始8罐兼容性，包括候选ID、rank、得分字段、原坐标、去重、失败恢复和10条批次边界；保持Ground Truth不进入推理。

扩展验证需覆盖住宅楼、社区、商业/公共设施及道路/路口参照；检查稳定ID、别名歧义、父子关系、can_post和候选资格分离、LOCAL/CITY仅转换一次、方向/半径边界、空候选、连续批次和最终rank=1。准确性必须用修改后的真实算法输出与已知标注比较，不能用前端模拟rank/score证明支持。

地图、POI、行人网络及前端展示已经完成，无需重新开发。消防站和3个资源在空间数据中仅预留；前端已有四车两机的演练仿真和真实消息接入契约，真实调度、寻路与资源优化属于后续独立任务。
