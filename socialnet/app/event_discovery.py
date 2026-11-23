"""公开群聊的本地危情召回基线：七类规则、分句降噪及15分钟统计，不调用模型。

规则用于保留待核实线索，不证明事件发生；窗口中的作者/社区数是发帖统计，不是独立证人数。
本模块只提取 PublicPost 中的公开字段，禁止用仿真话题、证据标签或真实火源作为筛选答案。
"""

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
import hashlib
import re

from .models import (ChatMessage, DiscoveryReason, DiscoveryRecord, DiscoveryState,
                     DiscoveryWindowStat)

RULE_VERSION = "local-rules-v1"
CATEGORY_LABELS = {"fire": "火灾", "gas": "燃气", "traffic": "交通", "flood": "积水",
                   "facility": "建筑及公共设施", "security": "治安", "rescue": "人员求助"}
MONITOR_CATEGORIES = frozenset(("fire", "gas"))


@dataclass(frozen=True)
class PublicPost:
    id: str
    sequence: int
    timestamp: datetime
    minute: int
    author_id: str
    author_name: str
    community_id: str
    content: str
    reply_to_id: str | None = None
    reply_quote: str = ""

    @classmethod
    def from_message(cls, message: ChatMessage):
        return cls(message.id, message.sequence, message.timestamp, message.simulation_minute,
                   message.resident_id, message.resident_name, message.community_id, message.content,
                   message.reply_to_id, message.reply_quote)


# 只编译静态规则。模式使用有限邻接长度，避免把任意用户正文当成正则执行。
RULES = tuple((category, name, re.compile(pattern)) for category, name, pattern in [
    ("fire", "火焰或烟雾", r"起火|着火|失火|火灾|火光|明火|火焰|火苗|火势|火情|浓烟|黑烟|灰烟|烟柱|冒烟|烟雾|连续的?烟|有烟|烟往|烟断续"),
    ("fire", "异常燃烧气味", r"烟味|焦味|烧焦味|糊味|烧焦的味|刺鼻.{0,6}(?:味|气)"),
    ("fire", "爆燃线索", r"爆炸|爆燃|燃烧"),
    ("fire", "消防通道受阻", r"(?:消防|疏散)通道.{0,8}(?:堵|占|挡)"),
    ("gas", "燃气异常", r"(?:燃气|煤气|天然气|液化气).{0,10}(?:味|泄漏|漏|喷|浓|异常|刺鼻)|(?:闻到|闻着|一股|有).{0,8}(?:燃气|煤气|天然气)|(?:管道|阀门).{0,6}漏气"),
    ("traffic", "车辆事故", r"车祸|交通事故|撞车|追尾|侧翻|翻车|(?:车|公交|卡车|货车|电瓶车|电动车|行人|人).{0,5}(?:撞到|撞上|撞了|撞伤|被撞|相撞|碾压|逆行)|被车撞"),
    ("traffic", "交通信号异常", r"(?:红绿灯|信号灯).{0,5}(?:坏|失灵|不亮)"),
    ("flood", "积水或洪涝", r"内涝|洪水|倒灌|积水|淹了|淹没|淹到|水.{0,4}(?:漫到|漫过|上涨|涨进)"),
    ("facility", "结构险情", r"坍塌|塌方|塌陷|垮塌|(?:楼|墙|房|桥|天花板|屋顶).{0,5}(?:开裂|裂缝|倾斜|倒塌|掉落)|高空抛物|掉(?:下)?(?:玻璃|砖|瓦)"),
    ("facility", "公共设施异常", r"(?:井盖|护栏|电线|电缆|电梯|路灯|桥梁|天桥).{0,8}(?:丢|不见|缺|掉|断|漏电|冒火|被困|困住|故障|坏|失灵)|(?:没有|没了|缺了)井盖|井盖没了|漏电|触电|停电|停水|断水|断电|(?:消防|疏散)通道.{0,8}(?:堵|占|挡)|(?:红绿灯|信号灯).{0,5}(?:坏|失灵|不亮)"),
    ("security", "人身或财产险情", r"打架|斗殴|持刀|砍人|抢劫|抢包|入室盗窃|盗窃|偷(?:车|东西|手机)|有人.{0,5}(?:尾随|撬门|砸门)|(?:被|遭).{0,5}袭击|骚乱|踩踏"),
    ("rescue", "紧急人员求助", r"救命|急救|救护车|昏倒|晕倒|昏迷|溺水|失联|被困|困在|困住|受伤|流血|呼吸困难|喘不上气|心脏骤停|找不到孩子|孩子.{0,6}(?:走丢|不见)|老人.{0,5}(?:走失|不见|摔倒)"),
])
NONCURRENT = re.compile(r"电影|电视剧|小说|影视|剧情|剧里|游戏|课本|教材|假如|假设|如果|万一|演练|演习|模拟|去年|上周|昨天|昨晚|前几天|以前|曾经|历史上|(?:如何|怎么|怎样)(?:预防|避免|处理)|安全知识|安全科普|消防培训|安全培训|安全教育")
CURRENT = re.compile(r"现在|刚刚|刚才|眼前|这会|突然|真的|实际|正在")
UNCERTAIN = re.compile(r"不确定|不能确定|尚未确定|还没确定|没有确定|未确认|没确认|未核实|没核实|尚未证实|不排除|不知道|说不准|好像|似乎|疑似|可能|是不是|是否|有没有|不知")
HEARSAY = re.compile(r"听说|据说|转发|转述|有人说|(?:邻居|朋友|同事|家人|物业)(?:说|反映|提到)|听.{0,5}说|群里说|听邻居|你说|你提到|未经证实")
NEGATION = re.compile(r"(?:没有|没|未|并无|并非|不是|不存在)(?:再|能|见到|看到|发现|闻到|发生|看见|见)?[^，。]{0,4}$")
PREVENTION = re.compile(r"(?:严禁|禁止|防止|避免|预防|杜绝|以防).{0,6}$")
COOKING = re.compile(r"炒菜|做饭|煎|煮|烤|锅|油烟机|香薰|蚊香")
ESCALATION = re.compile(r"楼道|楼梯|窗外|街上|罐|浓烟|黑烟|火光|明火|火焰|火势|失控|救命|起火|着火|失火|爆炸|爆燃|电线")
METAPHOR = re.compile(r"笑死|好笑|笑得|累死|饿死|帅炸|气炸|代码|考试|做题|加班|手忙脚乱|厨艺翻车|做饭翻车|直播翻车")
FIRE_METAPHOR = re.compile(r"燃烧(?:卡路里|青春|激情|热情|预算)|心在燃烧")
REPLY_CUE = re.compile(r"持续多久|(?:在|是|具体|到底)?哪(?:里|儿|边)|还在|还没散|又冒|也(?:看|闻|听|有)|(?:那边|那里|这个).{0,6}(?:情况|异常|还|现在)|现在.{0,5}(?:怎样|情况|怎么样)")
REPLY_DENIAL = re.compile(r"没有异常|已经没|现在没|没有了|没了|不再|已停止|已恢复|不是|并非")
SPLIT = re.compile(r"([，,。！？!?；;\n]+|但是|不过|可是|然而|但|而是|却)")


