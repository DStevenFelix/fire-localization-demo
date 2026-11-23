# 应用数据契约：Pydantic 模型用于校验、HTTP/WebSocket 序列化和检查点恢复。
# 同一快照包含仿真真值和公开业务信息；监测与定位输入由上层显式筛选，不能直接转发整个快照。

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


# 90×75 整城内的坐标，西南原点；这是演示尺度，不是实测地理坐标。
class Point(BaseModel):
    x: float = Field(ge=0, le=90)
    y: float = Field(ge=0, le=75)


# 复合几何中的基础图形描述，保留矩形、圆和折线参数。
class MapShape(BaseModel):
    shape: Literal["rect", "circle", "polyline"] = "rect"
    x: float = 0
    y: float = 0
    width: float = 0
    height: float = 0
    radius: float = 0
    points: list[Point] = Field(default_factory=list)


# 地图绘制结构，包含路径、组件、样式及旋转；不等同于定位登记中心。
class MapGeometry(BaseModel):
    shape: Literal["rect", "circle", "compound", "polyline"] = "rect"
    style: str = "default"
    points: list[Point] = Field(default_factory=list)
    components: list[MapShape] = Field(default_factory=list)
    rotation: float = 0
    polygons: list[list[Point]] = Field(default_factory=list)


# 相邻实体摘要；距离来自规范中心，不表示道路通行距离。
class POINeighbor(BaseModel):
    id: str
    distance: float


# 前后端共享的底图尺寸、坐标及来源信息；实际运行值由 world 构造覆盖部分默认值。
class MapMetadata(BaseModel):
    name: str = "云港新区应急仿真片区"
    width: float = 90
    height: float = 75
    unit: str = "m"
    origin: str = "southwest"
    source: str = "fire_poi/fire_sandbox_spatial_model.json"
    coordinate_basis: str = "geometry_center"
    query_rules: dict[str, float] = Field(default_factory=dict)
    image_url: str = "/map-assets/map_original.png"
    image_width: int = 1313
    image_height: int = 1050
    model_version: str = ""
    coordinate_system: str = "CITY90x75"
    scene_width: int = 3939
    scene_height: int = 3150
    original_offset: Point = Field(default_factory=lambda: Point(x=30, y=25))


# 居民角色及所属住宅/社区，包含模型使用的人设和表达偏好。
class Resident(BaseModel):
    id: str
    name: str
    age: int
    occupation: str
    personality: str
    building_id: str
    unit: str
    position: Point
    community_id: str
    background: str = ""
    household: str = ""
    interests: list[str] = Field(default_factory=list)
    speaking_style: str = ""
    daily_routine: str = ""
    observation_style: Literal["cautious", "detailed", "casual", "practical"] = "cautious"


# 社区成员与住宅 ID 集合，用于独立群聊安排及界面切换。
class Community(BaseModel):
    id: str
    name: str
    resident_ids: list[str]
    building_ids: list[str]


# 统一地图实体，兼容旧几何字段；position 是当前定位和感知使用的登记中心。
class MapEntity(BaseModel):
    id: str
    name: str
    kind: Literal["area", "building", "tank", "tank_group", "road", "intersection", "pipeline", "entrance", "node", "reserve", "facility"]
    x: float
    y: float
    width: float
    height: float
    residents: list[str] = Field(default_factory=list)
    entity_type: str = ""
    area_id: str | None = None
    parent_id: str | None = None
    position: Point | None = None
    source_position: Point | None = None
    aliases: list[str] = Field(default_factory=list)
    neighbors: list[POINeighbor] = Field(default_factory=list)
    path: list[Point] = Field(default_factory=list)
    geometry: MapGeometry = Field(default_factory=MapGeometry)
    source: Literal["workbook", "inferred", "spatial_model", "city_scene"] = "spatial_model"


# 仿真真实火源；位置和强度仅用于模拟感知/展示，不转发给定位算法。
class Fire(BaseModel):
    id: str
    position: Point
    intensity: int = 1
    started_at: datetime
    started_minute: int
    area_id: str
    nearest_building_id: str
    nearest_poi_id: str | None = None


