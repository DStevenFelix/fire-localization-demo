# 公开证据表达层：从私有观察中选择可说的内容，生成提示词约束及页面标签。
# 当前链路使用纯文本生成和轻量标注；末尾的结构化 claims 校验仅为保留实现。

"""Select public evidence, build generation constraints and annotate displayed text."""

from dataclasses import asdict, dataclass, field
import random
import re

from pydantic import BaseModel, ConfigDict, Field

from .models import ChatMessage, EvidenceComponent, EvidenceSignal, Resident


# 只在本次选中的公开信号含视觉且有方向时抽取空间表达组，并非所有发言的 60%。
SPATIAL_DISCLOSURE_PROBABILITY = 0.60


# 引擎按距离/强度抽样得到的私有感知，后续仍须经过公开内容选择。
@dataclass(slots=True)
class FireObservation:
    signals: list[EvidenceSignal]
    direction: str
    location_hint: str
    cues: dict[EvidenceSignal, list[str]]
    severity_hint: str
    vantage: str
    proximity_hint: str
    landmarks: list[str] = field(default_factory=list)
    smoke_amount: str | None = None


# 居民对某火源的历史观察，供有依据的前后变化表达使用。
@dataclass(slots=True)
class ObservationRecord:
    minute: int
    observation: FireObservation


# 本次获准公开的感官、住址、方向和回应要素；不是模型已经说出的事实。
@dataclass(slots=True)
class ExpressionPlan:
    kind: str
    signals: list[EvidenceSignal]
    cues: dict[EvidenceSignal, list[str]]
    self_location: str | None = None
    direction: str | None = None
    landmark: str | None = None
    uncertainty: bool = False
    verification_request: bool = False
    personal_reaction: bool = False
    change: str | None = None
    corroboration: dict | None = None

    # 把计划转换为提示词可序列化的数据，不暴露完整私有观察。
    def public_facts(self):
        return asdict(self)

    # 将计划逐项转换为生成边界；住宅是观察参照，不能当作确认的起火点。
    def generation_rules(self) -> str:
        names = {"odor": "气味", "smoke": "烟雾", "flame": "火光"}
        allowed = "、".join(names[s] for s in self.signals)
        rules = [f"本轮只允许公开这些新感官线索：{allowed}。至少自然说出一种，不必全说。",
                 "未分配的感官线索不要声称察觉，也不要反向断言它不存在；历史消息不能扩大本轮权限。"]
        if self.self_location:
            rules.append(f"本人观察位置可说：{self.self_location}，可以自然说窗边或阳台，不额外编楼层、房号。本人住址不是异常地点。")
        else:
            rules.append("本轮不补充本人住址、楼层、观察位置，也不从角色档案或历史聊天中补入。")
        rules.append(f"异常只可描述为朝{self.direction}方向，不得再推导具体地点。" if self.direction
                     else "本轮不知道异常方位，不补东南西北、对面、楼下等位置推断。")
        if self.self_location and self.direction:
            rules.append(
                f"正文必须同时说出完整住宅名“{self.self_location}”和“{self.direction}”方位，"
                "明确是从该住宅观察到的异常方向，并至少描述一种获准的烟雾或火光。"
                "住宅是唯一命名参照，不省略社区名，不换成道路、罐区或储罐作为参照，"
                "不引用历史中的其他地点，不把方位改成对面、前面或风向。")
        rules.append(f"可提及的异常位置线索仅为：{self.landmark}；它是观察线索，不等于已确认起火点。" if self.landmark
                     else "本轮不能指认异常来自哪座工厂、作业区、储罐、道路或居民楼。")
        rules.append(f"本轮有前后变化证据：{self.change}，可以依此比较，不编持续时间。" if self.change
                     else "没有前次对比依据，不说越来越浓、刚才更小、一直持续等变化或时长。")
        if self.corroboration:
            peer = self.corroboration
            rules.append(f"可以回应{peer['speaker']}提到的{names[peer['signal']]}，并说自己也察觉到了；明确来源，不增加对方未说的细节。")
        else:
            rules.append("本轮说自己的观察，不额外引用邻居作为印证。")
        rules.append("可以自然表示不确定，不将猜测说成确认事实。" if self.uncertainty
                     else "不必机械追加免责声明。")
        rules.append("可以请求邻居核实或适度提醒。" if self.verification_request
                     else "本轮不追加核实请求或面向全群的提醒。")
        rules.append("可以提自己的应对打算，不能说已完成报警、撤离等动作。" if self.personal_reaction
                     else "本轮不追加自己的应对动作或打算。")
        return "\n".join(rules)

    # 只用本轮获准证据示范表达结构，样例不会替代模型返回的正文。
    def generation_examples(self) -> list[str]:
        """Prompt illustrations using public facts only, never generated-message fallbacks."""
        signals = self.signals
        if self.direction:
            signals = [s for s in signals if s in ("smoke", "flame")]
        if self.corroboration:
            signals = [s for s in signals if s == self.corroboration["signal"]]
        cues = [(signal, cue) for signal in signals for cue in self.cues.get(signal, [])]
        if not cues:
            return []
        examples = []
        for index, (signal, cue) in enumerate((cues[0], cues[-1])):
            phenomenon = "闻到" + cue if signal == "odor" and not cue.startswith("闻") else cue
            if self.self_location and self.direction:
                prefix = (f"我在{self.self_location}窗边，往{self.direction}方向看，" if index == 0
                          else f"从{self.self_location}望过去，{self.direction}边")
            else:
                prefix = f"我在{self.self_location}窗边，" if self.self_location else ""
            text = prefix + phenomenon + "。"
            if self.change:
                text += self.change + "。"
            if self.corroboration:
                text = f"@{self.corroboration['speaker']} 你提到的现象，我也察觉到了。" + text
            if self.uncertainty:
                text += "具体来源还不确定。"
            if self.verification_request:
                text += "有邻居能核实一下吗？"
            if self.personal_reaction:
                text += "我准备先把窗关好。"
            if text not in examples:
                examples.append(text)
        return examples