def _negated(clause, start):
    prefix = UNCERTAIN.sub("", clause[:start])
    # “没看到明火，有浓烟”分别处理；不确定/是不是不当作否认。
    if re.search(r"(?:没有|没|未)(?:明火|烟味|火光|火焰)(?:又|还)?(?:有|闻到|看见)$", prefix):
        return False
    return bool(NEGATION.search(prefix) or PREVENTION.search(prefix))


def _internal_denial(matched):
    # 资产/燃料在模式开头时，否定可能位于匹配内部，如“燃气没有泄漏”。
    # “没有井盖/井盖不见了/信号灯不亮”描述的是缺失或失效，本身仍是险情。
    return bool(re.search(r"(?:没有|并无|未|没|并非|不是|不存在|不)(?:发生|出现|发现|检测到|闻到)?(?:任何|明显|一点|什么)?(?:泄漏|漏气|漏电|故障|损坏|坏|失灵|积水|倒塌|被困|异味|气味|味)", matched))


def classify_text(text):
    """返回原文可回查的类别/依据和语境标记；不读取任何仿真对象。"""
    found = {}
    flags = []
    if UNCERTAIN.search(text):
        flags.append("uncertain")
    if HEARSAY.search(text):
        flags.append("hearsay")
    background = False
    for clause in SPLIT.split(text):
        if SPLIT.fullmatch(clause):
            if re.search(r"[。！？!?；;\n]|但是|不过|可是|然而|但|而是|却", clause):
                background = False
            continue
        if not clause.strip():
            continue
        if NONCURRENT.search(clause):
            background = True
            continue
        if background and not CURRENT.search(clause):
            continue
        background = False
        for category, rule, pattern in RULES:
            if category in found:
                continue
            for match in pattern.finditer(clause):
                if _negated(clause, match.start()) or _internal_denial(match.group()):
                    continue
                if category == "fire" and COOKING.search(clause) and not ESCALATION.search(clause):
                    continue
                if category == "fire" and FIRE_METAPHOR.search(clause) and not ESCALATION.search(clause):
                    continue
                if category in ("rescue", "traffic") and METAPHOR.search(clause) and not re.search(r"受伤|流血|昏迷|撞伤|救护车|浓烟|起火|被困|持刀", clause):
                    continue
                excerpt = clause[max(0, match.start()-30):match.end()+50].strip()
                found[category] = (rule, excerpt)
                break
    return found, flags


