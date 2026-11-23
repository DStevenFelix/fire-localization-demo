# 世界定义与构造：从规范空间 JSON 创建实体、住宅住户及地图元数据。
# 当前使用登记中心坐标；几何组件与管线辅助函数属于保留实现，不参与当前实体构造。

from __future__ import annotations

import math

from .spatial import COMMUNITIES, load_spatial_model, load_city_scene, load_city_catalog, residential_pois, line_midpoint
from .models import MapEntity, MapGeometry, MapMetadata, POINeighbor, Point, Resident


RESIDENT_CAPACITY = {p["id"]: 4 for c in COMMUNITIES for p in residential_pois() if p["parent_id"] == c}

# Background, household, interests, voice, routine, and observation habits.
RESIDENT_PROFILES = [
    ("中学语文教师，喜欢记录邻里小事", "与伴侣及小学女儿同住", ["reading", "school", "plants"], "温和具体，偶尔用比喻，不长篇说教", "早晨送孩子，晚上备课", "cautious"),
    ("设备工程师，检修过工厂管线", "与伴侣同住，养一只猫", ["repair", "traffic", "pets"], "信息分条但不公文化，注意方位与不确定性", "白班，周末修小家电", "detailed"),
    ("社区护士，轮班工作", "独居，常帮邻居照顾老人", ["health", "food", "sleep"], "语气平静，先问具体情况，再给简短建议", "轮班休息，不总能及时回群", "practical"),
    ("退休纺织工，住这里十多年", "与老伴同住，孙子周末来", ["food", "plants", "exercise"], "口语亲切，会补充自己的小经历", "早起买菜，午后照顾盆栽", "casual"),
    ("配送员，熟悉周边街道", "与弟弟合住", ["traffic", "parcel", "food"], "短句直接，有时只发一句追问", "早晚配送，中午短暂回家", "casual"),
    ("社区志愿者，参与便民服务", "与父母同住", ["neighbors", "repair", "health"], "热心但不包办，会邀请别人一起商量", "上午办事，傍晚志愿服务", "practical"),
    ("企业会计，爱做家用账本", "与伴侣和读初中的儿子同住", ["budget", "school", "food"], "务实，常比较价格或询问实际体验", "工作日上班，晚上处理家务", "cautious"),
    ("设计专业大学生", "与姐姐合住", ["music", "exercise", "reading"], "轻松活泼，会接别人的梗，但不用固定口头禅", "课程不固定，晚上做作业", "casual"),
    ("图书馆管理员", "与母亲同住", ["reading", "neighbors", "plants"], "安静细腻，愿意认真回复小问题", "上午上班，傍晚散步", "cautious"),
    ("公交驾驶员", "与伴侣同住，孩子在外地", ["traffic", "exercise", "sleep"], "简洁，喜欢说自己实际经过的路段", "早班后午休，晚上早睡", "practical"),
    ("手工裁缝，接零散修改衣服的活", "独居，妹妹住附近", ["repair", "budget", "neighbors"], "慢条斯理，常提出一个可行的小办法", "上午接活，下午做手工", "detailed"),
    ("软件测试工程师，部分时间居家办公", "与室友合住", ["repair", "music", "parcel"], "随和，会追问细节，偶尔自嘲", "白天开线上会议，晚上听音乐", "cautious"),
    ("幼儿园老师", "与伴侣和幼儿同住", ["school", "food", "sleep"], "温柔，话题常带生活细节，但不总围着孩子说", "早出门，下午接孩子", "practical"),
    ("家电维修师傅", "与伴侣同住", ["repair", "budget", "traffic"], "说话利落，技术判断会说明依据", "白天上门维修，晚饭后回家", "detailed"),
    ("退休银行职员", "与老伴同住", ["exercise", "health", "reading"], "谨慎礼貌，习惯问清来源，不轻信传言", "晨练后读书，午后休息", "cautious"),
    ("摄影爱好者，经营线上小店", "独居，养一只小狗", ["pets", "plants", "parcel"], "注意视觉变化，描述细致，偶尔发短感叹", "白天处理订单，傍晚遛狗", "detailed"),
    ("服务区便利店店员", "与伴侣同住，父亲偶尔来住", ["food", "budget", "neighbors"], "爽快，喜欢分享小发现和回应求助", "轮班，休息日补家用", "casual"),
    ("物流调度员", "与伴侣及儿子同住", ["traffic", "parcel", "school"], "关注时间和位置，回复很直接", "白天值班，晚上辅导作业", "practical"),
    ("植物养护员", "与室友合住", ["plants", "weather", "exercise"], "话不多，愿意解释自己熟悉的事", "清晨上班，下午照顾盆栽", "detailed"),
    ("食堂厨师", "与伴侣同住", ["food", "budget", "repair"], "接地气，常用做饭的小经历开话题", "早班备餐，下午有空", "casual"),
    ("居家翻译，刚搬来不久", "独居，家人在外地", ["reading", "music", "neighbors"], "礼貌好奇，常请熟悉小区的人介绍", "白天居家工作，晚上散步", "cautious"),
    ("健身教练", "与妹妹合住", ["exercise", "health", "food"], "有精神，建议具体，不过度劝别人运动", "下午和晚上带课", "practical"),
    ("美容师，周一通常休息", "与伴侣和幼儿同住", ["budget", "school", "parcel"], "聊天自然，偶尔连续两句，但不写长段落", "白天上班，下班后接孩子", "casual"),
    ("化工专业研究生", "与同学合住", ["repair", "reading", "weather"], "观察细致，专业猜测会明确说尚未证实", "白天做实验，晚间读文献", "detailed"),
    ("退休电工", "与老伴同住", ["repair", "exercise", "neighbors"], "简短实在，会提醒先核实情况", "早晨散步，偶尔帮邻居维修", "practical"),
    ("咖啡店店员，喜欢弹吉他", "与室友同住", ["music", "food", "sleep"], "轻松，常给别人一条短回复，也会主动分享", "晚班较多，上午休息", "casual"),
    ("社区药店药师", "与母亲及孩子同住", ["health", "school", "plants"], "细心，先描述现象，不随意下结论", "白天工作，晚上陪家人", "cautious"),
    ("自由插画师", "与伴侣同住，养猫", ["pets", "reading", "weather"], "有画面感，语气随意，长短句交替", "居家工作，午后出门买东西", "detailed"),
    ("社区烘焙坊师傅，常研究面团发酵", "与丈夫和女儿同住", ["food", "school", "weather"], "亲切爽朗，喜欢问别人的实际体验", "清早备料，下午接孩子", "casual"),
    ("城市规划助理，刚参加工作", "与研究生室友合住", ["traffic", "reading", "exercise"], "会描述道路位置，但明确区分观察与猜测", "白天通勤，周末骑车", "detailed"),
    ("退休邮递员，熟悉邻里门牌", "与老伴同住，养猫", ["neighbors", "pets", "exercise"], "慢条斯理，常用短句回应邻居", "早起散步，下午看报", "cautious"),
    ("职业学校实训教师，擅长工具维修", "与妻子同住", ["repair", "budget", "reading"], "耐心具体，建议只讲熟悉的部分", "工作日上课，晚间修理物件", "practical"),
    ("超市理货员，经常值早班", "与姐姐和外甥同住", ["food", "parcel", "school"], "朴实直接，喜欢分享省事的小办法", "早班后午休，晚间做饭", "casual"),
    ("环境检测技术员，爱记录自然现象", "独居，养了几盆兰花", ["weather", "plants", "health"], "描述细致，不用职业身份替代现场证据", "白天采样，周末打理植物", "detailed"),
    ("社区活动策划，喜欢组织读书会", "与伴侣同住", ["neighbors", "reading", "music"], "爱接话，也尊重别人不参与的选择", "下午活动，晚上读书", "practical"),
    ("餐饮店收银员，正在学习摄影", "与弟弟合住", ["budget", "food", "weather"], "语气随意，偶尔一句短感叹", "午晚高峰上班，上午休息", "casual"),
    ("小学生家长，兼职线上客服", "与伴侣和儿子同住", ["school", "parcel", "sleep"], "先询问具体情况，不一口气问很多问题", "上午办公，下午接孩子", "cautious"),
    ("退休机械工，喜欢养花", "与老伴同住，孙女周末来", ["repair", "plants", "neighbors"], "简短务实，愿意分享亲手试过的做法", "早晨浇花，午后维修", "practical"),
    ("大学实验室管理员，热爱徒步", "与母亲同住", ["health", "exercise", "reading"], "表达克制，观察变化时会说清依据", "白班，下班后散步", "detailed"),
    ("宠物用品店经营者", "与伴侣同住，养狗", ["pets", "budget", "parcel"], "热心自然，不总把话题引回自己的店", "下午看店，晚上遛狗", "casual"),
    ("舞蹈教师，周末给孩子上课", "独居，家人在外地", ["exercise", "music", "food"], "轻快但不夸张，喜欢回应小发现", "下午授课，上午练习", "practical"),
    ("公交场站调度，关注道路通行", "与伴侣和女儿同住", ["traffic", "school", "sleep"], "短句清楚，遇到不确定的信息先追问", "轮班，休息日陪家人", "cautious"),
    ("旧书店店主，喜欢地方历史", "与妹妹同住", ["reading", "neighbors", "music"], "有耐心，偶尔用自己的小经历接话", "上午整理书，傍晚散步", "detailed"),
    ("园林专业学生，兼职植物养护", "与两位同学合住", ["plants", "weather", "budget"], "好奇，遇到不熟悉的问题会请教", "上课和兼职交替", "casual"),
    ("居家财务顾问，关注家庭日常", "与伴侣和幼儿同住", ["budget", "food", "school"], "语气平和，建议尽量具体", "白天办公，晚间照顾孩子", "cautious"),
    ("社区维修站学徒，喜欢拼装模型", "与父亲同住", ["repair", "music", "parcel"], "说话直接，专业判断会承认拿不准", "白天跟班，晚上做模型", "practical"),
    ("退休中学物理教师", "与老伴同住，养猫", ["reading", "pets", "health"], "认真但不说教，会区分事实与推测", "晨练后读书，下午买菜", "detailed"),
    ("家政服务协调员，熟悉社区生活", "与伴侣同住", ["neighbors", "food", "health"], "利落友善，不替别人作决定", "白天走访，傍晚回家", "practical"),
]