# 后台定位任务摘要，记录关联原帖/报告、状态、尝试次数、耗时与重放标志。
class LocalizationJob(BaseModel):
    id: str
    report_ids: list[str]
    message_ids: list[str]
    simulation_minute: int
    status: Literal["queued", "running", "completed", "failed"] = "queued"
    attempts: int = 0
    error: str | None = None
    elapsed_ms: float | None = None
    replayed: bool = False


# 定位会话公开状态；revision 标记增量顺序，prediction 保存最后可用预测。
class LocalizationState(BaseModel):
    session_id: str = ""
    revision: int = 0
    status: Literal["idle", "queued", "running", "completed", "failed"] = "idle"
    jobs: list[LocalizationJob] = Field(default_factory=list)
    prediction: dict | None = None
    clusters: list[dict] = Field(default_factory=list)
    error: str | None = None
    resume_pending: bool = False
    # 新版每候选独立证据窗，供前端同步判断过期；旧存档保留其原算法窗口。
    cold_minutes: int = 30


EvidenceSignal = Literal["odor", "smoke", "flame"]
EvidenceComponent = Literal["odor", "smoke", "flame", "self_location", "direction", "landmark", "change", "corroboration"]


# 原帖及展示元数据；其中含内部 fire_id，监测/定位必须显式筛选公开字段。
class ChatMessage(BaseModel):
    id: str
    timestamp: datetime
    simulation_minute: int
    resident_id: str
    resident_name: str
    building_id: str
    building_name: str
    unit: str
    position: Point
    content: str
    topic: Literal["daily", "fire", "safety"] = "daily"
    # 内部关联字段，供仿真回复与观察记忆使用，不进入监测和定位的公开输入。
    fire_id: str | None = None
    community_id: str
    # 全局单调消息序号用于数据库分页，不随每群实时窗口裁剪而重置。
    sequence: int = 0
    intent: Literal["daily_new", "observation", "reply"] = "daily_new"
    topic_key: str = ""
    thread_id: str = ""
    reply_to_id: str | None = None
    reply_to_name: str = ""
    reply_quote: str = ""
    evidence_level: Literal["none", "odor", "smoke", "flame", "hearsay"] = "none"
    evidence_signals: list[EvidenceSignal] = Field(default_factory=list)
    evidence_source: Literal["none", "direct", "hearsay"] = "none"
    # 当前为计划与正文的轻量匹配结果，不是居民返回的结构化 claims 或独立事实核验。
    evidence_quotes: dict[EvidenceComponent, str] = Field(default_factory=dict)
    expression_kind: str | None = None
    corroborates_message_id: str | None = None
    generation_source: Literal["llm"] = "llm"
    generation_attempts: int = Field(default=1, ge=1)


DiscoveryCategory = Literal["fire", "gas", "traffic", "flood", "facility", "security", "rescue"]
DiscoveryFlag = Literal["uncertain", "hearsay", "contextual_reply"]


class DiscoveryReason(BaseModel):
    """本地规则的可回查命中，不是模型生成的解释或事实确认。"""
    category: DiscoveryCategory
    rule: str
    excerpt: str
    source_message_id: str


class DiscoveryRecord(BaseModel):
    """一条公开原帖的多类别线索；不包含确认事件ID、真实火源或概率。"""
    message_id: str
    sequence: int = Field(ge=1)
    timestamp: datetime
    simulation_minute: int
    resident_id: str
    resident_name: str
    community_id: str
    community_name: str
    content: str
    categories: list[DiscoveryCategory]
    reasons: list[DiscoveryReason]
    flags: list[DiscoveryFlag] = Field(default_factory=list)
    rule_version: str


class DiscoveryWindowStat(BaseModel):
    """作者和社区只按公开身份计数，转述作者也计入，不能解释为独立目击者。"""
    category: DiscoveryCategory
    candidate_count: int = Field(default=0, ge=0)
    author_count: int = Field(default=0, ge=0)
    community_count: int = Field(default=0, ge=0)
    duplicate_count: int = Field(default=0, ge=0)