# 保留的结构化证据项，记录类型及逐字引文；当前居民不生成此结构。
class EvidenceClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: EvidenceComponent
    quote: str = Field(min_length=1, max_length=260)


# 旧结构化居民输出契约，仅供兼容校验及相关测试使用。
class ObservationUtterance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=260)
    claims: list[EvidenceClaim] = Field(min_length=1, max_length=8)


SIGNAL_PATTERNS = {
    "odor": r"烟味|焦味|烧焦味|异味|油味|刺鼻|呛鼻|闻[^，。！？；\n]{0,10}味",
    "smoke": r"灰烟|黑烟|浓烟|烟柱|冒烟|烟雾|(?<!油)烟(?!味|熏|机)",
    "flame": r"火光|明火|火焰|火苗",
}
SPATIAL_PATTERN = r"(?:\d+|[一二三四五六七八九十]+)号?(?:楼|层|罐)|窗[边外口]|阳台|楼下|楼上|道路|对面|园区|厂区|储运园|储罐|作业区|罐区|社区|锦安|东源|华安|[\u4e00-\u9fff]{1,8}(?:大道|路|街)|(?:东北|西北|东南|西南|东|南|西|北)(?:边|侧|方|面)|(?:往|朝|向|偏)[东西南北]"
CHANGE_PATTERN = r"刚才|之前|上次|变浓|变大|变多|变少|越来越|更浓|更大|更明显|持续了|一直|已经.*分钟"
REQUEST_PATTERN = r"有人|有没有|谁能|帮忙|核实|确认一下|留意|提醒|大家注意|不要靠近"
REACTION_PATTERN = r"(?:我|家里|家人).{0,8}(?:先|准备|打算)|关窗|把窗关|收回|撤离|报警"