# 把坐标对转换为校验后的 Point，供规范道路及实体轮廓使用。
def _points(values: list[list[float]]) -> list[Point]:
    return [Point(x=x, y=y) for x, y in values]


# 保留的旧几何规格转换器；当前 create_entities 直接从规范 JSON 构造几何。
def _geometry(spec: dict) -> MapGeometry:
    return MapGeometry(
        shape=spec.get("shape", "rect"),
        style=spec.get("style", "default"),
        points=_points(spec.get("path", [])),
        components=spec.get("components", []),
        rotation=spec.get("rotation", 0),
    )


# 保留的布局中心算法，复合圆按半径平方加权；当前主链路使用规范登记中心。
def geometry_center(spec: dict) -> Point:
    """Use the current facility layout, not workbook anchors, for localization."""
    x, y, width, height = spec["bounds"]
    components = spec.get("components", [])
    if spec.get("shape") == "compound" and components:
        weights = [part["radius"] ** 2 for part in components]
        total = sum(weights)
        return Point(x=sum(p["x"] * w for p, w in zip(components, weights)) / total,
                     y=sum(p["y"] * w for p, w in zip(components, weights)) / total)
    return Point(x=x + width / 2, y=y + height / 2)


# 保留的旧管线布局解析，按设施中心锚点展开路线并计算含描边的包围盒。
def _pipeline_spec(spec: dict, facilities: dict) -> dict:
    """Resolve pipe axes from facility centers so layout changes move both."""
    if not spec["routes"] or any(len(route) < 2 for route in spec["routes"]):
        raise ValueError(f"Pipeline {spec['id']} needs at least two points per route")

    def coordinate(value, axis):
        if isinstance(value, (int, float)):
            return value
        ids = value["pois"]
        if not ids or any(poi_id not in facilities for poi_id in ids):
            raise ValueError(f"Invalid facility anchor in pipeline {spec['id']}: {ids}")
        return sum(getattr(geometry_center(facilities[poi_id]), axis) for poi_id in ids) / len(ids) + value.get("offset", 0)

    components = [{"shape": "polyline", "points": [
        {axis: coordinate(point[axis], axis) for axis in ("x", "y")}
        for point in route
    ]} for route in spec["routes"]]
    points = [point for component in components for point in component["points"]]
    # Include the 9 SVG-pixel pipe stroke at 40 pixels per sandbox meter.
    margin = 9 / 40 / 2
    xmin, ymin = (min(point[axis] for point in points) - margin for axis in ("x", "y"))
    xmax, ymax = (max(point[axis] for point in points) + margin for axis in ("x", "y"))
    return {**spec, "components": components, "bounds": [xmin, ymin, xmax - xmin, ymax - ymin]}


