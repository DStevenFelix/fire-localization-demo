"""Deterministic model doubles for tests only; never imported by the application."""

import json

from langchain_core.runnables import RunnableLambda

from app.dialogue import DAILY_TOPICS
from app.expression import EvidenceClaim, ObservationUtterance


def observation_fixture(plan, rng):
    claims = []
    def claim(kind, text):
        claims.append(EvidenceClaim(kind=kind, quote=text))
        return text

    cues = [claim(s, rng.choice(plan.cues[s])) for s in ("smoke", "flame") if s in plan.signals]
    if "odor" in plan.signals:
        cues.append(claim("odor", "闻到" + rng.choice(plan.cues["odor"])))
    prefix = "我在" + claim("self_location", plan.self_location) + "，" if plan.self_location else ""
    if plan.direction:
        prefix += claim("direction", "往" + plan.direction + "看") + "，"
    if plan.landmark:
        prefix += claim("landmark", plan.landmark) + "那边"
    content = prefix + "，".join(cues) + "。"
    if plan.change:
        content += claim("change", plan.change) + "。"
    if plan.corroboration:
        noun = {"odor": "气味", "smoke": "烟", "flame": "火光"}[plan.corroboration["signal"]]
        text = "你提到的" + noun + "，我这边也察觉到了"
        content = "@" + plan.corroboration["speaker"] + " " + content + claim("corroboration", text) + "。"
    if plan.uncertainty:
        content += "具体是哪一处还看不清。" if set(plan.signals).intersection(("smoke", "flame")) else "来源还说不清。"
    if plan.verification_request:
        content += rng.choice(["有邻居能再确认一下吗？", "有人方便核实一下吗？"])
    if plan.personal_reaction:
        content += rng.choice(["我先把窗关上。", "我准备先把窗关好。"])
    return ObservationUtterance(content=content, claims=claims)


def model_fixture(agent):
    agent.uses_llm = True

    def generate(values):
        if values["intent"] == "observation":
            return observation_fixture(values["plan"], agent.random).content
        target = values["reply_to"]
        if target:
            if target.topic != "daily":
                answers = ["你是在哪里闻到的？先别急着确定具体起点。", "你说的异常持续多久了？我还没核实现场。"]
                return "@" + target.resident_name + " " + agent.random.choice(answers)
            seeds = DAILY_TOPICS.get(target.topic_key, DAILY_TOPICS["neighbors"])
            index = next((i for i, text in enumerate(seeds[2]) if text.format(road=values["road"]) == target.content), None)
            answer = seeds[3][index] if index is not None else agent.random.choice(seeds[3])
            return "@" + target.resident_name + " " + answer
        starters = DAILY_TOPICS[values["topic_key"]][2]
        if values["topic_key"] == "sleep" and "轮班" not in agent.resident.daily_routine:
            starters = starters[:1]
        return agent.random.choice(starters).format(road=values["road"])

    def avoid_repetition(values):
        answer = generate(values)
        if values["intent"] != "observation":
            own = {message["content"] for message in json.loads(values["own_history"])}
            while answer in own:
                answer = "嗯，" + answer
        return answer

    return RunnableLambda(avoid_repetition)


def monitor_fixture(agent):
    def generate(values):
        messages = json.loads(values["new_messages"])
        speakers = json.loads(values["speakers"])
        relevant = [m for m in messages if m["public_source"] != "none"]
        if not relevant:
            return '{"events": []}'
        direct = [m for m in relevant if m["public_source"] == "direct"]
        buildings = {speakers[m["speaker_id"]]["reporter_building"] for m in direct
                     if set(m.get("public_signals", [])) & {"smoke", "flame"}}
        urgent = any("flame" in m.get("public_signals", []) for m in direct) or len(buildings) >= 2
        return json.dumps({"events": [{"title": "模拟模型：疑似火情", "summary": "模拟模型根据公开聊天提出核实建议。",
            "severity": "紧急" if urgent else "警告", "reasoning": "模拟模型仅引用输入中的公开观察和转述。",
            "evidence": [{"message_id": m["id"], "quote": m["content"]} for m in relevant],
            "keywords": [], "location_hint": "位置尚不明确", "uncertainties": ["具体起点尚待核实"]}]}, ensure_ascii=False)
    return RunnableLambda(generate)