# 匹配计划与正文的交集作为 UI 提示；既不拒绝正文，也不证明全文符合证据边界。
def annotate_public_text(text: str, plan: ExpressionPlan) -> dict[str, str]:
    """UI hints only: no rejection, repair, or claim that a statement was verified."""
    spans = {}
    for signal in plan.signals:
        match = re.search(SIGNAL_PATTERNS[signal], text)
        if match:
            spans[signal] = next((cue for cue in plan.cues.get(signal, []) if cue in text), match.group())
    if plan.self_location:
        short = re.search(r"\d+号楼", plan.self_location)
        aliases = [plan.self_location] + ([short.group()] if short else [])
        for alias in aliases:
            if alias in text:
                spans["self_location"] = alias
                break
    if plan.direction:
        match = re.search(r"(?:往|朝|向|偏)?" + re.escape(plan.direction) + r"(?:侧|边|方|面|看|望)", text)
        if match:
            spans["direction"] = match.group()
    if plan.landmark and plan.landmark in text:
        spans["landmark"] = plan.landmark
    if plan.change:
        match = re.search(CHANGE_PATTERN, text)
        if match:
            spans["change"] = plan.change if plan.change in text else match.group()
    if (plan.corroboration and plan.corroboration["speaker"] in text
            and plan.corroboration["signal"] in spans):
        spans["corroboration"] = plan.corroboration["speaker"]
    return spans


# 综合感知、居民风格、历史变化和邻居消息抽样表达，决定居民这次发言要说哪些观察线索、采用什么表达方式；视觉方位组先按 60% 概率选择。
def choose_expression(resident: Resident, observation: FireObservation, building_name: str,
                      fire_id: str | None, minute: int, history: list[ChatMessage],
                      previous: list[ObservationRecord], rng: random.Random) -> ExpressionPlan:
    available = observation.signals
    published = {s for m in history[-12:] if m.resident_id == resident.id and m.fire_id == fire_id for s in m.evidence_signals}
    size = rng.choices(range(1, len(available) + 1), weights=[.65, .25, .10][:len(available)], k=1)[0]
    selected = []
    for _ in range(size):
        pool = [s for s in available if s not in selected]
        selected.append(rng.choices(pool, weights=[1 if s in published else 2 for s in pool], k=1)[0])
    selected = [s for s in ("odor", "smoke", "flame") if s in selected]
    visual = bool({"smoke", "flame"}.intersection(selected))
    # 变化依据必须是同一居民先前真实抽样的观察；邻居转述不能替代本人前后对比。
    earlier = next((p for p in reversed(previous) if 0 < minute-p.minute <= 30
                    and p.observation.smoke_amount == "thin" and "smoke" in p.observation.signals), None)
    change = "上次烟量还比较小，这次看到的烟柱明显了" if earlier and "smoke" in selected and observation.smoke_amount == "dense" else None
    peers = [m for m in history if m.community_id == resident.community_id and m.resident_id != resident.id
             and m.fire_id == fire_id and m.evidence_source == "direct" and 0 <= minute-m.simulation_minute <= 15
             and set(selected).intersection(m.evidence_signals)]
    weights = {"phenomenon": 2.4, "self_location": 1.3, "boundary": 1.1, "reaction": 1.0}
    if visual and observation.direction:
        weights.update(direction=1.5, complete=.7)
    if change:
        weights["change"] = 1.8
    if peers:
        weights["corroboration"] = 1.5
    favored = {"casual": "phenomenon", "detailed": "direction", "cautious": "boundary", "practical": "reaction"}[resident.observation_style]
    if favored in weights:
        weights[favored] *= 1.6
    own_ids = {m.id for m in history if m.resident_id == resident.id and m.fire_id == fire_id}
    questions = [m.content for m in history[-12:] if m.community_id == resident.community_id
                 and m.resident_id != resident.id and m.fire_id == fire_id
                 and 0 <= minute-m.simulation_minute <= 15
                 and (m.reply_to_id in own_ids or "@" + resident.name in m.content)]
    # A neighbour's question changes disclosure preference, never perception permission.
    for text in questions:
        if re.search(r"你.{0,5}(?:在哪|哪里|哪儿|哪栋|位置)|你住", text):
            weights["self_location"] *= 2.5
        if re.search(r"方向|方位|哪边|哪一侧|哪处|哪一处|哪座|哪里冒", text):
            for key in ("direction", "complete"):
                if key in weights:
                    weights[key] *= 2.5
        if "change" in weights and re.search(r"变化|变浓|变大|之前|刚才|一直|断续", text):
            weights["change"] *= 2.5
    recent = [m.expression_kind for m in history[-6:] if m.intent == "observation"]
    for kind in weights:
        weights[kind] *= .4 ** recent.count(kind)
    # Select the disclosure group first, so personality/history cannot dilute the 60% share.
    spatial = visual and bool(observation.direction) and rng.random() < SPATIAL_DISCLOSURE_PROBABILITY
    weights = {kind: weight for kind, weight in weights.items()
               if (kind in ("direction", "complete")) == spatial}
    kind = rng.choices(list(weights), weights=list(weights.values()), k=1)[0]
    plan = ExpressionPlan(kind=kind, signals=selected, cues={s: observation.cues[s] for s in selected})
    if kind in ("self_location", "direction", "complete"):
        plan.self_location = building_name
    if kind in ("direction", "complete"):
        plan.direction = observation.direction
    plan.uncertainty = kind in ("boundary", "complete")
    plan.verification_request = kind == "complete"
    plan.personal_reaction = kind == "reaction"
    if kind == "change":
        plan.change = change
    if kind == "corroboration":
        peer = rng.choice(peers)
        common = rng.choice([s for s in selected if s in peer.evidence_signals])
        plan.corroboration = {"message_id": peer.id, "speaker": peer.resident_name, "signal": common}
    # Optional independent elements keep the combinations from becoming eight fixed scripts.
    if kind in ("change", "corroboration", "reaction") and rng.random() < .25:
        plan.self_location = building_name
    return plan