# 根据住宅容量生成稳定居民 ID，确保住户与地图实体的关联一致。
def _resident_ids(poi_id: str) -> list[str]:
    return [f"resident-{poi_id.removeprefix('POI-').lower()}-{i:02d}" for i in range(1, RESIDENT_CAPACITY.get(poi_id, 0) + 1)]


# 从已校验地图生成前端元信息，并明确当前坐标依据是 registered_center。
def create_map_metadata() -> MapMetadata:
    model = load_spatial_model()
    return MapMetadata(name="云港新区整城应急仿真片区", source="city_scene/poi_catalog.json",
                       coordinate_basis="registered_center", model_version=model["model_version"] + "+city-full-v3")


def create_entities() -> list[MapEntity]:
    """组合原始 90 项与扩展 325 项，所有中心及几何在此统一为 CITY90x75。"""
    model = load_spatial_model()
    dx, dy = load_city_scene()["original_map_placement"]["offset"]
    rows = []
    for collection in ("areas", "roads", "nodes", "pois"):
        for item in model[collection]:
            center = item.get("center") or line_midpoint(item["centerline"]["coordinates"])
            geometry = item.get("geometry", item.get("centerline", {"type": "Point", "coordinates": center}))
            kind = ("area" if collection == "areas" else "road" if collection == "roads" else
                    "intersection" if collection == "nodes" else "tank" if item["entity_type"] == "Tank" else
                    "pipeline" if item["entity_type"] == "Facility" else "building")
            rows.append((item, center, geometry, kind, dx, dy, "spatial_model"))
    kinds = {"community": "area", "functional_area": "area", "park": "area"}
    for item in load_city_catalog():
        rows.append((item, item["center"], item["geometry"], kinds.get(item["type"], item["type"]), 0, 0, "city_scene"))
    entities = []
    for row, center, geometry, kind, offset_x, offset_y, source in rows:
        def shift(points):
            return [Point(x=x + offset_x, y=y + offset_y) for x, y in points]
        geom_type, coordinates = geometry["type"], geometry["coordinates"]
        polygons = ([shift(coordinates[0])] if geom_type == "Polygon" else
                    [shift(polygon[0]) for polygon in coordinates] if geom_type == "MultiPolygon" else [])
        points = ([point for polygon in polygons for point in polygon] if polygons else
                  shift(coordinates) if geom_type == "LineString" else shift([coordinates]))
        xs, ys = [p.x for p in points], [p.y for p in points]
        entity_type = "residential_building" if row["id"] in RESIDENT_CAPACITY else row.get("category", row.get("entity_type", kind)).lower()
        entities.append(MapEntity(
            id=row["id"], name=row["name"], kind=kind, entity_type=entity_type,
            parent_id=row.get("parent_id"), area_id=row.get("community_id") or row.get("parent_id"),
            x=min(xs), y=min(ys), width=max(xs)-min(xs), height=max(ys)-min(ys),
            position=Point(x=center[0]+offset_x, y=center[1]+offset_y), source_position=Point(x=center[0], y=center[1]),
            aliases=row.get("aliases", []), residents=_resident_ids(row["id"]),
            path=points if kind == "road" else [],
            geometry=MapGeometry(shape="polyline" if kind == "road" else "rect", points=points,
                                 polygons=polygons, style=entity_type), source=source))
    pois = [e for e in entities if e.kind in ("building", "tank", "pipeline")]
    for poi in pois:
        nearest = sorted((p for p in pois if p.id != poi.id),
                         key=lambda p: math.dist((poi.position.x, poi.position.y), (p.position.x, p.position.y)))[:2]
        poi.neighbors = [POINeighbor(id=p.id, distance=math.dist(
            (poi.position.x, poi.position.y), (p.position.x, p.position.y))) for p in nearest]
    return entities


