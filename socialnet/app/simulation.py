# 仿真领域引擎：推进时间、生成单火源、安排居民发言、本地发现并按需监测。
# 社区间并行、社区内顺序生成；整步成功后才提交消息与报告，存储和通知由 main 协调。

from __future__ import annotations

import asyncio
import math
import random
from copy import deepcopy
from dataclasses import asdict
from datetime import UTC, datetime
from uuid import uuid4

from .agents import FireObservation, MonitorAgent, ResidentAgent, ResidentContext
from .llm import AgentGenerationError
from .dialogue import DAILY_TOPICS
from .expression import ObservationRecord
from .models import ChatMessage, Community, DiscoveryRecord, EvidenceSignal, Fire, FirePolicy, GenerationIssue, MapEntity, MonitorReport, Point, Resident, SimulationState
from .world import create_entities, create_map_metadata, create_residents
from .spatial import ROADS
from .event_discovery import EventDiscovery, MONITOR_CATEGORIES, monitor_context


# 气味、烟雾和火光独立抽样的平滑启发式概率，不模拟风场、遮挡或烟气输运。
def perception_probabilities(distance: float, intensity: int) -> dict[EvidenceSignal, float]:
    """Independent smooth sandbox heuristics, not a smoke/visibility physics model."""
    strength = (max(1, min(5, intensity)) - 1) / 4
    distance = max(0, distance)
    # Peak probability and distance scale evolve continuously with intensity.
    curves = {
        "odor": (0.70 + 0.20 * strength, 14 + 4 * strength),
        "smoke": (0.80 + 0.15 * strength, 23 + 6 * strength),
        "flame": (0.06 + 0.84 * strength, 11 + 11 * strength),
    }
    return {signal: peak * math.exp(-(distance / scale) ** 2)
            for signal, (peak, scale) in curves.items()}