class DiscoveryState(BaseModel):
    """累计进度不随窗口裁剪清零；完整记录在数据库，快照只携带最近50条。"""
    rule_version: str = "local-rules-v1"
    started_minute: int = Field(default=0, ge=0)
    started_sequence: int = Field(default=0, ge=0)
    last_processed_sequence: int = Field(default=0, ge=0)
    scanned_total: int = Field(default=0, ge=0)
    candidate_total: int = Field(default=0, ge=0)
    # 火灾/燃气原帖送入监测的累计数量；不是已确认火灾数或模型请求次数。
    forwarded_total: int = Field(default=0, ge=0)
    skipped_monitor_steps: int = Field(default=0, ge=0)
    window_minutes: Literal[15] = 15
    window_stats: list[DiscoveryWindowStat] = Field(default_factory=list, max_length=7)
    recent_candidates: list[DiscoveryRecord] = Field(default_factory=list, max_length=50)


# 由公开聊天生成的监测报告；buildings/residents 是报告来源，不能当作确认起火点。
class MonitorReport(BaseModel):
    id: str
    sequence: int = 0
    timestamp: datetime
    severity: Literal["关注", "警告", "紧急"]
    title: str
    summary: str
    keywords: list[str]
    related_message_ids: list[str]
    evidence: list[str]
    buildings: list[dict]
    residents: list[dict]
    # 兼容保留的真值相关字段；当前监测报告构造不据真实火源填写它们。
    fire_position: Point | None = None
    fire_ids: list[str] = Field(default_factory=list)
    fire_positions: list[Point] = Field(default_factory=list)
    status: Literal["待核实", "持续监测", "建议处置"]
    reasoning: str = ""
    location_hint: str = "位置尚不明确"
    uncertainties: list[str] = Field(default_factory=list)
    generation_source: Literal["llm"] = "llm"
    generation_attempts: int = 1


# 首发概率设置；suppression_factor 仅保留旧接口兼容，单火源模式不使用它。
class FirePolicy(BaseModel):
    base_probability: float = Field(default=0.30, ge=0, le=1)
    suppression_factor: float = Field(default=0.25, ge=0, lt=1,
                                      description="兼容旧版设置；单火源模式下不参与生成概率")


# 可展示的生成故障，区分居民与监测，不包含提供商凭据或原始响应。
class GenerationIssue(BaseModel):
    code: Literal["missing_key", "timeout", "request_failed", "validation_failed", "internal_error"]
    message: str
    resident_id: str = ""
    resident_name: str = ""
    attempts: int = 0
    reason: str = ""
    agent_role: Literal["resident", "monitor"] = "resident"
    timeout_seconds: float | None = None


# 保存状态和轮次标识；activation_id 区分同一存档的不同激活，sequence 阻止旧状态倒灌。
class PersistenceState(BaseModel):
    enabled: bool = False
    run_id: str = ""
    saved_at: datetime | None = None
    restored: bool = False
    error: str | None = None
    # 即使切回同一 run_id 也会更换激活令牌，用于拒绝前一次激活遗留的请求。
    activation_id: str = ""
    activation_sequence: int = 0


# 切档时携带调用方认为的当前轮次，由后端检查并发冲突。
class ActivateRunRequest(BaseModel):
    expected_run_id: str = Field(min_length=1, max_length=64)


# 完整实时快照，聊天/报告仅有限窗口；完整历史通过独立分页接口读取。
class SimulationState(BaseModel):
    running: bool
    simulation_minute: int
    entities: list[MapEntity]
    residents: list[Resident]
    communities: list[Community]
    chat_totals: dict[str, int]
    fires: list[Fire]
    fire_policy: FirePolicy = Field(default_factory=FirePolicy)
    next_fire_probability: float = 0.30
    chats: list[ChatMessage]
    reports: list[MonitorReport]
    report_total: int = 0
    persistence: PersistenceState = Field(default_factory=PersistenceState)
    map: MapMetadata = Field(default_factory=MapMetadata)
    generation_error: GenerationIssue | None = None
    localization: LocalizationState = Field(default_factory=LocalizationState)
    discovery: DiscoveryState = Field(default_factory=DiscoveryState)


# 前端可发送的四种控制动作，不直接接受任意时间或状态覆盖。
class SimulationCommand(BaseModel):
    action: Literal["start", "pause", "step", "reset"]


# 完整状态事件和定位增量/存档通知共用的 WebSocket 信封。
class SocketEvent(BaseModel):
    type: Literal["snapshot", "tick", "fire", "control", "reset", "localization", "archives"]
    state: SimulationState | None = None
    localization: LocalizationState | None = None
    persistence: PersistenceState | None = None