# 按住宅和固定顺序分配 300 个角色档案，居民位置固定为所属住宅登记中心。
def create_residents() -> list[Resident]:
    names = [
        "许知夏", "蒋文博", "陆锦然", "陶慧芳", "顾明哲", "夏清禾", "董雅萍", "邹承安",
        "罗思宁", "傅嘉树", "郑美玲", "邵远航", "梁悦然", "宋景川", "冯淑兰", "姜一帆",
        "程书瑶", "任启明", "魏晓棠", "韩柏舟", "杜静宜", "姚志成", "苏予安", "秦星月",
        "袁嘉辰", "蔡舒云", "贺东阳", "白婉宁", "林若溪", "陈景行", "周桂芬", "叶承泽",
        "沈知遥", "何雨澄", "邓嘉宁", "吴向晨", "方念初", "赵守诚", "孟书言", "刘星河",
        "杨清妍", "高远川", "施文静", "唐夏青", "江晓言", "马致远", "徐怀安", "余秋禾",
    ]
    ages = [35, 42, 30, 66, 28, 39, 44, 22, 37, 52, 58, 29, 32, 46, 64, 33,
            36, 41, 27, 48, 31, 26, 34, 24, 67, 25, 40, 30,
            38, 25, 65, 43, 34, 29, 36, 27, 39, 68, 45, 33, 28, 46, 52, 23, 40, 22, 66, 37]
    # 保留原 48 人的人设与 ID；新增角色按稳定住宅顺序分配唯一姓名及轮换档案。
    original_names = set(names)
    family_names = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗方俞任袁柳"
    given_names = ["明远", "思涵", "景宁", "若安", "文清", "知行", "雨桐", "承泽", "以宁", "沐言", "书禾", "星澜"]
    extra_names = [family + given for family in family_names for given in given_names
                   if family + given not in original_names]
    by_id = {p["id"]: p for p in residential_pois()}
    residents = []
    for poi_id in RESIDENT_CAPACITY:
        poi = by_id[poi_id]
        for number, resident_id in enumerate(_resident_ids(poi_id), 1):
            index = len(residents)
            profile_index = index % len(RESIDENT_PROFILES)
            background, household, interests, voice, routine, observation = RESIDENT_PROFILES[profile_index]
            if index >= len(names):
                background += "，居住在" + poi["name"]
            residents.append(Resident(
                id=resident_id, name=names[index] if index < len(names) else extra_names[index-len(names)], age=ages[profile_index],
                occupation=background.split("，", 1)[0], personality=voice,
                building_id=poi_id, unit=f"1-{100 + number}",
                position=Point(x=poi["center"][0], y=poi["center"][1]),
                community_id=poi["parent_id"], background=background, household=household,
                interests=interests, speaking_style=voice, daily_routine=routine,
                observation_style=observation,
            ))
    return residents