# 保存世界和仿真业务状态，模型只负责发言与监测，存档/通信交由宿主协调。
class SimulationEngine:
    # 建立规范地图、居民及各自随机流；不同社区独立抽样，便于恢复与可重复测试。
    def __init__(self, seed: int = 7, fire_policy: FirePolicy | None = None, *, posts_only: bool = False) -> None:
        self.seed = seed
        self.random = random.Random(seed)
        self.fire_random = random.Random(seed)
        self.fire_policy = fire_policy or FirePolicy()
        self.entities = create_entities()
        self.map_metadata = create_map_metadata()
        self.residents = create_residents()
        self._entity_by_id = {entity.id: entity for entity in self.entities}
        self.communities = [Community(
            id=area_id, name=self._entity_by_id[area_id].name,
            resident_ids=[r.id for r in self.residents if r.community_id == area_id],
            building_ids=list(dict.fromkeys(r.building_id for r in self.residents if r.community_id == area_id)),
        ) for area_id in dict.fromkeys(r.community_id for r in self.residents)]
        self.community_random = {c.id: random.Random(f"{seed}:{c.id}") for c in self.communities}
        self.chat_totals = {c.id: 0 for c in self.communities}
        self._message_sequence = 0
        self._report_sequence = 0
        self._observations: dict[tuple[str, str], list[ObservationRecord]] = {}
        self.agents = {resident.id: ResidentAgent(resident, seed) for resident in self.residents}
        self.monitor = None if posts_only else MonitorAgent()
        self.running = False
        self.generation_error: GenerationIssue | None = None
        self.simulation_minute = 0
        self.fires: list[Fire] = []
        self.chats: list[ChatMessage] = []
        self.reports: list[MonitorReport] = []
        self._reported_message_ids: set[str] = set()
        self.localization_outbox: list[dict] = []
        self.discovery = EventDiscovery()
        self.discovery_pending = []
        self.lock = asyncio.Lock()

    # 在沙盘平面计算欧氏距离，不采用道路网络距离。
    @staticmethod
    def _distance(a: Point, b: Point) -> float:
        return math.hypot(a.x - b.x, a.y - b.y)

    # 优先使用登记中心；包围盒中心仅作兼容缺少 position 的对象。
    def _building_center(self, entity: MapEntity) -> Point:
        return entity.position or Point(x=entity.x + entity.width / 2, y=entity.y + entity.height / 2)

    # 只选住宅楼，工业建筑不分配居民，也不作为最近住宅候选。
    @property
    def buildings(self) -> list[MapEntity]:
        return [entity for entity in self.entities if entity.entity_type == "residential_building"]

    # 在建筑、储罐和设施登记中心中寻找最近实体。
    def nearest_poi(self, point: Point) -> MapEntity:
        return min((entity for entity in self.entities if entity.kind in ("building", "tank", "pipeline") and entity.position), key=lambda entity: self._distance(entity.position, point))

    # 寻找距离指定点最近的住宅，而非最近的任意建筑。
    def nearest_building(self, point: Point) -> MapEntity:
        return min(self.buildings, key=lambda item: self._distance(self._building_center(item), point))

    # 已有任何真实火源时恒为零；无火源时使用 base_probability。
    @property
    def next_fire_probability(self) -> float:
        # Temporarily keep a single active incident for the integrated locator.
        if self.fires:
            return 0.0
        return self.fire_policy.base_probability

    # 按独立火源随机流触发并从储罐中选点，位置使用登记中心。
    def _maybe_spawn_fire(self) -> Fire | None:
        probability = self.next_fire_probability
        if probability <= 0 or self.fire_random.random() >= probability:
            return None
        available = [e for e in self.entities if e.kind == "tank"
                     and e.id not in {f.nearest_poi_id for f in self.fires}]
        if not available:
            return None
        return self.ignite_tank(self.fire_random.choice(available).id)

    def ignite_tank(self, poi_id: str) -> Fire:
        poi = self._entity_by_id.get(poi_id)
        if not poi or poi.kind != "tank" or self.fires:
            raise ValueError("必须指定一个有效储罐，且当前没有其他火源")
        area = self._entity_by_id[poi.area_id]
        point = poi.position.model_copy()
        fire = Fire(
            id=f"fire-{uuid4().hex[:8]}",
            position=point,
            intensity=1,
            started_at=datetime.now(UTC),
            started_minute=self.simulation_minute,
            area_id=area.id,
            nearest_building_id=self.nearest_building(point).id,
            nearest_poi_id=poi.id,
        )
        self.fires.append(fire)
        return fire

    # 把住宅到火源的向量量化为八方位；正 X 为东、正 Y 为北。
    @staticmethod
    def _direction(origin: Point, target: Point) -> str:
        angle = math.degrees(math.atan2(target.y - origin.y, target.x - origin.x))
        return ("东", "东北", "北", "西北", "西", "西南", "南", "东南")[int((angle + 22.5) % 360 // 45)]

    # 从真实火源生成私有感知素材，只有视觉线索可获方位；公开表达仍由 expression 选择。
    def _observation(self, resident: Resident, fire: Fire, rng: random.Random) -> FireObservation | None:
        distance = self._distance(resident.position, fire.position)
        probabilities = perception_probabilities(distance, fire.intensity)
        signals = [signal for signal, probability in probabilities.items() if rng.random() < probability]
        if not signals:
            return None
        area = self._entity_by_id[fire.area_id]
        poi = self._entity_by_id.get(fire.nearest_poi_id)
        road = ROADS[resident.community_id]
        visual = "smoke" in signals or "flame" in signals
        location = "华安能源储运园方向" if visual else ""
        landmarks = ["华安能源储运园"] if visual else []
        recognizes_area = visual and rng.random() < 0.95 * math.exp(-(distance / 18) ** 2)
        if recognizes_area:
            location = f"{road}另一侧的{area.name}一带"
            landmarks = [road, area.name]
        if recognizes_area and "flame" in signals and poi and resident.observation_style == "detailed":
            location += f"，靠近{poi.name}的位置"
            landmarks.append(poi.name)
        cues = {
            "odor": ["一阵烟味", "有点刺鼻的焦味", "断断续续的烧焦味"],
            "smoke": ["有一缕灰烟往上冒", "出现一小股烟柱", "有烟断续冒出来"] if fire.intensity <= 2 else ["有连续的浓烟往上冒", "有较粗的连续烟柱", "上空积着一片较深的烟"],
            "flame": ["能看见闪动的火光", "有一处可见的明火", "能看见局部亮起的火光"],
        }
        if "flame" in signals:
            severity = "火光可见，担心有明显燃烧，但范围和具体起火点不清楚"
        elif "smoke" in signals:
            severity = "烟量看起来还不大，是否起火需要核实" if fire.intensity <= 2 else "有持续的烟柱，烟量比较大，担心异常在加重"
        else:
            severity = "只有气味线索，未确认现场状态，是否起火未知"
        return FireObservation(
            signals=signals, direction=self._direction(resident.position, fire.position) if visual else "",
            location_hint=location, cues={signal: cues[signal] for signal in signals},
            severity_hint=severity,
            vantage=self._entity_by_id[resident.building_id].name + "的窗边",
            proximity_hint="就在道路对面不算远的地方" if distance < 9 else "隔着道路能望见，但细节不完全清楚" if distance < 13 else "望过去比较远，细节不容易辨认",
            landmarks=landmarks, smoke_amount=("thin" if fire.intensity <= 2 else "dense") if "smoke" in signals else None,
        )

    # 按兴趣加权，并避开近期/本人重复话题；宠物和孩子话题要求家庭设定匹配。
    def _daily_topic(self, resident: Resident, history: list[ChatMessage], rng: random.Random) -> str:
        recent = {m.topic_key for m in history[-8:] if m.intent == "daily_new"}
        own = {m.topic_key for m in history if m.resident_id == resident.id}
        def fits(key):
            interest = DAILY_TOPICS[key][0]
            return (interest != "pets" or any(word in resident.household for word in ("猫", "狗"))) and (interest != "school" or any(word in resident.household for word in ("孩子", "儿", "幼儿", "小学生", "孙")))

        allowed = [key for key in DAILY_TOPICS if fits(key)]
        candidates = [key for key in allowed if key not in recent and key not in own]
        if not candidates:
            candidates = [key for key in allowed if key not in recent] or allowed
        weights = [3 if DAILY_TOPICS[key][0] in resident.interests else 0.5 for key in candidates]
        return rng.choices(candidates, weights=weights, k=1)[0]

    # 同一社区内顺序生成日常话题、可选观察和回复，让回复能看到本轮已生成原帖。
    async def _community_tick(self, community: Community, observed_fire: Fire | None) -> list[ChatMessage]:
        rng = self.community_random[community.id]
        residents = [r for r in self.residents if r.community_id == community.id]
        history = [m for m in self.chats if m.community_id == community.id]
        messages: list[ChatMessage] = []
        used: set[str] = set()

        async def emit(resident, intent, topic_key, observation=None, target=None):
            building = self._entity_by_id[resident.building_id]
            fire = observed_fire if observation else next((f for f in self.fires if target and f.id == target.fire_id), None)
            distance = self._distance(resident.position, fire.position) if fire else None
            context = ResidentContext(
                resident=resident,
                building=building,
                fire=fire,
                distance_to_fire=distance,
                is_nearest_building=bool(fire and resident.building_id == fire.nearest_building_id),
                simulation_minute=self.simulation_minute,
                fire_location=self._entity_by_id[fire.nearest_poi_id].name if fire and fire.nearest_poi_id else "",
                community_name=community.name, intent=intent, topic_key=topic_key,
                recent_messages=history[-16:], own_messages=[m for m in history if m.resident_id == resident.id][-8:],
                observation=observation, reply_to=target,
                previous_observations=list(self._observations.get((resident.id, fire.id), [])) if observation else [],
            )
            agent = self.agents[resident.id]
            content = await agent.speak(context)
            public = agent.last_evidence_quotes if observation else {}
            public_signals = [s for s in ("odor", "smoke", "flame") if s in public]
            topic = "fire" if observation else "safety" if target and target.topic != "daily" else "daily"
            message_id = f"msg-{uuid4().hex[:10]}"
            message = ChatMessage(
                id=message_id,
                timestamp=datetime.now(UTC),
                simulation_minute=self.simulation_minute,
                resident_id=resident.id,
                resident_name=resident.name,
                building_id=building.id,
                building_name=building.name,
                unit=resident.unit,
                position=resident.position,
                content=content.strip(),
                topic=topic,
                fire_id=fire.id if observation else target.fire_id if target and target.topic != "daily" else None,
                community_id=community.id, intent=intent, topic_key=topic_key,
                thread_id=target.thread_id if target else message_id, reply_to_id=target.id if target else None,
                reply_to_name=target.resident_name if target else "", reply_quote=target.content[:100] if target else "",
                # Keep the old scalar only as a compatibility summary.
                evidence_level=next((s for s in ("flame", "smoke", "odor") if s in public_signals), "none") if observation else "hearsay" if target and target.topic != "daily" else "none",
                evidence_signals=public_signals,
                evidence_source="direct" if observation and public_signals else "hearsay" if target and target.topic != "daily" else "none",
                evidence_quotes=public, expression_kind=agent.last_expression_kind if observation else None,
                corroborates_message_id=agent.last_corroboration_id if observation else None,
                generation_source=self.agents[resident.id].last_source,
                generation_attempts=agent.last_attempts,
            )
            if observation:
                key = (resident.id, fire.id)
                self._observations[key] = (context.previous_observations + [ObservationRecord(self.simulation_minute, observation)])[-8:]
            history.append(message)
            messages.append(message)
            used.add(resident.id)

        # 先安排生活话题，再在有火源时挑选较近居民尝试观察；无感知则仍谈日常。
        recent_speakers = {m.resident_id for m in history[-4:]}
        daily_speaker = rng.choice([r for r in residents if r.id not in recent_speakers] or residents)
        await emit(daily_speaker, "daily_new", self._daily_topic(daily_speaker, history, rng))
        if observed_fire:
            available = [r for r in residents if r.id not in used]
            closest = min(self._distance(r.position, observed_fire.position) for r in available)
            observer = rng.choice([r for r in available if self._distance(r.position, observed_fire.position) <= closest + 1.2])
            observation = self._observation(observer, observed_fire, rng)
            if observation:
                await emit(observer, "observation", "fire", observation=observation)
            else:
                await emit(observer, "daily_new", self._daily_topic(observer, history, rng))
        # A reply can refer to this round or earlier threads, never another community.
        reply_speaker = rng.choice([r for r in residents if r.id not in used])
        targets = [m for m in history[-20:] if m.resident_id != reply_speaker.id]
        fire_targets = [m for m in targets if m.topic != "daily" and any(f.id == m.fire_id for f in self.fires)]
        daily_targets = [m for m in targets if m.topic == "daily"]
        pool = fire_targets if fire_targets and rng.random() < 0.4 else daily_targets
        pool = pool or targets
        replied = {m.reply_to_id for m in history}
        weights = [3 if m.id not in replied and any(word in m.content for word in ("？", "?", "吗", "有没有")) else 1 for m in pool]
        target = rng.choices(pool, weights=weights, k=1)[0]
        await emit(reply_speaker, "reply", target.topic_key, target=target)
        return messages

    # 预检所有居民及监测模型，配置失败则暂停而不推进时钟。
    def prepare_generation(self) -> bool:
        try:
            for agent in self.agents.values():
                agent.ensure_configured()
            if self.monitor is not None:
                self.monitor.ensure_configured()
        except AgentGenerationError as error:
            self.running = False
            self.generation_error = error.issue
            return False
        self.generation_error = None
        return True

    # 仅在模型配置通过后打开自动运行开关，实际推进由宿主循环调用 tick。
    def start(self) -> None:
        if self.prepare_generation():
            self.running = True

    # 每步推进 5 分钟，社区并行后统一监测；任一失败恢复时间、火源、观察和随机流。
    async def tick(self) -> None:
        if not self.prepare_generation():
            return
        # Communities generate concurrently, but a step is committed only as a whole.
        minute, fires, observations = self.simulation_minute, deepcopy(self.fires), deepcopy(self._observations)
        fire_rng = self.fire_random.getstate()
        room_rngs = {key: rng.getstate() for key, rng in self.community_random.items()}
        agent_rngs = {key: agent.random.getstate() for key, agent in self.agents.items()}
        self.simulation_minute += 5
        new_fire = self._maybe_spawn_fire()
        for fire in self.fires:
            fire.intensity = min(5, 1 + (self.simulation_minute - fire.started_minute) // 15)
        observed_fire = new_fire or (self.fires[(self.simulation_minute // 5 - 1) % len(self.fires)] if self.fires else None)
        # 跨社区并行，不共享各群临时消息；gather 全部成功后才生成本步监测。
        tasks = [asyncio.create_task(self._community_tick(c, observed_fire)) for c in self.communities]
        try:
            batches = await asyncio.gather(*tasks)
            new_messages = [m for batch in batches for m in batch]
            # 分配暂定序号但不推进已提交计数，失败时不留下发现记录或序号空洞。
            for offset, message in enumerate(new_messages, 1):
                message.sequence = self._message_sequence + offset
            staged_discovery = self.discovery.clone()
            discoveries = staged_discovery.scan(new_messages, self.chats, self.simulation_minute,
                                                 {c.id: c.name for c in self.communities})
            pending_reports = []
            if self.monitor is not None:
                monitor_ids = {r.message_id for r in discoveries if MONITOR_CATEGORIES.intersection(r.categories)}
                candidates = [m for m in new_messages if m.id in monitor_ids and m.id not in self._reported_message_ids]
                staged_discovery.record_routing(len(candidates))
                context = monitor_context(candidates, self.chats, new_messages)
                pending_reports = await self._monitor(candidates, context=context)
        except (Exception, asyncio.CancelledError) as error:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            # 取消并等待其他社区任务后恢复状态和随机流；外部已产生的模型请求费用无法回滚。
            self.simulation_minute, self.fires, self._observations = minute, fires, observations
            self.fire_random.setstate(fire_rng)
            for key, rng_state in room_rngs.items():
                self.community_random[key].setstate(rng_state)
            for key, rng_state in agent_rngs.items():
                self.agents[key].random.setstate(rng_state)
            self.running = False
            if isinstance(error, asyncio.CancelledError):
                raise
            self.generation_error = error.issue if isinstance(error, AgentGenerationError) else GenerationIssue(
                code="internal_error", message="生成流程发生异常，本步未提交，请检查服务。")
            return
        for message in new_messages:
            self._message_sequence += 1
            message.sequence = self._message_sequence
            self.chat_totals[message.community_id] += 1
        self.chats.extend(new_messages)
        self.discovery = staged_discovery
        # 完整本批记录独立交给数据库，不能只保存最近50条展示窗口。
        self.discovery_pending = discoveries
        for report in pending_reports:
            self._report_sequence += 1
            report.sequence = self._report_sequence
        self.reports = (self.reports + pending_reports)[-30:]
        self._reported_message_ids.update(message_id for report in pending_reports for message_id in report.related_message_ids)
        if pending_reports:
            by_id = {m.id: m for m in self.chats}
            ids = list(dict.fromkeys(mid for report in pending_reports for mid in report.related_message_ids))
            # Public original posts only. No hidden fire ID, intensity or perception is forwarded.
            # 只选监测实际引用的原帖，不传 fire_id、强度、坐标或私有观察；宿主持久化后再唤醒定位。
            self.localization_outbox.append({
                "report_ids": [r.id for r in pending_reports], "simulation_minute": self.simulation_minute,
                "posts": [{"id": mid, "simulation_minute": by_id[mid].simulation_minute,
                           "text": by_id[mid].content, "location_poi_id": by_id[mid].building_id,
                           "urgency": {"关注": "低", "警告": "中", "紧急": "高"}[
                               max((r for r in pending_reports if mid in r.related_message_ids),
                                   key=lambda r: {"关注": 0, "警告": 1, "紧急": 2}[r.severity]).severity]}
                          for mid in ids],
            })

        # 每群实时保留 120 条；总计数单独维护，数据库在每次提交时幂等追加完整历史。
        retained = {m.id for c in self.communities for m in [m for m in self.chats if m.community_id == c.id][-120:]}
        self.chats = [m for m in self.chats if m.id in retained]
        self._reported_message_ids.intersection_update(retained)

    # 把结构化事件转换为页面报告；来源住址坐标仅用于溯源，不推定火情在该住址。
    async def _monitor(self, messages: list[ChatMessage], *, context=None) -> list[MonitorReport]:
        candidates = [message for message in messages if message.id not in self._reported_message_ids]
        if not candidates:
            return []
        history = self.chats[-32:] if context is None else context
        result = await self.monitor.analyze(candidates, history=history)
        by_id = {message.id: message for message in [*history, *candidates]}
        reports = []
        for event in result.events:
            relevant = [by_id[item.message_id] for item in event.evidence]
            buildings = []
            for building_id in dict.fromkeys(message.building_id for message in relevant):
                building = self._entity_by_id[building_id]
                center = self._building_center(building)
                buildings.append({"id": building.id, "name": building.name, "x": center.x, "y": center.y})
            residents = [{"id": message.resident_id, "name": message.resident_name, "building": message.building_name,
                          "unit": message.unit, "x": message.position.x, "y": message.position.y} for message in relevant]
            evidence = [f"[{self._entity_by_id[message.community_id].name}] {message.resident_name}（{message.building_name}）：{item.quote}"
                        for item, message in zip(event.evidence, relevant)]
            reports.append(MonitorReport(id=f"report-{uuid4().hex[:8]}", timestamp=datetime.now(UTC), severity=event.severity,
                title=event.title, summary=event.summary, keywords=event.keywords, reasoning=event.reasoning,
                location_hint=event.location_hint, uncertainties=event.uncertainties,
                related_message_ids=[message.id for message in relevant], evidence=evidence, buildings=buildings, residents=residents,
                generation_attempts=self.monitor.last_attempts,
                status={"关注": "待核实", "警告": "持续监测", "紧急": "建议处置"}[event.severity]))
        return reports

    # 清除真实火源及相关观察记忆；历史聊天、报告和定位证据仍保留。
    def clear_fire(self, fire_id: str | None = None) -> None:
        if fire_id is None:
            self.fires.clear()
        else:
            self.fires = [fire for fire in self.fires if fire.id != fire_id]
        self._observations = {key: value for key, value in self._observations.items() if key[1] in {fire.id for fire in self.fires}}

    # 清空当前仿真数据并重置随机流，保留已设火源策略；宿主负责归档与新建定位会话。
    def reset(self) -> None:
        self.running = False
        self.generation_error = None
        self.simulation_minute = 0
        self.fires.clear()
        self.chats.clear()
        self.reports.clear()
        self._reported_message_ids.clear()
        self.localization_outbox.clear()
        self.discovery = EventDiscovery()
        self.discovery_pending = []
        self.random = random.Random(self.seed)
        self.fire_random = random.Random(self.seed)
        self.community_random = {c.id: random.Random(f"{self.seed}:{c.id}") for c in self.communities}
        self.chat_totals = {c.id: 0 for c in self.communities}
        self._message_sequence = 0
        self._report_sequence = 0
        self._observations.clear()
        for agent in self.agents.values():
            agent.random.seed(f"{self.seed}:{agent.resident.id}")

    # 组装有限窗口的实时领域快照；main 另外合并定位及持久化状态。
    def snapshot(self) -> SimulationState:
        return SimulationState(
            running=self.running,
            simulation_minute=self.simulation_minute,
            entities=self.entities,
            residents=self.residents,
            communities=self.communities,
            chat_totals=self.chat_totals,
            fires=self.fires,
            fire_policy=self.fire_policy,
            next_fire_probability=self.next_fire_probability,
            chats=self.chats,
            reports=self.reports,
            report_total=self._report_sequence,
            map=self.map_metadata,
            generation_error=self.generation_error,
            discovery=self.discovery.snapshot(),
        )

    # 保存完整续跑所需的随机流、观察和序号等状态，不序列化客户端或密钥。
    def checkpoint(self) -> dict:
        """JSON-only continuation state; does not contain clients or credentials."""
        return {
            "state": self.snapshot().model_dump(mode="json"), "seed": self.seed,
            "message_sequence": self._message_sequence, "report_sequence": self._report_sequence,
            "reported_ids": sorted(self._reported_message_ids), "outbox": deepcopy(self.localization_outbox),
            "random": self.random.getstate(), "fire_random": self.fire_random.getstate(),
            "community_random": {key: rng.getstate() for key, rng in self.community_random.items()},
            "agent_random": {key: agent.random.getstate() for key, agent in self.agents.items()},
            "observations": [{"resident_id": key[0], "fire_id": key[1],
                              "records": [asdict(record) for record in records]}
                             for key, records in self._observations.items()],
            "discovery": self.discovery.checkpoint(),
            "discovery_pending": [r.model_dump(mode="json") for r in self.discovery_pending],
        }

    # 校验单火源约束并恢复业务/随机状态；JSON 列表转回元组以满足 Random.setstate。
    def restore(self, data: dict, *, paused: bool = True) -> None:
        state = SimulationState.model_validate(data["state"])
        if len(state.fires) > 1:
            raise ValueError("存档不符合当前单火源规则")
        self.seed = data["seed"]
        self.residents, self.communities = state.residents, state.communities
        self.running = False if paused else state.running
        self.simulation_minute, self.fire_policy = state.simulation_minute, state.fire_policy
        self.fires, self.chats, self.reports = state.fires, state.chats, state.reports
        self.chat_totals, self.generation_error = state.chat_totals, state.generation_error
        self._message_sequence, self._report_sequence = data["message_sequence"], data["report_sequence"]
        self.discovery = EventDiscovery.restore(data.get("discovery"), minute=self.simulation_minute,
                                                 sequence=self._message_sequence)
        self.discovery_pending = [DiscoveryRecord.model_validate(row) for row in data.get("discovery_pending", [])]
        self._reported_message_ids = set(data["reported_ids"])
        self.localization_outbox = deepcopy(data["outbox"])
        def tuples(value):
            return tuple(tuples(item) for item in value) if isinstance(value, (list, tuple)) else value
        self.random.setstate(tuples(data["random"]))
        self.fire_random.setstate(tuples(data["fire_random"]))
        for key, value in data["community_random"].items():
            self.community_random[key].setstate(tuples(value))
        for resident in self.residents:
            self.agents[resident.id].resident = resident
            self.agents[resident.id].random.setstate(tuples(data["agent_random"][resident.id]))
        self._observations = {
            (row["resident_id"], row["fire_id"]): [ObservationRecord(
                minute=item["minute"], observation=FireObservation(**item["observation"])) for item in row["records"]]
            for row in data["observations"]}