# 保留的严格 claims 校验；当前 ResidentAgent.speak 不调用，不能据此声称线上正文已验证。
def validate_observation(result: ObservationUtterance, plan: ExpressionPlan) -> dict[str, str]:
    """Legacy structured-output checker; not used by resident generation."""
    text = result.content
    quotes = {}
    allowed = set(plan.signals) | {key for key in ("self_location", "direction", "landmark", "change", "corroboration") if getattr(plan, key)}
    for item in result.claims:
        if item.kind in quotes or item.kind not in allowed or item.quote not in text:
            raise ValueError(f"证据项 {item.kind} 未获计划许可、重复，或 quote 没有逐字出现在正文中。")
        if item.kind in SIGNAL_PATTERNS and not re.search(SIGNAL_PATTERNS[item.kind], item.quote):
            raise ValueError(f"证据项 {item.kind} 的 quote 没有体现对应的感官线索。")
        aliases = []
        if item.kind in ("self_location", "direction", "landmark"):
            aliases = [getattr(plan, item.kind)]
            short = re.search(r"\d+号楼", plan.self_location or "") if item.kind == "self_location" else None
            if short:
                aliases.append(short.group())
            if not any(alias in item.quote for alias in aliases):
                raise ValueError(f"位置证据 {item.kind} 的 quote 必须包含计划给出的地名、楼号或方位。")
        if item.kind == "direction" and not re.search(re.escape(plan.direction) + r"(?:侧|边|方|面|看|望)", item.quote):
            raise ValueError("direction 的 quote 必须是完整方位短语，例如‘往东北看’，不能只截取地名中的方位字。")
        if item.kind in ("self_location", "landmark"):
            extra = item.quote
            for alias in sorted(aliases, key=len, reverse=True):
                extra = extra.replace(alias, "")
            if item.kind == "self_location":
                extra = re.sub(r"窗[边外口]", "", extra)
            if re.search(SPATIAL_PATTERN, extra):
                raise ValueError("位置 quote 中包含计划未授权的额外位置，请删除未授权地点。")
        if item.kind == "self_location":
            # A reporter's address is not a license to locate the incident there.
            address = "(?:" + "|".join(re.escape(alias) for alias in aliases) + ")"
            if (re.search(address + r"(?:的)?(?:附近|旁边|那边|这里|这边|处)?(?:有|在|正|已经|正在)*[起着]火", text)
                    or re.search(r"(?:起火点|着火点|火源)(?:就在|在|是)" + address, text)):
                raise ValueError("本人住址不是起火地点，不能把 self_location 写成起火点。")
        if item.kind == "change" and (not re.search(r"变浓|更浓|明显了|更明显|(?:烟|烟柱).{0,12}(?:粗|多|大)|浓了", item.quote)
                                      or re.search(r"变淡|变小|变少|消失|减弱|减少", item.quote)):
            raise ValueError("前后变化必须保持计划给出的本人观察趋势，不能反转为变淡、消失或减弱。")
        quotes[item.kind] = item.quote
    detected = {s for s, pattern in SIGNAL_PATTERNS.items() if re.search(pattern, text)}
    if not detected or detected != set(plan.signals).intersection(quotes) or not detected <= set(plan.signals):
        raise ValueError(f"正文感官线索 {sorted(detected)} 与已登记证据不符；只能使用 {plan.signals}，至少报告一种，正文提到的每种都须登记对应 quote。")
    if re.search(r"(?:没有|没|并未|暂未|看不到|看不见)[^，。！？；\n]{0,8}(?:烟|火光|明火|气味|焦味|味道)", text):
        raise ValueError("没有获得某种感官线索不等于现场不存在它，请删除‘没有烟/火光/气味’等缺失断言。")
    # Claimed spatial spans are the only places where concrete location is permitted.
    remainder = text
    spatial = [quotes[kind] for kind in ("self_location", "direction", "landmark") if kind in quotes]
    for quote in sorted(spatial, key=len, reverse=True):
        remainder = remainder.replace(quote, "", 1)
    remainder = re.sub(r"往看|我在[，。]|那边", "", remainder)
    if re.search(SPATIAL_PATTERN, remainder):
        raise ValueError("正文含未授权位置或位置未登记 quote；未授权的删掉，已获许可的位置用完整原文登记。")
    if re.search(CHANGE_PATTERN, text) and not (plan.change and "change" in quotes):
        raise ValueError("没有获得 change 权限，不能声称刚才、之前、一直或前后变化。")
    if not plan.verification_request and re.search(REQUEST_PATTERN, text):
        raise ValueError("本轮 verification_request 为假，请删除核实请求或对其他居民的提醒。")
    if not plan.personal_reaction and re.search(REACTION_PATTERN, text):
        raise ValueError("本轮 personal_reaction 为假，请删除个人应对打算或动作。")
    if re.search(r"(?:已经|刚刚|已).{0,5}(?:报警|关窗|撤离)|爆炸|伤亡|消防.*(?:到|来)|(?:风向|封路)", text):
        raise ValueError("不能编造爆炸、伤亡、消防到场、风向、封路或已经执行的应急行动。")
    if plan.corroboration:
        if ("corroboration" not in quotes or plan.corroboration["speaker"] not in text
                or plan.corroboration["signal"] not in quotes):
            raise ValueError("交叉观察必须注明计划中的居民姓名，登记 corroboration，并公开双方共有的感官线索。")
    elif re.search(r"你(?:说|提)|群里|听说|有人说", text):
        raise ValueError("本轮未分配 corroboration，不能自行转述其他居民或群内消息。")
    required = {k for k in ("self_location", "direction", "landmark", "change", "corroboration") if getattr(plan, k)}
    if not required <= quotes.keys():
        raise ValueError(f"计划要求的证据项 {sorted(required - quotes.keys())} 被省略；正文与 claims 都须包含这些已授权证据。")
    return quotes