def classify_post(post: PublicPost, parent: PublicPost | None = None):
    found, flags = classify_text(post.content)
    reasons = [DiscoveryReason(category=category, rule=rule, excerpt=excerpt, source_message_id=post.id)
               for category, (rule, excerpt) in found.items()]
    # 仅对有实际语义关联的省略回复补上下文；“收到/谢谢”不会因为父帖危险而成为候选。
    if not found and post.reply_to_id and REPLY_CUE.search(post.content) and not REPLY_DENIAL.search(post.content):
        parent_text = parent.content if parent and parent.community_id == post.community_id else post.reply_quote
        inherited, parent_flags = classify_text(parent_text)
        for category, (_, excerpt) in inherited.items():
            reasons.append(DiscoveryReason(category=category, rule="直接回复的危情上下文", excerpt=excerpt,
                                            source_message_id=post.reply_to_id))
        if inherited:
            found = inherited
            flags = list(dict.fromkeys([*flags, *parent_flags, "contextual_reply", "hearsay"]))
    return found, flags, reasons


def _fingerprint(text):
    normalized = re.sub(r"^(?:转发|听说|据说)[：:，,\s]*", "", text.strip())
    normalized = re.sub(r"[\W_]+", "", normalized).casefold()
    return hashlib.blake2b(normalized.encode(), digest_size=12).hexdigest()


class EventDiscovery:
    """可暂存、恢复的本地筛选状态；完整历史由宿主 SQLite 保存。"""

    def __init__(self, started_minute=0, started_sequence=0):
        self.state = DiscoveryState(rule_version=RULE_VERSION, started_minute=started_minute,
                                    started_sequence=started_sequence, last_processed_sequence=started_sequence)
        self._window = []

    def clone(self):
        # 规则常量不随克隆复制，仅复制有界展示状态与时间窗统计。
        return deepcopy(self)

    def scan(self, messages, history, minute, community_names):
        public_history = {m.id: PublicPost.from_message(m) for m in history}
        seen = set()
        records = []
        for message in sorted(messages, key=lambda m: m.sequence):
            post = PublicPost.from_message(message)
            if post.sequence <= self.state.last_processed_sequence or post.id in seen:
                continue
            seen.add(post.id)
            self.state.last_processed_sequence = post.sequence
            self.state.scanned_total += 1
            found, flags, reasons = classify_post(post, public_history.get(post.reply_to_id))
            public_history[post.id] = post
            if not found:
                continue
            categories = [category for category in CATEGORY_LABELS if category in found]
            record = DiscoveryRecord(message_id=post.id, sequence=post.sequence, timestamp=post.timestamp,
                                     simulation_minute=post.minute, resident_id=post.author_id,
                                     resident_name=post.author_name, community_id=post.community_id,
                                     community_name=community_names.get(post.community_id, post.community_id),
                                     content=post.content, categories=categories, reasons=reasons,
                                     flags=flags, rule_version=RULE_VERSION)
            records.append(record)
            self._window.append({"minute": post.minute, "author": post.author_id, "community": post.community_id,
                                 "categories": categories, "fingerprint": _fingerprint(post.content)})
        self.state.candidate_total += len(records)
        self.state.recent_candidates = (self.state.recent_candidates + records)[-50:]
        self._window = [row for row in self._window if minute-self.state.window_minutes < row["minute"] <= minute]
        stats = []
        for category in CATEGORY_LABELS:
            rows = [r for r in self._window if category in r["categories"]]
            stats.append(DiscoveryWindowStat(category=category, candidate_count=len(rows),
                         author_count=len({r["author"] for r in rows}), community_count=len({r["community"] for r in rows}),
                         duplicate_count=len(rows)-len({r["fingerprint"] for r in rows})))
        self.state.window_stats = stats
        return records

    def record_routing(self, count):
        self.state.forwarded_total += count
        if count == 0:
            self.state.skipped_monitor_steps += 1

    def snapshot(self):
        return self.state.model_copy(deep=True)

    def checkpoint(self):
        return {"state": self.state.model_dump(mode="json"), "window": deepcopy(self._window)}

    @classmethod
    def restore(cls, data, *, minute=0, sequence=0):
        if data is None:
            # 旧存档从当前进度启用，不把其历史误算成本轮新扫描消息。
            return cls(minute, sequence)
        instance = cls()
        instance.state = DiscoveryState.model_validate(data["state"])
        if instance.state.rule_version != RULE_VERSION:
            raise ValueError("事件发现规则版本不兼容")
        instance._window = deepcopy(data["window"])
        return instance


def monitor_context(candidates, history, batch, limit=32):
    """监测只补公开回复链；直接父消息优先，再补祖先，不带入无关相邻聊天。"""
    if limit <= 0:
        return []
    ids = {m.id for m in candidates}
    available = {m.id: m for m in [*history, *batch]}
    selected = {}
    for candidate in candidates:
        parent = available.get(candidate.reply_to_id)
        if parent and parent.community_id == candidate.community_id and parent.id not in ids:
            selected.setdefault(parent.id, parent)
            if len(selected) == limit:
                return sorted(selected.values(), key=lambda m: m.sequence)
    frontier = list(selected.values())
    visited = ids | set(selected)
    for message in frontier:
        parent = available.get(message.reply_to_id)
        if parent and parent.id not in visited and parent.community_id == message.community_id:
            selected[parent.id] = parent
            visited.add(parent.id)
            frontier.append(parent)
            if len(selected) == limit:
                break
    return sorted(selected.values(), key=lambda m: m.sequence)
